import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav } from "@/lib/client/wav";
import { admitNote, admitRun, settleRun, spendToday } from "./limits";
import { memoryStore } from "./store";
import { transcribeNote, VOICE_MODEL, wavInfo } from "./voice";

const tone = (seconds: number, rate = 16000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));

describe("wavInfo", () => {
  it("reads the browser's mono 16-bit WAV, and its length", () => {
    expect(wavInfo(encodeWav(tone(2.5)))).toEqual({ sampleRate: 16000, channels: 1, bits: 16, ms: 2500 });
    expect(wavInfo(encodeWav(tone(1, 24000), 24000))?.sampleRate).toBe(24000);
  });
  it("refuses what the model doesn't take", () => {
    const wav = encodeWav(tone(1));
    const stereo = wav.slice();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(wavInfo(stereo)).toBeNull();
    expect(wavInfo(encodeWav(tone(1, 44100), 44100))).toBeNull();
    expect(wavInfo(new TextEncoder().encode("ID3 not a wav at all, an mp3 header and then some padding....."))).toBeNull();
  });
});

describe("transcribeNote", () => {
  it("sends the WAV with the model's request and returns what it heard", async () => {
    let sent: { url: string; form: FormData; auth: string | null } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, form: init.body as FormData, auth: new Headers(init.headers).get("authorization") };
      return Response.json({ sessionId: "s", transcript: " Box 12, folder 3. ", audioDurationMs: 2500, turns: [] });
    }) as unknown as typeof fetch;
    const out = await transcribeNote(encodeWav(tone(2.5)), { fetchImpl, apiKey: "k" });
    expect(out).toMatchObject({ text: "Box 12, folder 3.", audioMs: 2500, model: VOICE_MODEL });
    expect(out.costUsd).toBeCloseTo((2.5 / 3600) * 0.18, 6);
    expect(sent!.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(sent!.auth).toBe("Bearer k");
    expect(JSON.parse(await (sent!.form.get("request") as Blob).text())).toEqual({ mode: "PUSH_TO_TALK", model: VOICE_MODEL, audioEncoding: "WAV" });
    expect((sent!.form.get("audio") as Blob).size).toBe(44 + 2.5 * 16000 * 2);
  });
  it("turns a refused key into the paused answer, silence into a plain one, and checks length first", async () => {
    const refused = (async () => Response.json({ error: { code: "insufficient_credits", message: "no credit" } }, { status: 402 })) as unknown as typeof fetch;
    await expect(transcribeNote(encodeWav(tone(1)), { fetchImpl: refused, apiKey: "k" })).rejects.toMatchObject({ code: "paused" });
    const silent = (async () => Response.json({ transcript: "", audioDurationMs: 1000 })) as unknown as typeof fetch;
    await expect(transcribeNote(encodeWav(tone(1)), { fetchImpl: silent, apiKey: "k" })).rejects.toMatchObject({ code: "unreadable" });
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(transcribeNote(encodeWav(tone(63)), { fetchImpl: never, apiKey: "k" })).rejects.toMatchObject({ code: "too-large" });
    await expect(transcribeNote(new Uint8Array(10), { fetchImpl: never, apiKey: "k" })).rejects.toMatchObject({ code: "bad-type" });
  });
});

describe("admitNote", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("counts a note's spend towards the day's cap but never towards a visitor's live runs", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "100");
    const store = memoryStore();
    for (let i = 0; i < 8; i++) {
      const { ipKey } = await admitNote(store, "203.0.113.20");
      await settleRun(store, ipKey, `note-${i}`, 0.003);
    }
    expect((await spendToday(store)).usd).toBeCloseTo(0.024, 6);
    await expect(admitRun(store, "203.0.113.20", "run-1")).resolves.toBeTruthy();
  });
  it("stops at the cap like a run", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "0.005");
    await expect(admitNote(memoryStore(), "203.0.113.21")).rejects.toMatchObject({ code: "daily-cap" });
  });
});
