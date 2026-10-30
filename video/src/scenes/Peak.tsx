// 1:41 Read whole again. The rebuilt 1927 letter (the run's own page render) on the light table; the camera moves in
// to the line Muse transcribed while it is read aloud, and the words light violet (Muse read them). Then the inside of
// a sack of slips torn in 1989 (Schönherr's 360° photograph), and the end card.

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import numbers from "../data/numbers.json";
import { Panorama } from "../components/Panorama";
import { TornWord } from "../components/TornWord";
import { clamp, easeIO, easeOut, lerp, noise1, smooth, smoother, soft } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type PeakCues = { quote0: number; quote1: number; sacks: number; card: number; seat: number; end: number };
export const PEAK_CUES: PeakCues = { quote0: 2.0, quote1: 6.4, sacks: 7.6, card: 12.2, seat: 13.4, end: 17.0 };

// the page render is 1779 x 2566 px; the quoted words, measured on it
const PAGE_W = 1779;
const PAGE_H = 2566;
const QUOTE = [
  { x0: 709, x1: 1591, y: 1214 },
  { x0: 203, x1: 790, y: 1297 },
];

export const Peak: React.FC<{ cues?: PeakCues }> = ({ cues = PEAK_CUES }) => {
  const t = useCurrentFrame() / FPS;
  // the page: from whole in frame to the quoted line, slowly
  const push = smoother(0.0, cues.quote1 + 0.6, t);
  const s0 = (H - 120) / PAGE_H;
  const s1 = 0.6;
  const s = s0 * Math.pow(s1 / s0, push);
  const fx = lerp(PAGE_W / 2, 880, push);
  const fy = lerp(PAGE_H / 2, 1250, push);
  // the page stays right of the transcript column (which ends at x = 680)
  const sx = lerp(W / 2 + 230, 1262, push) + noise1(t * 0.3, 2) * 2;
  const sy = H / 2 + noise1(t * 0.27, 3) * 1.5;
  const pageA = 1 - smooth(cues.sacks - 0.2, cues.sacks + 0.5, t);
  const ul = (k: number) => clamp((t - cues.quote0 - k * 1.9) / 1.6);
  // the sack of torn slips
  const sackA = smooth(cues.sacks - 0.3, cues.sacks + 0.4, t) * (1 - smooth(cues.card - 0.5, cues.card + 0.2, t));
  const u = smoother(cues.sacks - 0.5, cues.card + 0.5, t);
  const view = { yaw: lerp(-46, -30, u), pitch: lerp(32, 40, u), fov: lerp(80, 64, u), roll: noise1(t * 0.2, 5) * 0.3, exposure: 0.88, sat: 0.6, warm: 0.7, vignette: 0.55 };
  const cardA = smooth(cues.card - 0.2, cues.card + 0.4, t);
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      {pageA > 0.01 && (
        <AbsoluteFill style={{ opacity: pageA }}>
          <AbsoluteFill style={{ background: "radial-gradient(ellipse 46% 64% at 55% 50%, rgba(255,238,208,0.5), rgba(250,224,186,0.25) 45%, rgba(51,44,39,0) 100%)" }} />
          <div style={{ position: "absolute", left: sx - fx * s, top: sy - fy * s, width: PAGE_W * s, height: PAGE_H * s }}>
            <Img src={staticFile("kit/fdr/page-0.png")} style={{ width: "100%", height: "100%", filter: "drop-shadow(0 18px 36px rgba(18,12,8,0.55))" }} />
            {QUOTE.map((q, i) => (
              <div key={i} style={{ position: "absolute", left: q.x0 * s, top: q.y * s + 10 * s, height: Math.max(2, 5 * s), width: (q.x1 - q.x0) * s * ul(i), background: C.violet, borderRadius: 2, opacity: 0.9 }} />
            ))}
          </div>
          <div style={{ position: "absolute", left: 120, top: 330, width: 560, opacity: easeOut(clamp((t - 0.6) / 0.6)) }}>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.chalk2, marginBottom: 14 }}>Muse read the page</div>
            <div style={{ fontFamily: F.mono, fontSize: 25, lineHeight: 1.55, color: C.chalk3 }}>
              cost of $42 a week.{" "}
              <span style={{ color: t > cues.quote0 ? C.violetLt : C.chalk3 }}>I am starting a Patients' Aid Fund to help these poor children</span> and hope to be able to assist about 15 out of the 50 patients.
            </div>
            <div style={{ marginTop: 22, fontFamily: F.serif, fontWeight: 500, fontSize: 22, color: C.chalk3 }}>Franklin D. Roosevelt to Julian Goldman, 1927. Simulated tear, recorded run.</div>
          </div>
        </AbsoluteFill>
      )}
      {sackA > 0.01 && (
        <AbsoluteFill style={{ opacity: sackA }}>
          <Panorama src="archival/stasi-depot-3-360.jpg" view={view} />
          <div style={{ position: "absolute", right: 64, top: 44, fontFamily: F.sans, fontSize: 16, color: "rgba(243,238,228,0.62)" }}>Inside a sack of slips torn in 1989. Photo: Maximilian Schönherr, Wikimedia Commons, CC BY-SA 4.0 (reprojected)</div>
          <div style={{ position: "absolute", left: 150, top: 380, opacity: easeOut(clamp((t - cues.sacks - 0.6) / 0.5)) * (1 - smooth(cues.card - 0.6, cues.card - 0.1, t)) }}>
            <div style={{ fontFamily: F.sans, fontWeight: 500, fontSize: 28, color: C.chalk2 }}>about</div>
            <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 170, lineHeight: 1, color: C.chalk, fontVariantNumeric: "tabular-nums lining-nums", textShadow: "0 2px 20px rgba(20,14,10,0.6)" }}>{numbers.facts.stillTorn.display}</div>
            <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 44, color: C.chalk, textShadow: "0 2px 14px rgba(20,14,10,0.7)" }}>sacks still waiting</div>
          </div>
        </AbsoluteFill>
      )}
      {cardA > 0.01 && (
        <AbsoluteFill style={{ opacity: cardA }}>
          <AbsoluteFill style={{ background: "radial-gradient(ellipse 50% 55% at 50% 46%, rgba(255,238,208,0.16), rgba(51,44,39,0) 70%)" }} />
          <TornWord text="Untorn" t={t} t0={cues.card} seat={cues.seat} x={W / 2} y={318} size={190} align="center" />
          <div style={{ position: "absolute", left: 0, right: 0, top: 548, textAlign: "center", fontFamily: F.serif, fontWeight: 500, fontSize: 48, color: C.chalk2, opacity: easeOut(clamp((t - cues.seat - 0.1) / 0.6)) }}>Reads across the tears.</div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 650, textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 34, color: C.chalk, letterSpacing: "0.01em", opacity: easeOut(clamp((t - cues.seat - 0.4) / 0.6)) }}>untorn.vercel.app</div>
          <div style={{ position: "absolute", left: 200, right: 200, top: 900, textAlign: "center", fontFamily: F.sans, fontSize: 17, lineHeight: 1.6, color: C.chalk3, opacity: easeOut(clamp((t - cues.seat - 0.8) / 0.6)) }}>
            Built with Meta SAM 3.1 and Muse Spark. Archive photos: Maximilian Schönherr, Wikimedia Commons, CC BY-SA 4.0, reprojected and cropped.
            <br />
            Letters: public domain (Science History Institute; Missouri History Museum; Missouri Historical Society). Benchmark image: ShredBench, Apache-2.0. Narration: ElevenLabs.
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
void easeIO;
void soft;
