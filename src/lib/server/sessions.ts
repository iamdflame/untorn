// The phone handoff: the laptop makes a short code and shows it as a QR code; the phone opens /c/<code>, takes one
// photo and posts it; the laptop polls the code and starts the run when the photo lands.

import type { CameraTilt } from "@/lib/run/tilt";
import { RunError } from "@/lib/run/errors";
import { normalisePhoto } from "./intake";
import { isSessionCode, randomId, sessionCode } from "./ids";
import { getJson, type Store } from "./store";

export const SESSION_TTL_MS = 20 * 60_000;

export type SessionState =
  | { code: string; status: "waiting"; expiresAt: string }
  | { code: string; status: "photo"; photoId: string; expiresAt: string }
  | { code: string; status: "expired" };

type SessionRecord = { code: string; createdAt: string };
type PhotoRecord = { photoId: string; at: string; width: number; height: number };

// The same instance often serves both phone and laptop: answer from memory first.
const memory = new Map<string, { createdAt: number; photoId?: string }>();

export async function createSession(store: Store): Promise<{ code: string; expiresAt: string }> {
  for (let i = 0; i < 4; i++) {
    const code = sessionCode();
    if (memory.has(code) || (await store.exists(`sessions/${code}.json`))) continue;
    const createdAt = Date.now();
    const rec: SessionRecord = { code, createdAt: new Date(createdAt).toISOString() };
    await store.put(`sessions/${code}.json`, JSON.stringify(rec), "application/json");
    memory.set(code, { createdAt });
    return { code, expiresAt: new Date(createdAt + SESSION_TTL_MS).toISOString() };
  }
  throw new RunError("busy");
}

async function load(store: Store, code: string): Promise<{ createdAt: number; photoId?: string } | null> {
  const m = memory.get(code);
  if (m?.photoId) return m;
  const rec = m ? { createdAt: m.createdAt } : await getJson<SessionRecord>(store, `sessions/${code}.json`).then((r) => (r ? { createdAt: Date.parse(r.createdAt) } : null));
  if (!rec) return null;
  const photo = (await store.exists(`sessions/${code}/photo.json`)) ? await getJson<PhotoRecord>(store, `sessions/${code}/photo.json`) : null;
  const out = { createdAt: rec.createdAt, photoId: photo?.photoId };
  memory.set(code, out);
  return out;
}

export async function getSession(store: Store, code: string): Promise<SessionState> {
  if (!isSessionCode(code)) throw new RunError("not-found");
  const s = await load(store, code);
  if (!s) throw new RunError("not-found");
  const expires = s.createdAt + SESSION_TTL_MS;
  if (Date.now() > expires) return { code, status: "expired" };
  const expiresAt = new Date(expires).toISOString();
  return s.photoId ? { code, status: "photo", photoId: s.photoId, expiresAt } : { code, status: "waiting", expiresAt };
}

/** Check and store the phone's photo, and mark the session. Returns the photo id the laptop runs on. */
export async function attachPhoto(store: Store, code: string, bytes: Uint8Array, browserTilt: CameraTilt | null = null): Promise<{ photoId: string }> {
  const state = await getSession(store, code);
  if (state.status === "expired") throw new RunError("expired");
  const photo = await normalisePhoto(bytes);
  const photoId = randomId();
  await store.put(`photos/${photoId}`, photo.bytes, photo.kind === "png" ? "image/png" : "image/jpeg");
  // the camera's tilt (the photo's own EXIF first, else what the phone's browser read before re-encoding it)
  const tilt = photo.tilt ?? browserTilt;
  if (tilt) await store.put(`photos/${photoId}.tilt.json`, JSON.stringify(tilt), "application/json");
  const rec: PhotoRecord = { photoId, at: new Date().toISOString(), width: photo.width, height: photo.height };
  await store.put(`sessions/${code}/photo.json`, JSON.stringify(rec), "application/json");
  memory.set(code, { createdAt: memory.get(code)?.createdAt ?? Date.now(), photoId });
  return { photoId };
}

/** For tests. */
export function resetSessions() {
  memory.clear();
}
