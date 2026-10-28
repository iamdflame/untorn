// Minimal SAM 3.1 call: POST /v1/responses with streaming, yielding frames as they complete.
// Server-only (it needs MODEL_API_KEY). Retry, timeout and error mapping policy belong to the route.

import { readOutputTextDeltas, SamTextAccumulator, UpstreamError, type ParsedFrame } from "./parse";
import type { SamRequestBody } from "./request";

export const META_API_BASE = "https://api.meta.ai/v1";

export type SamCallOptions = {
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** Open the stream; throws UpstreamError (with the HTTP status) before the first byte on a non-2xx answer. */
export async function openSamStream(body: SamRequestBody, opts: SamCallOptions): Promise<ReadableStream<Uint8Array>> {
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? META_API_BASE}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    let code: string | null = null;
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string | null } };
      if (j.error?.message) message = j.error.message;
      code = j.error?.code ?? null;
    } catch {
      // empty or non-JSON error body (a 404 has none)
    }
    throw new UpstreamError(message, res.status, code);
  }
  return res.body;
}

/** Yield SAM frames from an open event stream as each completes (the last one when the stream ends). */
export async function* samFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedFrame> {
  const acc = new SamTextAccumulator();
  for await (const delta of readOutputTextDeltas(stream)) yield* acc.push(delta);
  yield* acc.end();
}
