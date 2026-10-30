// 0:11 The sacks. A real camera move inside Maximilian Schönherr's 360° photograph of the Stasi Records Archive's
// depot (CC BY-SA 4.0): from the shelves with the numbered paper sacks down to a clear sack of hand-torn paper. The
// counts are set in type from docs/FACTS.md. A beat of silence; then 847 years, alone on the room.

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import numbers from "../data/numbers.json";
import { Numeral } from "../components/Numeral";
import { Panorama } from "../components/Panorama";
import { clamp, easeOut, lerp, noise1, smooth, smoother, soft } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type SacksCues = { sixteen: number; fifteen: number; dim: number; years: number; end: number };
export const SACKS_CUES: SacksCues = { sixteen: 4.9, fifteen: 7.6, dim: 10.2, years: 14.6, end: 17.5 };

const f = numbers.facts;

export const Sacks: React.FC<{ cues?: SacksCues }> = ({ cues = SACKS_CUES }) => {
  const t = useCurrentFrame() / FPS;
  // the camera: shelves of numbered sacks, then down and round to the clear sack of torn paper
  const u = smoother(0, cues.dim + 1.0, t);
  const view = {
    yaw: lerp(12, 64, u) + noise1(t * 0.2, 4) * 0.4,
    pitch: lerp(16, 44, u) + noise1(t * 0.23, 5) * 0.3,
    fov: lerp(86, 58, u),
    roll: noise1(t * 0.17, 6) * 0.25,
    exposure: lerp(0.86, 0.72, smooth(cues.sixteen - 1, cues.sixteen, t)) * (1 - 0.86 * smooth(cues.dim, cues.dim + 1.1, t)),
    sat: 0.56,
    warm: 0.8,
    vignette: 0.5,
  };
  const textA = easeOut(clamp((t - cues.sixteen) / 0.45)) * (1 - smooth(cues.dim - 0.2, cues.dim + 0.5, t));
  const second = smooth(cues.fifteen - 0.1, cues.fifteen + 0.5, t);
  const yearsA = easeOut(clamp((t - cues.years) / 0.35));
  const yearsY = 18 * (1 - soft(t - cues.years, 6));
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <Panorama src="archival/stasi-depot-1-360.jpg" view={view} />
      {/* a quiet shade on the left so the type reads on the photograph */}
      <AbsoluteFill style={{ background: `linear-gradient(90deg, rgba(43,37,33,${0.82 * textA + 0.1}) 0%, rgba(43,37,33,${0.55 * textA}) 34%, rgba(43,37,33,0) 62%)` }} />
      {textA > 0.01 && (
        <div style={{ position: "absolute", left: 150, top: 300, opacity: textA }}>
          <div style={{ fontFamily: F.sans, fontWeight: 500, fontSize: 30, letterSpacing: "0.01em", color: C.chalk2, marginBottom: 6 }}>about</div>
          <Numeral from={f.sacks.display} to={second > 0.001 ? f.stillTorn.display : f.sacks.display} t={t} t0={cues.fifteen} size={250} />
          <div style={{ position: "relative", height: 64, marginTop: 10 }}>
            <div style={{ position: "absolute", fontFamily: F.serif, fontWeight: 500, fontSize: 48, color: C.chalk, opacity: 1 - second, transform: `translateY(${-8 * second}px)` }}>sacks of files, torn by hand</div>
            <div style={{ position: "absolute", fontFamily: F.serif, fontWeight: 500, fontSize: 48, color: C.chalk, opacity: second, transform: `translateY(${8 * (1 - second)}px)` }}>are still in pieces</div>
          </div>
          <div style={{ marginTop: 26, fontFamily: F.sans, fontSize: 20, color: C.chalk3, letterSpacing: "0.005em" }}>{f.sacks.cite}</div>
        </div>
      )}
      {yearsA > 0.01 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: yearsA }}>
          <div style={{ transform: `translateY(${yearsY}px)`, textAlign: "center" }}>
            <div style={{ fontFamily: F.sans, fontWeight: 500, fontSize: 30, color: C.chalk2, marginBottom: 2 }}>about</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 28, justifyContent: "center" }}>
              <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 330, lineHeight: 0.92, color: C.chalk, fontVariantNumeric: "tabular-nums lining-nums", letterSpacing: "-0.02em" }}>{f.years.display}</span>
              <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 84, color: C.chalk }}>years</span>
            </div>
            <div style={{ marginTop: 22, fontFamily: F.serif, fontWeight: 500, fontSize: 40, color: C.chalk2 }}>to rebuild them at this pace</div>
            <div style={{ marginTop: 18, fontFamily: F.sans, fontSize: 20, color: C.chalk3 }}>{f.years.cite}</div>
          </div>
        </AbsoluteFill>
      )}
      <div style={{ position: "absolute", right: 64, top: 44, fontFamily: F.sans, fontSize: 16, color: "rgba(243,238,228,0.62)", opacity: 1 - smooth(cues.dim, cues.dim + 0.6, t) }}>
        Photo: Maximilian Schönherr, Wikimedia Commons, CC BY-SA 4.0 (reprojected)
      </div>
    </AbsoluteFill>
  );
};
