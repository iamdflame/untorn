// The backup cut's edit: a plain, captioned walkthrough of the product from the captures (no narration, a quiet
// score). Pure data, so the score script can read the same timings (scripts/audio/backup-score.mts).
import golden from "../data/golden.json";
import simFrames from "../data/golden-frames.json";

export const BFPS = 30;

export type BSeg =
  | { kind: "hero"; f0: number; f1: number; step: number; label: string; captions: string[] }
  | { kind: "golden"; f0: number; f1: number; step: number; hold?: number; clock: boolean; label: string; captions: string[] }
  | { kind: "phone"; dur: number; label: string; captions: string[] }
  | { kind: "page"; src: string; dur: number; label: string; captions: string[] }
  | { kind: "card"; dur: number };

const m = golden.variants.sim.marks;
const firstResult = simFrames.frames.findIndex((f) => f[1] === "result");
const lastFrame = simFrames.frames.length - 1;
const RUN = "Live run on untorn.vercel.app, waits cut. The photo: a simulated tear of a real 1903 letter.";

export const BACKUP: BSeg[] = [
  {
    kind: "hero",
    f0: 0,
    f1: 600,
    step: 2,
    label: "The first screen: a recorded run on a simulated tear of a real 1927 letter, at 2× speed.",
    captions: ["Untorn puts a torn page back together from one photo.", "SAM 3.1 cuts out every piece, and the solver proposes joins from the shape of each tear.", "Muse Spark reads the half-words across each tear to confirm a join."],
  },
  {
    kind: "hero",
    f0: 720,
    f1: 930,
    step: 1,
    label: "Recorded run: a simulated tear of three real letters torn as a stack.",
    captions: ["Pages torn together as a stack share the same edge: shape alone can't tell them apart.", "Muse reads each candidate across the tear. Only C makes words."],
  },
  { kind: "golden", f0: m.qr, f1: m.qrHold, step: 1, hold: 0.7, clock: false, label: RUN, captions: ["Tear your own: the laptop shows a code for the phone."] },
  { kind: "phone", dur: 6, label: "The phone page (an emulated phone).", captions: ["On the phone: one photo of the pieces, checked, then sent to the laptop."] },
  { kind: "golden", f0: m.hero, f1: m.lift + 75, step: 2, clock: true, label: `${RUN} 2× speed.`, captions: ["The laptop picks up the photo and runs the real pipeline, live.", "SAM 3.1 finds the pieces and lifts them onto the light table."] },
  { kind: "golden", f0: m.lift + 75, f1: m.readHold, step: 2, clock: true, label: `${RUN} 2× speed.`, captions: ["Muse Spark reads across each tear; the loupe shows what it read.", "Where too little text crosses a tear, the edge decides."] },
  { kind: "golden", f0: m.readHold, f1: m.climax, step: 2, clock: true, label: `${RUN} 2× speed.`, captions: ["The pieces go home one join at a time, each with its read."] },
  { kind: "golden", f0: m.climax, f1: m.climax + 108, step: 1, clock: true, label: RUN, captions: ["The last tear closes as Muse completes the words across it."] },
  { kind: "golden", f0: m.typing - 20, f1: firstResult - 2, step: 1, clock: true, label: RUN, captions: ["Then Muse reads the rebuilt page back as text."] },
  { kind: "golden", f0: firstResult, f1: firstResult + 180, step: 1, clock: true, label: RUN, captions: ["The result: the page, whole, with its transcript."] },
  { kind: "golden", f0: firstResult + 190, f1: lastFrame, step: 1, clock: true, label: RUN, captions: ["The join map: every seam with both clues, the shape of the tear and what Muse read across it."] },
  {
    kind: "page",
    src: "capture/accuracy/sec-03.jpg",
    dur: 8,
    label: "untorn.vercel.app/accuracy",
    captions: ["How accurate is it? On a 64-document replica of ShredBench's protocol, the text error is 0.050 with Untorn and 0.404 for Muse Spark alone.", "The method, the caveats and the failure cases are published with the numbers."],
  },
  { kind: "card", dur: 4.5 },
];

/** Seconds each segment lasts. */
export function segDur(s: BSeg): number {
  if (s.kind === "hero" || s.kind === "golden") return (s.f1 - s.f0) / s.step / BFPS + ("hold" in s && s.hold ? s.hold : 0);
  return s.dur;
}

export const BACKUP_STARTS: number[] = (() => {
  const out: number[] = [];
  let t = 0;
  for (const s of BACKUP) {
    out.push(t);
    t += segDur(s);
  }
  out.push(t);
  return out;
})();
export const BACKUP_TOTAL = BACKUP_STARTS[BACKUP_STARTS.length - 1];
