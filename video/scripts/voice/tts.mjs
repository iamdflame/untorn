// One narration request: POST /v1/text-to-speech/{voice}/with-timestamps on eleven_v4, the audio saved as MP3 and the
// character alignment as JSON. Every request is appended to the ledger with its billed character count.
//   node scripts/voice/tts.mjs <id> "<text>" [--stability 0.5] [--similarity 0.75] [--speed 1] [--prev "..."] [--next "..."]
import fs from "node:fs";
import path from "node:path";
import { elevenKey, headers } from "./env.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
// The narrator is chosen by evidence (scripts/voice/*, S4-VIDEO.md); it is never a cloned voice of the user.
export const MODEL = "eleven_v4";
const AUDIO = path.join(ROOT, "public", "audio", "narration");
const ALIGN = path.join(ROOT, "src", "data", "narration");
/** Every ElevenLabs request this project makes, with its billed characters. */
export const LEDGER = path.join(ROOT, "src", "data", "elevenlabs-ledger.json");

export async function tts({ id, text, voice, settings = {}, prev, next, format = "mp3_44100_192", audioDir = AUDIO, alignDir = ALIGN, purpose = "narration" }) {
  const VOICE = voice;
  if (!VOICE) throw new Error("voice id required");
  if (VOICE === "eiLz8n3rMt6c6BESEP43") throw new Error("refused: that is the user's own cloned voice");
  const used = async () => (await (await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: headers(elevenKey()) })).json()).character_count;
  const before = await used().catch(() => null);
  const key = elevenKey();
  const body = { text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0, ...settings } };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;
  let fmt = format;
  let res;
  for (;;) {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=${fmt}`, {
      method: "POST",
      headers: { ...headers(key), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    const err = await res.text();
    // a format the tier doesn't allow is refused before any characters are billed: step down once
    if (fmt === "mp3_44100_192" && /output_format|subscription|tier/i.test(err)) {
      fmt = "mp3_44100_128";
      continue;
    }
    throw new Error(`TTS ${res.status}: ${err.slice(0, 400)}`);
  }
  const cost = res.headers.get("x-character-count") ?? res.headers.get("character-cost");
  const reqId = res.headers.get("request-id") ?? res.headers.get("x-request-id");
  const j = await res.json();
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(alignDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, `${id}.mp3`), Buffer.from(j.audio_base64, "base64"));
  const alignment = { id, model: MODEL, voice: VOICE, settings: body.voice_settings, format: fmt, text, alignment: j.alignment, normalized_alignment: j.normalized_alignment };
  fs.writeFileSync(path.join(alignDir, `${id}.json`), JSON.stringify(alignment));
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : [];
  const after = await used().catch(() => null);
  const delta = before != null && after != null ? after - before : null;
  const billed = cost ? Number(cost) : text.length;
  const headerNames = [...res.headers.keys()].filter((h) => /char|cost|credit|usage/i.test(h));
  ledger.push({ at: new Date().toISOString(), purpose, id, model: MODEL, voice: VOICE, settings: body.voice_settings, format: fmt, chars: text.length, billed, header: cost ? Number(cost) : null, headerNames, accountUsedBefore: before, accountUsedAfter: after, accountDelta: delta, requestId: reqId ?? null });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  const total = ledger.reduce((n, e) => n + e.billed, 0);
  const ends = j.alignment?.character_end_times_seconds ?? [];
  return { id, chars: text.length, billed, total, seconds: ends.length ? ends[ends.length - 1] : null, format: fmt };
}

if (process.argv[1] && process.argv[1].endsWith("tts.mjs")) {
  const a = process.argv.slice(2);
  const opt = (n, d) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : d;
  };
  const [id, text] = a;
  if (!id || !text) {
    console.log('usage: node scripts/voice/tts.mjs <id> "<text>" --voice <voice_id> [--stability 0.5] [--similarity 0.75] [--speed 1]');
    process.exit(1);
  }
  const settings = { stability: Number(opt("stability", 0.5)), similarity_boost: Number(opt("similarity", 0.75)), speed: Number(opt("speed", 1)) };
  const r = await tts({ id, text, voice: opt("voice"), settings, prev: opt("prev"), next: opt("next") });
  console.log(JSON.stringify(r));
}
