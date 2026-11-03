// The spoken provenance note: an archivist says where a page was found (box, folder, place, date) and Muse Voice
// Transcribe writes it into the page's archive record. The audio is checked (a mono 16-bit WAV, at most a minute),
// transcribed once and never stored. Server-only: it reads MODEL_API_KEY.

import { RunError } from "@/lib/run/errors";
import type { SpokenNote } from "@/lib/run/types";
import { randomId } from "./ids";
import { admitNote, settleRun } from "./limits";
import { META_API_BASE, USER_AGENT } from "./muse";
import { isAccountRefusal } from "./refusal";
import type { Store } from "./store";

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
/** USD per hour of audio (Meta's price list, 2026-10). */
export const VOICE_USD_PER_HOUR = 0.18;
export const MAX_NOTE_MS = 62_000;
/** A minute of 24 kHz mono 16-bit audio, with room for the header. */
export const MAX_NOTE_BYTES = 3_000_000;

export type WavInfo = { sampleRate: number; channels: number; bits: number; ms: number };

/** Read a PCM WAV's header; null unless it is the mono 16-bit, 16 or 24 kHz audio the model takes. */
export function wavInfo(b: Uint8Array): WavInfo | null {
  if (b.length < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: Omit<WavInfo, "ms"> | null = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      if (v.getUint16(o + 8, true) !== 1) return null; // PCM only
      fmt = { channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === "data") {
      if (!fmt || fmt.channels !== 1 || fmt.bits !== 16 || (fmt.sampleRate !== 16000 && fmt.sampleRate !== 24000)) return null;
      const bytes = Math.min(size, b.length - o - 8);
      return { ...fmt, ms: Math.round((bytes / 2 / fmt.sampleRate) * 1000) };
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

export type NoteOut = SpokenNote;

/** One transcription call. Throws a RunError the route turns into a designed answer. */
export async function transcribeNote(wav: Uint8Array, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; apiKey?: string } = {}): Promise<NoteOut> {
  const info = wavInfo(wav);
  if (!info) throw new RunError("bad-type", "Send the note as a mono 16-bit WAV at 16 or 24 kHz.");
  if (info.ms > MAX_NOTE_MS) throw new RunError("too-large", "Keep the note to a minute.");
  if (info.ms < 300) throw new RunError("bad-type", "The note was empty. Hold the button and speak.");
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new RunError("model-error");
  const form = new FormData();
  form.set("request", new Blob([JSON.stringify({ mode: "PUSH_TO_TALK", model: VOICE_MODEL, audioEncoding: "WAV" })], { type: "application/json" }));
  form.set("audio", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "note.wav");
  const t0 = Date.now();
  const timer = AbortSignal.timeout(30_000);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${META_API_BASE}/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
      body: form,
      signal: opts.signal ? AbortSignal.any([opts.signal, timer]) : timer,
    });
  } catch {
    throw new RunError("model-error", "Muse Voice Transcribe didn't answer. Try the note again.");
  }
  const body = (await res.json().catch(() => null)) as { transcript?: unknown; audioDurationMs?: unknown; error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    if (isAccountRefusal(res.status, body?.error?.code, body?.error?.message)) throw new RunError("paused");
    throw new RunError("model-error", "Muse Voice Transcribe couldn't take the note just now. Try again.");
  }
  const text = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  if (!text) throw new RunError("unreadable", "No words were heard in the note. Speak a little closer and try again.");
  const audioMs = typeof body?.audioDurationMs === "number" ? body.audioDurationMs : info.ms;
  return { text, audioMs, ms: Date.now() - t0, costUsd: Math.round(((audioMs / 3_600_000) * VOICE_USD_PER_HOUR) * 1e6) / 1e6, model: VOICE_MODEL };
}

/** POST /api/notes after parsing: admit against the limits, transcribe, settle the spend. */
export async function noteFromRequest(req: Request, ctx: { store: Store; ip: string }): Promise<NoteOut> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_NOTE_BYTES + 64 * 1024) throw new RunError("too-large", "Keep the note to a minute.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new RunError("bad-type", "The note didn't arrive whole. Try again.");
  }
  const audio = form.get("audio");
  if (!audio || typeof audio === "string") throw new RunError("bad-type", "No audio in the note.");
  if (audio.size > MAX_NOTE_BYTES) throw new RunError("too-large", "Keep the note to a minute.");
  const wav = new Uint8Array(await audio.arrayBuffer());
  const { ipKey } = await admitNote(ctx.store, ctx.ip);
  const id = `note-${randomId()}`;
  let usd = 0;
  try {
    const out = await transcribeNote(wav, { signal: req.signal });
    usd = out.costUsd;
    return out;
  } finally {
    await settleRun(ctx.store, ipKey, id, usd).catch(() => {});
  }
}
