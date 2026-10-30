// The final narration: one ElevenLabs request per scene (eleven_v4, the narrator in src/data/voice.json, the settings
// tuned on one line), with the neighbouring scenes' sentences as context for continuous prosody. Saves the audio and
// the character alignment; a changed scene re-generates alone.
//   node scripts/voice/narrate.mjs [scene ...]       (default: every scene without a file yet)
//   node scripts/voice/narrate.mjs --force proof     (a re-take of one scene)
import fs from "node:fs";
import path from "node:path";
import { tts } from "./tts.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const voice = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/voice.json"), "utf8"));
const nar = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/narration.json"), "utf8"));
const args = process.argv.slice(2);
const force = args.includes("--force");
const want = args.filter((a) => !a.startsWith("--"));
const textOf = (sc) => sc.chunks.map((c) => c[0]).join(" ");
const sentences = (s) => s.split(/(?<=[.!?:”])\s+/);
for (let i = 0; i < nar.scenes.length; i++) {
  const sc = nar.scenes[i];
  if (want.length && !want.includes(sc.id)) continue;
  const mp3 = path.join(ROOT, "public/audio/narration", `${sc.id}.mp3`);
  if (fs.existsSync(mp3) && !force) {
    console.log("exists", sc.id);
    continue;
  }
  const prev = i > 0 ? sentences(textOf(nar.scenes[i - 1])).slice(-1)[0] : undefined;
  const next = i + 1 < nar.scenes.length ? sentences(textOf(nar.scenes[i + 1]))[0] : undefined;
  const r = await tts({ id: sc.id, text: textOf(sc), voice: voice.NARRATOR, settings: voice.settings, prev, next, purpose: "narration" });
  console.log(JSON.stringify(r));
}
