// Narration timing: the voice's own timestamps, per scene, for cues and captions. Works with the scratch voice
// (Windows speech, word starts) and the final voice (ElevenLabs character alignment).
import narration from "../data/narration.json";
import sCold from "../data/narration/scratch-cold.json";
import sSacks from "../data/narration/scratch-sacks.json";
import sTwins from "../data/narration/scratch-twins.json";
import sProof from "../data/narration/scratch-proof.json";
import sGolden from "../data/narration/scratch-golden.json";
import sHood from "../data/narration/scratch-hood.json";
import sPeak from "../data/narration/scratch-peak.json";
import { FINAL, FINAL_READY } from "./final";
import voice from "../data/voice.json";

/** The narration plays at this tempo (scripts/audio/tempo.mjs), so its timestamps shrink by the same factor. */
const TEMPO = (voice as { tempo?: number }).tempo ?? 1;

export type SceneId = "cold" | "sacks" | "twins" | "proof" | "golden" | "hood" | "peak";
export type Word = { w: string; start: number; end: number };
export type Align = { words: Word[]; duration: number; audio: string };

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, "");

type ScratchJson = { words: { t: number; w: string }[] };
const SCRATCH: Record<SceneId, ScratchJson> = { cold: sCold, sacks: sSacks, twins: sTwins, proof: sProof, golden: sGolden, hood: sHood, peak: sPeak } as unknown as Record<SceneId, ScratchJson>;

function fromScratch(id: SceneId): Align {
  const ws = [...SCRATCH[id].words].sort((a, b) => a.t - b.t);
  const words = ws.map((w, i) => ({ w: w.w, start: w.t, end: i + 1 < ws.length ? Math.max(w.t + 0.12, ws[i + 1].t - 0.04) : w.t + 0.55 }));
  return { words, duration: (words[words.length - 1]?.end ?? 0) + 0.2, audio: `audio/scratch/${id}.wav` };
}

type ElAlign = { alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
function fromEleven(id: SceneId, j: ElAlign): Align {
  const { characters: ch, character_start_times_seconds: st, character_end_times_seconds: en } = j.alignment;
  const words: Word[] = [];
  let cur: Word | null = null;
  ch.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { w: "", start: -1, end: -1 };
    cur.w += c;
    if (/[\p{L}\p{N}]/u.test(c)) {
      if (cur.start < 0) cur.start = st[i] / TEMPO;
      cur.end = en[i] / TEMPO;
    }
  });
  if (cur) words.push(cur);
  const ok = words.filter((w) => w.start >= 0);
  return { words: ok, duration: (en[en.length - 1] ?? 0) / TEMPO, audio: `audio/narration/${id}.wav` };
}

export function align(id: SceneId): Align {
  if (FINAL_READY && FINAL[id]) return fromEleven(id, FINAL[id] as ElAlign);
  return fromScratch(id);
}

/** Start and end (scene audio seconds) of each chunk of a scene's narration, matched word by word. */
export function chunkTimes(id: SceneId) {
  const a = align(id);
  const sc = narration.scenes.find((s) => s.id === id)!;
  let k = 0;
  return sc.chunks.map(([spoken, shown]) => {
    const toks = spoken.split(/\s+/).map(norm).filter(Boolean);
    let i0 = -1;
    let i1 = -1;
    for (const tk of toks) {
      // find the next word that matches this token (tolerant of punctuation and split hyphens)
      // look a few words ahead only, so one unmatched token can't drag the chunk forward
      let j = k;
      const lim = Math.min(a.words.length, k + 6);
      while (j < lim && norm(a.words[j].w) !== tk && !(norm(a.words[j].w).length > 2 && (norm(a.words[j].w).startsWith(tk) || tk.startsWith(norm(a.words[j].w))))) j++;
      if (j >= lim) continue;
      if (i0 < 0) i0 = j;
      i1 = j;
      k = j + 1;
    }
    const start = i0 >= 0 ? a.words[i0].start : 0;
    const end = i1 >= 0 ? a.words[i1].end : start + 1;
    return { spoken, shown, start, end };
  });
}

/** Time (scene audio seconds) of a word, the nth time it occurs. */
export function wordAt(id: SceneId, word: string, nth = 0): number {
  const a = align(id);
  const tk = norm(word);
  // exact matches first ("eight" must not find "eighty-nine"); a prefix match only when there is no exact one
  const exact = a.words.filter((w) => norm(w.w) === tk);
  const list = exact.length ? exact : a.words.filter((w) => norm(w.w).startsWith(tk));
  return list[nth]?.start ?? list[list.length - 1]?.start ?? 0;
}
