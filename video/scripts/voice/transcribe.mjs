// Round-trip check with Meta's speech-to-text (Muse Voice Transcribe, file endpoint): mono 16-bit WAV at 24 kHz in,
// transcript and speech turns out. Billed per second of audio ($0.18 per hour); no characters. The key is never printed.
import fs from "node:fs";
import path from "node:path";

function metaKey() {
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY.trim().replace(/^["']|["']$/g, "");
  for (const f of ["C:/Users/Dflame/Pictures/rr/.env", path.resolve("../.env.local")]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^\s*MODEL_API_KEY\s*=\s*(.*)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("MODEL_API_KEY not found");
}

export async function transcribe(wavFile, { keywords } = {}) {
  const key = metaKey();
  const form = new FormData();
  const req = { mode: "ENDPOINTING", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" };
  if (keywords?.length) req.keywords = keywords;
  form.set("request", new Blob([JSON.stringify(req)], { type: "application/json" }));
  form.set("audio", new Blob([fs.readFileSync(wavFile)], { type: "audio/wav" }), path.basename(wavFile));
  const sid = `video-audition-${Date.now()}`;
  const res = await fetch(`https://api.meta.ai/v1/asr/transcribe?sessionId=${sid}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "video-build/1.0", Accept: "application/json" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ASR ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Word error rate (substitutions + deletions + insertions over reference words). */
export function wer(ref, hyp) {
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { wer: r.length ? d[r.length][h.length] / r.length : 0, refWords: r.length, hypWords: h.length };
}
