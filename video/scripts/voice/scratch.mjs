// Runs scratch.ps1 for every scene in src/data/narration.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const nar = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/narration.json"), "utf8"));
for (const sc of nar.scenes) {
  const text = sc.chunks.map((c) => c[0]).join(" ");
  const wav = path.join(ROOT, "public/audio/scratch", `${sc.id}.wav`);
  const json = path.join(ROOT, "src/data/narration", `scratch-${sc.id}.json`);
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts/voice/scratch.ps1"), sc.id, text, wav, json], { stdio: "inherit" });
  const j = JSON.parse(fs.readFileSync(json, "utf8").replace(/^\uFEFF/, ""));
  // the synthesizer counts its progress on a 16 kHz clock while writing 24 kHz audio: rescale to seconds of the file
  // (its progress events can arrive out of order: sort by time, then by position in the text)
  j.words = j.words.map((w) => ({ ...w, t: (w.t * 16000) / 24000 })).sort((a, b) => a.t - b.t || a.c - b.c);
  fs.writeFileSync(json, JSON.stringify(j));
  const last = j.words[j.words.length - 1];
  console.log(sc.id, j.words.length, "words, last word at", last?.t?.toFixed(2), "s");
}
