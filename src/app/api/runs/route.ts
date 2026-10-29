// POST /api/runs: the live pipeline. Body: multipart `photo` (JPEG, PNG or HEIC; ≤ 15 MB), or JSON { photoId } (a
// phone capture) or { sample } (the first screen's photo). Streams NDJSON RunEvents (src/lib/run/types.ts).
// Rejections before the stream starts are JSON { error } with a 4xx/5xx status.

import { ERRORS, errorBody, RunError } from "@/lib/run/errors";
import { clientIp } from "@/lib/server/limits";
import { readRunRequest, startRun } from "@/lib/server/runs";
import { getStore } from "@/lib/server/store";

export const maxDuration = 300;

export async function POST(request: Request) {
  const store = getStore();
  try {
    const input = await readRunRequest(request, store);
    return await startRun(input, { store, ip: clientIp(request), signal: request.signal });
  } catch (e) {
    if (e instanceof RunError) return Response.json(errorBody(e.code, e.message), { status: ERRORS[e.code].status });
    console.error("[runs] could not start", e);
    return Response.json(errorBody("internal"), { status: 500 });
  }
}
