// 0:43 Proof. The same shredded photo, read two ways (ShredBench's own image news_041): Muse Spark alone drops whole
// phrases; Untorn, the same Muse Spark with SAM 3.1 and the solver, returns the text. Then the measured scores and the
// recorded-run tiles. Every number from src/data/numbers.json; the example from src/data/shredbench-example.json.

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import numbers from "../data/numbers.json";
import example from "../data/shredbench-example.json";
import { clamp, easeIO, easeOut, noise1, smooth, soft, spring } from "../lib/motion";
import { C, F, FPS } from "../theme";

export type ProofCues = { muse: number; untorn: number; scores: number; tiles: number; end: number };
export const PROOF_CUES: ProofCues = { muse: 0.8, untorn: 4.6, scores: 6.4, tiles: 9.6, end: 14.0 };

type Word = { w: string; ok?: boolean; missing?: boolean; extra?: boolean };
type Bench = (typeof numbers.proof)[number] & {
  replica: { n: number; pieces: number; museAlone: number; untorn: number };
  official: { n: number; museAlone: number; untorn: number };
  sam: { found: number; of: number; images: number };
  imageCredit: string;
  metric: string;
};
const sb = numbers.proof.find((p) => p.id === "shredbench") as unknown as Bench;

/** Machine output, typed in at a steady rate; dropped words shown as red gaps, wrong words in red. */
const Output: React.FC<{ words: Word[]; t: number; t0: number; cps?: number; color: string; showMissing: boolean }> = ({ words, t, t0, cps = 95, color, showMissing }) => {
  let budget = Math.max(0, (t - t0) * cps);
  return (
    <div style={{ fontFamily: F.mono, fontSize: 23, lineHeight: 1.5, color, letterSpacing: "-0.01em" }}>
      {words.map((x, i) => {
        if (x.missing && !showMissing) return null;
        const len = x.w.length + 1;
        const vis = clamp(budget / len);
        budget -= len;
        if (vis <= 0) return null;
        const text = x.w.slice(0, Math.ceil(x.w.length * vis));
        if (x.missing)
          return (
            <span key={i} style={{ color: "transparent", borderBottom: `2px solid ${C.redLt}`, marginRight: "0.6em" }}>
              {text}
            </span>
          );
        return (
          <span key={i} style={{ color: x.extra ? C.redLt : color, marginRight: "0.6em" }}>
            {text}
          </span>
        );
      })}
    </div>
  );
};

const Bar: React.FC<{ label: string; sub: string; value: number; max: number; t: number; t0: number; bright: boolean }> = ({ label, sub, value, max, t, t0, bright }) => {
  const k = easeIO(clamp((t - t0) / 0.9));
  const wFull = 600;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", alignItems: "center", columnGap: 26, opacity: easeOut(clamp((t - t0) / 0.35)) }}>
      <div>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 22, color: bright ? C.chalk : C.chalk2 }}>{label}</div>
        <div style={{ fontFamily: F.sans, fontSize: 18, color: C.chalk3 }}>{sub}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div style={{ height: 22, width: Math.max(2, (wFull * value * k) / max), background: bright ? C.chalk : "rgba(243,238,228,0.38)", borderRadius: 2 }} />
        <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 52, color: bright ? C.chalk : C.chalk2, fontVariantNumeric: "tabular-nums lining-nums", opacity: smooth(0.6, 1, k) }}>{value.toFixed(3)}</div>
      </div>
    </div>
  );
};

const Tile: React.FC<{ t: number; t0: number; kind: string; big: string; text: string }> = ({ t, t0, kind, big, text }) => {
  const k = spring(t - t0);
  const a = clamp((t - t0) / 0.25);
  if (a <= 0) return null;
  return (
    <div style={{ width: 548, padding: "16px 22px 18px", background: "#f4eee2", borderRadius: 3, color: C.ink, opacity: a, transform: `translateY(${(1 - clamp(k)) * 40}px)`, boxShadow: "0 10px 26px rgba(18,12,8,0.45), 0 1px 2px rgba(18,12,8,0.35)" }}>
      <div style={{ display: "inline-block", fontFamily: F.sans, fontWeight: 600, fontSize: 15, letterSpacing: "0.02em", color: C.ink2, borderTop: `1.5px solid ${C.ink}`, borderBottom: "1px solid rgba(42,46,52,0.35)", padding: "4px 0 3px" }}>{kind}</div>
      <div style={{ marginTop: 10, fontFamily: F.serif, fontWeight: 500, fontSize: 46, lineHeight: 1, fontVariantNumeric: "tabular-nums lining-nums" }}>{big}</div>
      <div style={{ marginTop: 6, fontFamily: F.sans, fontSize: 17, color: C.ink2 }}>{text}</div>
    </div>
  );
};

