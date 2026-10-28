// Starting a live run: read the request (an upload, a stored phone photo, or a sample), admit it against the rate
// limit and spend cap, then stream the pipeline's events as NDJSON. Every failure becomes a designed error event.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ERRORS, RunError } from "@/lib/run/errors";
import { SAMPLES } from "@/lib/run/samples";
import { MAX_UPLOAD_BYTES, type RunEvent, type RunSource } from "@/lib/run/types";
import { isPhotoId, randomId } from "./ids";
import { normalisePhoto } from "./intake";
import { acquireSlot, admitRun, settleRun } from "./limits";
import { liveDeps } from "./live";
import { runPipeline, type PipelineDeps } from "./pipeline";
import { fileUrl, type Store } from "./store";

export type RunInput = { bytes: Uint8Array; source: RunSource; sample?: string; caption?: string };

export async function readSample(name: string): Promise<{ bytes: Uint8Array; caption: string }> {
  const s = SAMPLES[name];
  if (!s) throw new RunError("not-found");
  // statically scoped to data/samples so the build traces only that folder (s.file names the same path)
  const bytes = new Uint8Array(await readFile(path.join(process.cwd(), "data", "samples", s.name, "photo.jpg")));
  return { bytes, caption: s.caption };
}

/** Parse POST /api/runs: multipart with a `photo` file, or JSON { photoId } | { sample }. */
export async function readRunRequest(req: Request, store: Store): Promise<RunInput> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 256 * 1024) throw new RunError("too-large");
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new RunError("bad-type", "The upload didn't arrive whole. Try again.");
    }
    const file = form.get("photo");
    if (!file || typeof file === "string") throw new RunError("bad-type", "No photo in the upload.");
    if (file.size > MAX_UPLOAD_BYTES) throw new RunError("too-large");
    const photo = await normalisePhoto(new Uint8Array(await file.arrayBuffer()));
    return { bytes: photo.bytes, source: form.get("source") === "phone" ? "phone" : "upload" };
  }
  let body: { photoId?: unknown; sample?: unknown };
  try {
    body = await req.json();
  } catch {
    throw new RunError("bad-type", "Send a photo, a photo id or a sample name.");
  }
  if (typeof body.sample === "string") {
    const s = await readSample(body.sample);
    return { bytes: s.bytes, source: "sample", sample: body.sample, caption: s.caption };
  }
  if (typeof body.photoId === "string") {
    if (!isPhotoId(body.photoId)) throw new RunError("not-found");
    const f = await store.get(`photos/${body.photoId}`);
    if (!f) throw new RunError("not-found", "That photo has expired or was never sent. Take it again.");
    return { bytes: f.bytes, source: "phone" };
  }
  throw new RunError("bad-type", "Send a photo, a photo id or a sample name.");
}

export const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

/** Stream one run. Admission (rate limit, spend cap) has already happened; `ipKey` settles the ledger. */
export function streamRun(input: RunInput, ctx: { store: Store; ipKey: string; runId: string; signal?: AbortSignal; deps?: PipelineDeps }): Response {
  const { store, runId, ipKey } = ctx;
  const enc = new TextEncoder();
  const abort = new AbortController();
  ctx.signal?.addEventListener("abort", () => abort.abort(ctx.signal?.reason), { once: true });
  const t0 = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (e: RunEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      const tick = setInterval(() => write({ type: "tick", t: Date.now() - t0 }), 5000);
      const meter = { usd: 0 };
      let release: (() => void) | undefined;
      try {
        release = await acquireSlot((position) => write({ type: "queued", t: Date.now() - t0, position }), abort.signal);
        const putAsset = async (name: string, bytes: Uint8Array, contentType: string) => {
          const key = `runs/${runId}/${name}`;
          await store.put(key, bytes, contentType);
          return fileUrl(key);
        };
        const deps = ctx.deps ?? liveDeps(putAsset);
        await runPipeline(input.bytes, { ...deps, putAsset }, { runId, source: input.source, sample: input.sample, caption: input.caption, signal: abort.signal, meter }, write);
      } catch (e) {
        const known = e instanceof RunError;
        if (!known) console.error(`[runs] ${runId} failed`, e);
        write({ type: "error", t: Date.now() - t0, code: known ? e.code : "internal", message: known ? e.message : ERRORS.internal.message });
      } finally {
        clearInterval(tick);
        release?.();
        await settleRun(store, ipKey, runId, meter.usd).catch(() => {});
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      abort.abort(new Error("client went away"));
    },
  });
  return new Response(stream, { headers: { ...NDJSON_HEADERS, "X-Run-Id": runId } });
}

/** Admit and start: the whole of POST /api/runs after parsing. */
export async function startRun(input: RunInput, ctx: { store: Store; ip: string; signal?: AbortSignal; deps?: PipelineDeps }): Promise<Response> {
  const runId = randomId();
  const { ipKey } = await admitRun(ctx.store, ctx.ip, runId);
  return streamRun(input, { store: ctx.store, ipKey, runId, signal: ctx.signal, deps: ctx.deps });
}
