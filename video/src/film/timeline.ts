// The film's timeline, computed from the narration's own timestamps: where each scene starts, where each chunk of
// narration plays (with the beats of silence the brief asks for), and every scene's cues.
import { chunkTimes, wordAt, type SceneId } from "./align";
import type { SacksCues } from "../scenes/Sacks";
import type { TwinsCues } from "../scenes/Twins";
import type { ProofCues } from "../scenes/Proof";
import type { GoldenCues } from "../scenes/Golden";
import type { HoodCues } from "../scenes/Hood";
import type { PeakCues } from "../scenes/Peak";

export type Clip = { scene: SceneId; from: number; to: number; at: number; shown: string };
export type Placed = { id: SceneId; start: number; dur: number };
export type Timeline = {
  scenes: Placed[];
  clips: Clip[];
  total: number;
  cold: { warp: [number, number][] };
  sacks: SacksCues;
  twins: TwinsCues;
  proof: ProofCues;
  golden: GoldenCues;
  hood: HoodCues;
  peak: PeakCues;
};

export function buildTimeline(): Timeline {
  const clips: Clip[] = [];
  const scenes: Placed[] = [];
  /** Place a scene's chunks: `at` is the scene-local time of chunk 0's first word; `beats` add silence before chunks. */
  const place = (id: SceneId, sceneStart: number, lead: number, beats: Record<number, number> = {}) => {
    const ch = chunkTimes(id);
    let shift = 0;
    const local: { start: number; end: number }[] & { word?: (word: string, nth?: number) => number } = [];
    ch.forEach((c, i) => {
      shift += beats[i] ?? 0;
      // a tight edit: the voice's own pause between chunks is capped (0.5 s after a comma or colon, 0.7 s after a
      // full stop); the beats asked for above are added on top
      if (i > 0) {
        const gap = c.start - ch[i - 1].end;
        const cap = /[.!?”]$/.test(ch[i - 1].spoken.trim()) ? 0.7 : 0.5;
        if (gap > cap) shift -= gap - cap;
      }
      const at = sceneStart + lead + shift + c.start - ch[0].start;
      // play from a little before the chunk's first word to a little after its last
      clips.push({ scene: id, from: Math.max(0, c.start - 0.06), to: c.end + 0.12, at: at - 0.06, shown: c.shown });
      local.push({ start: lead + shift + c.start - ch[0].start, end: lead + shift + c.end - ch[0].start });
    });
    // scene-local time of a word, beats included
    local.word = (word: string, nth = 0) => {
      const tw = wordAt(id, word, nth);
      let k = 0;
      for (let i = 0; i < ch.length; i++) if (tw >= ch[i].start - 0.01) k = i;
      return local[k].start + (tw - ch[k].start);
    };
    return local as { start: number; end: number }[] & { word: (word: string, nth?: number) => number };
  };

  // 1 · cold open
  const cold = place("cold", 0, 0.7);
  const coldEnd = cold[2].end + 0.95;
  // the cold open's own beats (trace 3.75, lift 5.75, title 9.7, end 12.0) moved onto the narration
  const coldWarp: [number, number][] = [
    [0, 0],
    [cold[1].start - 0.15, 3.75],
    [cold[2].start + 0.1, 5.75],
    [cold[2].end - 0.35, 9.7],
    [coldEnd, 12.0],
    [coldEnd + 3, 15.0],
  ];
  scenes.push({ id: "cold", start: 0, dur: coldEnd + 1.0 });

  // 2 · the sacks (overlaps the cold open's pull-apart by 1 s)
  const sS = coldEnd - 0.2;
  const sacks = place("sacks", sS, 0.75, { 3: 0.95 });
  const sacksCues: SacksCues = {
    sixteen: sacks.word("sixteen") - 0.05,
    fifteen: sacks.word("fifteen") - 0.05,
    dim: sacks[2].end + 0.15,
    years: sacks.word("eight") - 0.05,
    end: sacks[4].end + 0.95,
  };
  scenes.push({ id: "sacks", start: sS, dur: sacksCues.end + 0.9 });

  // 3 · the twins (a tear-shaped wipe in)
  const tS = sS + sacksCues.end - 0.1;
  const twinsLocal = chunkTimes("twins");
  const lead3 = 0.7;
  // chunks 0-2 natural, then the tries, a beat, and the verdict line when C seats
  const t2end = lead3 + twinsLocal[2].end - twinsLocal[0].start;
  const tryA = t2end + 0.2;
  const tryB = tryA + 1.2;
  const tryC = tryB + 1.8;
  const verdictAt = tryC + 0.58;
  const beat4 = verdictAt - (lead3 + twinsLocal[3].start - twinsLocal[0].start);
  const twins = place("twins", tS, lead3, { 3: Math.max(0, beat4) });
  const twinsCues: TwinsCues = {
    fan: lead3 + 0.4,
    tie: twins[1].start - 0.1,
    reads: twins[2].start,
    tryA,
    tryB,
    tryC,
    verdict: verdictAt,
    end: twins[3].end + 1.15,
  };
  scenes.push({ id: "twins", start: tS, dur: twinsCues.end + 0.6 });

  // 4 · proof (a cut on the first word)
  const pS = tS + twinsCues.end;
  const proof = place("proof", pS, 0.45);
  const proofCues: ProofCues = {
    muse: proof[0].start - 0.2,
    untorn: proof[1].start - 0.1,
    scores: proof.word("five") - 1.6,
    tiles: proof.word("five") + 0.2,
    end: proof[1].end + 0.9,
  };
  scenes.push({ id: "proof", start: pS, dur: proofCues.end + 0.2 });

  // 5 · tear your own (a cut on the first word)
  const gS = pS + proofCues.end;
  const golden = place("golden", gS, 0.35, { 1: 1.25 });
  const gAssemble = golden[3].start - 0.1;
  const gClimax = gAssemble + 2.6;
  const gTranscript = Math.max(gClimax + 1.3, golden[4].start - 0.1);
  const goldenCues: GoldenCues = {
    phone: golden[0].start + 1.2,
    live: golden[1].start - 0.15,
    reads: golden[2].start,
    close: golden.word("muse") - 0.2,
    assemble: gAssemble,
    climax: gClimax,
    transcript: gTranscript,
    result: gTranscript + 1.9,
    end: gTranscript + 2.85,
  };
  scenes.push({ id: "golden", start: gS, dur: goldenCues.end + 0.2 });

  // 6 · under the hood (a match cut on a torn edge)
  const hS = gS + goldenCues.end;
  const hood = place("hood", hS, 0.4);
  const hoodCues: HoodCues = {
    s1: hood[0].start - 0.25,
    s2: hood.word("proposes") - 0.3,
    s3: hood[2].start - 0.2,
    s4: hood[3].start - 0.2,
    s5: hood[4].start - 0.5,
    end: hood[4].end + 1.1,
  };
  scenes.push({ id: "hood", start: hS, dur: hoodCues.end + 0.2 });

  // 7 · read whole again, the sacks, the end card
  const kS = hS + hoodCues.end;
  const peak = place("peak", kS, 0.5, { 2: 0.4, 3: 0.3 });
  const peakCues: PeakCues = {
    quote0: peak[1].start,
    quote1: peak[1].end,
    sacks: Math.max(peak[1].end + 0.45, peak[2].start - 0.7),
    card: peak[3].start - 0.6,
    seat: peak[3].start + 0.35,
    end: peak[3].end + 2.0,
  };
  scenes.push({ id: "peak", start: kS, dur: peakCues.end });

  const total = kS + peakCues.end;
  return { scenes, clips, total, cold: { warp: coldWarp }, sacks: sacksCues, twins: twinsCues, proof: proofCues, golden: goldenCues, hood: hoodCues, peak: peakCues };
}