export const Proof: React.FC<{ cues?: ProofCues }> = ({ cues = PROOF_CUES }) => {
  const t = useCurrentFrame() / FPS;
  const imgIn = soft(t - 0.1, 5);
  const drift = noise1(t * 0.22, 9) * 4;
  const outA = 1 - smooth(cues.scores - 0.3, cues.scores + 0.2, t);
  const fdr = numbers.proof.find((p) => p.id === "fdr")!;
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 42% 60% at 22% 50%, rgba(255,238,208,0.40), rgba(250,224,186,0.20) 45%, rgba(51,44,39,0) 100%)" }} />
      {/* the shredded photo, as ShredBench published it */}
      <div style={{ position: "absolute", left: 110 + drift, top: 170 + (1 - imgIn) * 30, width: 540, height: 540, opacity: clamp(imgIn * 1.4), transform: "rotate(-1.2deg)", boxShadow: "0 18px 40px rgba(18,12,8,0.5), 0 2px 4px rgba(18,12,8,0.4)" }}>
        <Img src={staticFile(sb.image!)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div style={{ position: "absolute", right: 64, top: 44, fontFamily: F.sans, fontSize: 16, color: "rgba(243,238,228,0.62)", opacity: clamp(imgIn) }}>{sb.imageCredit}</div>
      <div style={{ position: "absolute", left: 740, top: 120, width: 1080 }}>
        <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 44, color: C.chalk, opacity: easeOut(clamp((t - 0.2) / 0.5)) }}>{sb.title}</div>
        <div style={{ marginTop: 8, fontFamily: F.sans, fontSize: 18, color: C.chalk3, opacity: easeOut(clamp((t - 0.4) / 0.5)) }}>{sb.subtitle}</div>
        <div style={{ position: "relative", marginTop: 34, opacity: outA }}>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 21, color: C.chalk2, marginBottom: 8, opacity: clamp((t - cues.muse) / 0.3) }}>Muse Spark alone</div>
          <Output words={example.museAlone as Word[]} t={t} t0={cues.muse + 0.2} color={C.chalk2} showMissing />
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 21, color: C.chalk, margin: "26px 0 8px", opacity: clamp((t - cues.untorn) / 0.3) }}>Untorn: the same Muse Spark, with SAM 3.1 and the solver</div>
          <Output words={example.untorn as Word[]} t={t} t0={cues.untorn + 0.15} cps={170} color={C.chalk} showMissing={false} />
        </div>
        <div style={{ position: "absolute", top: 200, left: 0, right: 0, display: "grid", rowGap: 30 }}>
          {t > cues.scores - 0.1 && (
            <>
              <div style={{ fontFamily: F.sans, fontSize: 19, color: C.chalk3, opacity: easeOut(clamp((t - cues.scores) / 0.4)) }}>{sb.metric}</div>
              <Bar label="Muse Spark alone" sub="about 40 % of the text wrong" value={sb.replica.museAlone} max={0.55} t={t} t0={cues.scores} bright={false} />
              <Bar label="Untorn" sub="about 5 % wrong" value={sb.replica.untorn} max={0.55} t={t} t0={cues.scores + 0.35} bright />
              <div style={{ fontFamily: F.sans, fontSize: 19, lineHeight: 1.45, color: C.chalk3, opacity: easeOut(clamp((t - cues.scores - 1.0) / 0.4)) }}>
                {sb.replica.n} replica documents, {sb.replica.pieces} pieces each. On ShredBench's {sb.official.n} official images with known text: {sb.official.museAlone.toFixed(3)} against {sb.official.untorn.toFixed(3)}.
              </div>
            </>
          )}
        </div>
      </div>
      <div style={{ position: "absolute", left: 110, top: 760, display: "flex", gap: 26 }}>
        {false && (<div />)}
          <Tile t={t} t0={cues.tiles} kind="simulated tear · recorded run" big={fdr.headline.value} text="pieces placed on a 1927 letter; 13 / 13 joins, 0 misplaced" />
          <Tile t={t} t0={cues.tiles + 0.25} kind="simulated stack tear · recorded run" big="0 misplaced" text="three letters, 24 pieces: 18 placed, 6 set aside, never forced" />
          <Tile t={t} t0={cues.tiles + 0.5} kind="benchmark replica" big={`${sb.sam.found.toLocaleString("en-GB")} / ${sb.sam.of.toLocaleString("en-GB")}`} text={`pieces found by SAM 3.1 in ${sb.sam.images} shredded images`} />
      </div>
    </AbsoluteFill>
  );
};
