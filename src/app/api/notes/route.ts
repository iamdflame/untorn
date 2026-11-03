// POST /api/notes: a spoken provenance note for an archive record. Body: multipart `audio`, a mono 16-bit WAV at 16
// or 24 kHz, at most a minute (the browser converts its recording). Returns { text, audioMs, ms, costUsd, model };
// rejections are JSON { error } with a 4xx/5xx status. The audio is transcribed by Muse Voice Transcribe and not kept.

import { ERRORS, errorBody, RunError } from "@/lib/run/errors";
import { clientIp } from "@/lib/server/limits";
import { getStore } from "@/lib/server/store";
import { noteFromRequest } from "@/lib/server/voice";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const note = await noteFromRequest(request, { store: getStore(), ip: clientIp(request) });
    return Response.json(note, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof RunError) return Response.json(errorBody(e.code, e.message), { status: ERRORS[e.code].status });
    console.error("[notes] failed", e);
    return Response.json(errorBody("internal"), { status: 500 });
  }
}
