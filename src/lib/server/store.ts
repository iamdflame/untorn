// Where runs, photos, sessions and ledgers live: a private Vercel Blob store when BLOB_READ_WRITE_TOKEN is set,
// else a local folder (dev, tests, e2e). Nothing is public: the browser reads run files through /api/files.
//
// Keys (all deleted within 24 h by the cleanup cron, except health records and the ledger, kept 7 days):
//   runs/<runId>/photo.jpg | page-<k>.png | result.json      a run and its files
//   photos/<photoId>                                         an uploaded photo waiting for its run (phone handoff)
//   sessions/<code>.json, sessions/<code>/photo.json         phone handoff sessions
//   ledger/<day>/<ipHash>/<runId>_<micro-usd>.<s|d>           rate limit and spend cap (s: started, d: done)
//   health/<iso time>.json                                   health runs (every 12 hours)
//   live/paused.json                                         set when Meta's API refuses our key; lifted by the next run

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";

export type StoredFile = { bytes: Uint8Array; contentType: string };
export type ListedFile = { key: string; uploadedAt: Date; size: number };

export interface Store {
  kind: "blob" | "fs";
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<ListedFile[]>;
  del(keys: string[]): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/;
export function assertKey(key: string): string {
  if (!KEY.test(key) || key.includes("..") || key.includes("//")) throw new Error(`bad store key`);
  return key;
}

export const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
};

class BlobStore implements Store {
  kind = "blob" as const;
  async put(key: string, body: Uint8Array | string, contentType: string) {
    await put(assertKey(key), typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }
  async get(key: string): Promise<StoredFile | null> {
    try {
      const r = await get(assertKey(key), { access: "private", useCache: false });
      if (!r || r.statusCode !== 200) return null;
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      return { bytes, contentType: r.blob.contentType };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async exists(key: string) {
    try {
      await head(assertKey(key));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
  async list(prefix: string) {
    const out: ListedFile[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      for (const b of r.blobs) out.push({ key: b.pathname, uploadedAt: new Date(b.uploadedAt), size: b.size });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  async del(keys: string[]) {
    for (let i = 0; i < keys.length; i += 500) await del(keys.slice(i, i + 500));
  }
}

// class names are minified in production builds: check the class, then the message ("The requested blob does not exist")
export const isNotFound = (e: unknown) => e instanceof BlobNotFoundError || (e instanceof Error && /not.?found|does not exist/i.test(`${e.name} ${e.message}`));

class FsStore implements Store {
  kind = "fs" as const;
  constructor(private root: string) {}
  private file(key: string) {
    return path.join(this.root, ...assertKey(key).split("/"));
  }
  async put(key: string, body: Uint8Array | string) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
  }
  async get(key: string): Promise<StoredFile | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.file(key)));
      return { bytes, contentType: CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
  async exists(key: string) {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
  async list(prefix: string) {
    const out: ListedFile[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const k = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), k);
        else if (k.startsWith(prefix)) {
          const s = await stat(path.join(dir, e.name));
          out.push({ key: k, uploadedAt: s.mtime, size: s.size });
        }
      }
    };
    // walk only the deepest folder the prefix names
    const dirPart = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    await walk(dirPart ? path.join(this.root, ...dirPart.split("/")) : this.root, dirPart);
    return out;
  }
  async del(keys: string[]) {
    await Promise.all(keys.map((k) => rm(this.file(k), { force: true })));
  }
}

let cached: Store | null = null;

/** The app's store: Blob in deployments, a local folder otherwise (STORE_DIR, default .data/store). */
export function getStore(): Store {
  if (cached) return cached;
  if (process.env.BLOB_READ_WRITE_TOKEN) cached = new BlobStore();
  else cached = new FsStore(process.env.STORE_DIR ?? (process.env.VERCEL ? "/tmp/untorn-store" : path.join(process.cwd(), ".data", "store")));
  return cached;
}

/** For tests. */
export function setStore(s: Store | null) {
  cached = s;
}

export function memoryStore(): Store {
  const m = new Map<string, { bytes: Uint8Array; contentType: string; at: Date }>();
  return {
    kind: "fs",
    async put(key, body, contentType) {
      m.set(assertKey(key), { bytes: typeof body === "string" ? new TextEncoder().encode(body) : body, contentType, at: new Date() });
    },
    async get(key) {
      const v = m.get(key);
      return v ? { bytes: v.bytes, contentType: v.contentType } : null;
    },
    async exists(key) {
      return m.has(key);
    },
    async list(prefix) {
      return [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, uploadedAt: v.at, size: v.bytes.length }));
    },
    async del(keys) {
      for (const k of keys) m.delete(k);
    },
  };
}

/** The URL the browser loads a stored run file from. */
export const fileUrl = (key: string) => `/api/files/${key}`;

export async function getJson<T>(store: Store, key: string): Promise<T | null> {
  const f = await store.get(key);
  if (!f) return null;
  try {
    return JSON.parse(new TextDecoder().decode(f.bytes)) as T;
  } catch {
    return null;
  }
}
