// 0:51 Proof, in one glance. ShredBench's own shredded image, large; the two readings of it stacked large (Muse Spark
// alone, with the words it left out struck through in red; Untorn, whole); then one figure: 8x fewer errors (NED
// 0.404 -> 0.050 on the 64-document replica of the benchmark's protocol). Numbers from src/data/numbers.json, the
// example from src/data/shredbench-example.json. The subject is on screen from the first frame (a cut on the voice).

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import numbers from "../data/numbers.json";
import example from "../data/shredbench-example.json";
import { clamp, easeOut, lerp, noise1, smooth, smoother, soft } from "../lib/motion";
import { C, F, FPS } from "../theme";

export type ProofCues = { muse: number; untorn: number; scores: number; tiles: number; end: number };
export const PROOF_CUES: ProofCues = { muse: 0.6, untorn: 4.6, scores: 8.6, tiles: 11.0, end: 13.5 };

type Word = { w: string; ok?: boolean; missing?: boolean; extra?: boolean };
type Bench = (typeof numbers.proof)[number] & {
  replica: { n: number; pieces: number; museAlone: number; untorn: number };
  official: { n: number; museAlone: number; untorn: number };
  sam: { found: number; of: number; images: number };
  imageCredit: string;
};
const sb = numbers.proof.find((p) => p.id === "shredbench") as unknown as Bench;
const FACTOR = sb.replica.museAlone / sb.replica.untorn; // 8.08

/** The first sentence of the reference (where Muse alone dropped its phrases). */
const firstSentence = (ws: Word[]) => {
  const i = ws.findIndex((x) => !x.extra && /producer\.$/.test(x.w));
  return i >= 0 ? ws.slice(0, i + 1) : ws;
};

/** Machine output typed at a steady rate. Words the model left out: struck through in red (a real error). */
const Reading: React.FC<{ words: Word[]; t: number; t0: number; cps: number; color: string; struck: boolean }> = ({ words, t, t0, cps, color, struck }) => {
  let budget = Math.max(0, (t - t0) * cps);
  return (
    <div style={{ fontFamily: F.mono, fontSize: 31, lineHeight: 1.42, color, letterSpacing: "-0.02em" }}>
      {words.map((x, i) => {
        if (x.missing && !struck) return null;
        const len = x.w.length + 1;
        const vis = clamp(budget / len);
        budget -= len;
        if (vis <= 0) return null;
        const text = x.w.slice(0, Math.ceil(x.w.length * vis));
        return (
          <React.Fragment key={i}>
            <span style={x.missing ? { color: C.redLt, textDecoration: "line-through", textDecorationThickness: 3, opacity: 0.9 } : { color: x.extra ? C.redLt : color }}>{text}</span>{" "}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export const Proof: React.FC<{ cues?: ProofCues }> = ({ cues = PROOF_CUES }) => {
  const t = useCurrentFrame() / FPS;
  const drift = noise1(t * 0.22, 9) * 3;
  // the readings give way to the figure; the photo eases back a little to share the frame
  // one after the other, never both at once: the readings leave, then the figure lands
  const readA = 1 - smooth(cues.scores - 0.5, cues.scores - 0.12, t);
  const fig = smoother(cues.scores - 0.12, cues.scores + 0.4, t);
  const photoS = lerp(1, 0.86, fig);
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 46% 70% at 26% 50%, rgba(255,238,208,0.42), rgba(250,224,186,0.2) 45%, rgba(51,44,39,0) 100%)" }} />
      {/* the shredded photo, as the benchmark published it: large, from the first frame */}
      <div style={{ position: "absolute", left: 80 + drift, top: 104, width: 770, height: 770, transform: `scale(${photoS}) rotate(-1deg)`, transformOrigin: "0% 50%", boxShadow: "0 22px 48px rgba(18,12,8,0.55), 0 2px 4px rgba(18,12,8,0.4)" }}>
        <Img src={staticFile(sb.image!)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div style={{ position: "absolute", right: 64, top: 44, fontFamily: F.sans, fontSize: 16, color: "rgba(243,238,228,0.62)" }}>{sb.imageCredit}</div>
      {/* the two readings, stacked */}
      <div style={{ position: "absolute", left: 960, top: 120, width: 880, opacity: readA }}>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.chalk2, marginBottom: 12, opacity: clamp((t - cues.muse + 0.4) / 0.3) }}>
          Muse Spark alone <span style={{ fontWeight: 400, color: C.chalk3 }}>· struck through: what it left out</span>
        </div>
        <Reading words={firstSentence(example.museAlone as Word[])} t={t} t0={cues.muse} cps={58} color={C.chalk2} struck />
        <div style={{ height: 1, background: C.chalkHair2, margin: "30px 0 26px", opacity: clamp((t - cues.untorn + 0.4) / 0.3) }} />
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.chalk, marginBottom: 12, opacity: clamp((t - cues.untorn + 0.4) / 0.3) }}>Untorn: the same Muse Spark, with SAM 3.1 and the solver</div>
        <Reading words={firstSentence(example.untorn as Word[])} t={t} t0={cues.untorn} cps={95} color={C.chalk} struck={false} />
      </div>
      {/* one figure */}
      {fig > 0.01 && (
        <div style={{ position: "absolute", left: 900, top: 230, width: 960, opacity: fig, transform: `translateY(${(1 - soft(t - cues.scores + 0.25, 6)) * 24}px)` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 26 }}>
            <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 230, lineHeight: 0.9, color: C.chalk, letterSpacing: "-0.03em" }}>{Math.round(FACTOR)}×</span>
            <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 76, lineHeight: 1, color: C.chalk }}>fewer errors</span>
          </div>
          <div style={{ marginTop: 26, fontFamily: F.serif, fontWeight: 500, fontSize: 40, color: C.chalk2, fontVariantNumeric: "tabular-nums lining-nums" }}>
            {sb.replica.museAlone.toFixed(3)} → {sb.replica.untorn.toFixed(3)} <span style={{ fontSize: 28, color: C.chalk3 }}>normalised edit distance</span>
          </div>
          <div style={{ marginTop: 22, fontFamily: F.sans, fontSize: 21, lineHeight: 1.5, color: C.chalk3 }}>
            Same photos, same metric · {sb.replica.n}-document replica of the benchmark's protocol, {sb.replica.pieces} pieces each.
            <br />
            On its {sb.official.n} official images with known text: {sb.official.museAlone.toFixed(3)} → {sb.official.untorn.toFixed(3)}. SAM 3.1 found {sb.sam.found.toLocaleString("en-GB")} of {sb.sam.of.toLocaleString("en-GB")} pieces.
            <br />
            Method, caveats and failures: <span style={{ color: C.chalk2 }}>untorn.vercel.app/accuracy</span>
          </div>
        </div>
      )}
      <div style={{ position: "absolute", left: 96, top: 40, fontFamily: F.serif, fontWeight: 500, fontSize: 23, color: C.chalk2, opacity: easeOut(clamp(t / 0.4)) }}>Benchmark: ShredBench (2026), the same shredded photos read two ways.</div>
    </AbsoluteFill>
  );
};
