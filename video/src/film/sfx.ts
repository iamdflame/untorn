// The sound cues, from the same timeline and motion constants as the picture: paper where paper moves, a soft tick
// where a word reads, a pencil strike where a twin is rejected, and the score's sections and silences.
import { coldEvents, unwarpTime } from "../scenes/ColdOpen";
import type { Timeline } from "./timeline";

export type Cue = { t: number; kind: "tear" | "lift" | "settle" | "tick" | "strike" | "swell" | "pulse" | "trace"; gain?: number; pan?: number; dur?: number };
export type Section = { t: number; chord: number[]; level?: number; bright?: number };

export function sfxCues(tl: Timeline): { cues: Cue[]; sections: Section[]; silences: [number, number][] } {
  const at = (id: string) => tl.scenes.find((s) => s.id === id)!.start;
  const cues: Cue[] = [];
  const ce = coldEvents();
  const cw = (own: number) => unwarpTime(own, tl.cold.warp);

  // 1 · cold open
  cues.push({ t: 0.0, kind: "tear", gain: 0.9, dur: 0.55 });
  cues.push({ t: cw(ce.trace) + 0.1, kind: "trace", gain: 0.5, dur: 1.4 });
  cues.push({ t: cw(ce.lift), kind: "lift", gain: 1.0 });
  cues.push({ t: cw(ce.explode) + 0.1, kind: "swell", gain: 0.6, dur: 1.0 });
  ce.lands.forEach((l, i) => cues.push({ t: cw(l.t), kind: "settle", gain: 0.75 + 0.1 * (i % 3), pan: Math.max(-0.6, Math.min(0.6, (l.x - ce.pageCx) / 1200)) }));
  cues.push({ t: cw(ce.word), kind: "tick", gain: 1.0 });
  cues.push({ t: cw(ce.seat) + 0.05, kind: "settle", gain: 1.1 });
  cues.push({ t: cw(ce.exit) - 0.1, kind: "swell", gain: 0.9, dur: 1.5 });
  cues.push({ t: cw(ce.exit) + 0.15, kind: "lift", gain: 0.9 });

  // 2 · the sacks: the counts land softly; silence before 847; one deep pulse under it
  const s = at("sacks");
  cues.push({ t: s + tl.sacks.sixteen, kind: "pulse", gain: 0.7 });
  cues.push({ t: s + tl.sacks.fifteen + 0.1, kind: "pulse", gain: 0.6 });
  cues.push({ t: s + tl.sacks.years, kind: "pulse", gain: 1.0 });

  // 3 · twins: a tear-shaped wipe in, the fan, each try, the strikes, the read
  const w = at("twins");
  cues.push({ t: w - 0.05, kind: "tear", gain: 0.55, dur: 0.4 });
  cues.push({ t: w + tl.twins.fan, kind: "lift", gain: 0.8 });
  for (const [k, tr] of [tl.twins.tryA, tl.twins.tryB, tl.twins.tryC].entries()) {
    cues.push({ t: w + tr, kind: "lift", gain: 0.8, pan: 0.2 });
    cues.push({ t: w + tr + 0.5, kind: "settle", gain: 0.9 });
    if (k < 2) {
      cues.push({ t: w + tr + 0.55, kind: "strike", gain: 0.9 });
      cues.push({ t: w + tr + 0.95, kind: "lift", gain: 0.6, pan: 0.3 });
    }
  }
  cues.push({ t: w + tl.twins.verdict, kind: "tick", gain: 1.1 });

  // 4 · proof: the bars, the tiles
  const p = at("proof");
  cues.push({ t: p + tl.proof.scores, kind: "tick", gain: 0.7 });

  // 5 · golden path: the phone comes in, the tap, the run, a read, the assembly, the climax
  const g = at("golden");
  cues.push({ t: g + tl.golden.phone, kind: "swell", gain: 0.5, dur: 0.8 });
  cues.push({ t: g + tl.golden.phone + 2.4, kind: "tick", gain: 0.8, pan: 0.4 });
  // on the capture's own events (Golden.tsx frame notes): the photo lands, the pieces lift, a read, pieces 7-9 come
  // home, the last tear closes
  cues.push({ t: g + tl.golden.live + 0.8, kind: "settle", gain: 0.45, pan: 0.2 });
  cues.push({ t: g + tl.golden.reads + 1.25, kind: "lift", gain: 0.55 });
  cues.push({ t: g + tl.golden.close + 0.5, kind: "tick", gain: 0.8 });
  [0.27, 0.8, 1.33].forEach((d, i) => cues.push({ t: g + tl.golden.assemble + d, kind: "settle", gain: 0.55, pan: i % 2 ? 0.3 : -0.3 }));
  cues.push({ t: g + tl.golden.climax + 1.15, kind: "tick", gain: 0.8 });
  cues.push({ t: g + tl.golden.climax + 1.17, kind: "settle", gain: 0.7 });

  // 6 · under the hood: a quiet turn of the page at each stage, a tick when Muse's answer lands
  const h = at("hood");
  for (const st of [tl.hood.s2, tl.hood.s3, tl.hood.s4, tl.hood.s5]) cues.push({ t: h + st - 0.2, kind: "swell", gain: 0.4, dur: 0.7 });
  cues.push({ t: h + tl.hood.s3 + 0.9, kind: "tick", gain: 0.8 });
  // the rule played on the three scraps (Hood.tsx): two pencil strikes, then the read that agrees
  cues.push({ t: h + tl.hood.s4 + 1.1, kind: "strike", gain: 0.6, pan: -0.4 });
  cues.push({ t: h + tl.hood.s4 + 1.65, kind: "strike", gain: 0.6, pan: 0 });
  cues.push({ t: h + tl.hood.s4 + 2.2, kind: "tick", gain: 0.75, pan: 0.4 });
  cues.push({ t: h + tl.hood.s5 + 0.3, kind: "settle", gain: 0.85 });

  // 7 · read whole again: the line lights, the sack, the end card's wordmark joins
  const k = at("peak");
  cues.push({ t: k + tl.peak.quote0, kind: "tick", gain: 0.8 });
  cues.push({ t: k + tl.peak.sacks, kind: "swell", gain: 0.6, dur: 1.4 });
  cues.push({ t: k + tl.peak.seat - 0.05, kind: "settle", gain: 1.0 });

  // the score: D minor colours, opening to F at the title and resolving warm at the end
  const sections: Section[] = [
    { t: 0.3, chord: [50, 57, 62, 64, 69], level: 0.75 },
    { t: cw(ce.title) - 0.4, chord: [41, 53, 57, 60, 64], level: 0.85 },
    { t: s + 1.0, chord: [46, 50, 57, 60, 65], level: 0.75 },
    { t: s + tl.sacks.fifteen, chord: [43, 50, 55, 58, 62], level: 0.7 },
    { t: s + tl.sacks.years, chord: [38, 50, 53, 57, 62], level: 0.8 },
    { t: w + 0.2, chord: [43, 50, 55, 58, 65], level: 0.65 },
    { t: w + tl.twins.tryA, chord: [45, 50, 52, 55, 62], level: 0.6 },
    { t: w + tl.twins.verdict, chord: [41, 53, 57, 60, 64, 69], level: 0.8, bright: 0.2 },
    { t: p + 0.2, chord: [41, 53, 57, 60, 67], level: 0.6 },
    { t: g + 0.2, chord: [46, 53, 58, 62, 65], level: 0.65 },
    { t: g + tl.golden.live, chord: [41, 53, 57, 60, 65], level: 0.7 },
    { t: g + tl.golden.climax, chord: [48, 52, 55, 60, 64], level: 0.75, bright: 0.15 },
    { t: h + 0.2, chord: [50, 53, 57, 60, 64], level: 0.6 },
    { t: h + tl.hood.s3, chord: [43, 50, 53, 58, 62], level: 0.6 },
    { t: h + tl.hood.s5, chord: [46, 50, 57, 60, 65], level: 0.7 },
    { t: k + 0.2, chord: [41, 53, 57, 60, 64], level: 0.75 },
    { t: k + tl.peak.sacks, chord: [43, 50, 55, 58, 62], level: 0.7 },
    { t: k + tl.peak.card - 0.2, chord: [38, 50, 57, 62, 64, 69], level: 0.9, bright: 0.25 },
  ];
  // the score drops away for the beat before 847 and before the twins' verdict
  const silences: [number, number][] = [
    [s + tl.sacks.dim + 0.1, s + tl.sacks.years - 0.05],
    [w + tl.twins.tryC - 0.35, w + tl.twins.verdict - 0.05],
  ];
  return { cues, sections, silences };
}
