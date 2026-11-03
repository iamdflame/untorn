// 1:41 Read whole again. The rebuilt 1927 letter (the run's own page render) on the light table; the camera moves in
// to the line Muse transcribed while it is read aloud, and the words light violet (Muse read them). Then the German
// letter of the first screen (its recorded run's page render): the sentence Muse read underlines as its translation
// types beside it. Then the letter is filed: its archive record by Muse Wonder (the recorded run's own record, every
// field quoted from the page), row by row as the narrator names them, and a spoken note written down by Muse Voice
// Transcribe (sent through the live site). Then the inside of a sack of slips torn in 1989 (Schönherr's 360°
// photograph), and the end card.

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import numbers from "../data/numbers.json";
import filed from "../data/record-stresemann.json";
import { Panorama } from "../components/Panorama";
import { TornWord } from "../components/TornWord";
import { clamp, easeIO, easeOut, lerp, noise1, settle, smooth, smoother, soft, spring } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type PeakCues = {
  quote0: number;
  quote1: number;
  german: number;
  record: number;
  rFrom: number;
  rTo: number;
  rWhen: number;
  rWhere: number;
  rQuote: number;
  note: number;
  sacks: number;
  card: number;
  seat: number;
  end: number;
};
export const PEAK_CUES: PeakCues = { quote0: 2.0, quote1: 6.4, german: 7.0, record: 10.8, rFrom: 12.6, rTo: 13.2, rWhen: 13.8, rWhere: 14.3, rQuote: 15.4, note: 17.0, sacks: 20.2, card: 24.8, seat: 26.0, end: 29.6 };

// the record's rows, as the narrator names them ("who wrote it, to whom, when and where"); names and quotes verbatim
// from the recorded run's record
const REC = filed.record;
const LONG_DATE = "11 May 1922";
const ROWS: { k: string; v: string; q: string; cue: keyof PeakCues }[] = [
  { k: "Kind", v: "Letter", q: "", cue: "record" },
  { k: "From", v: REC.from.name, q: REC.from.quote, cue: "rFrom" },
  { k: "To", v: REC.to.name, q: REC.to.quote, cue: "rTo" },
  { k: "Date", v: LONG_DATE, q: REC.date.quote, cue: "rWhen" },
  { k: "Written at", v: REC.place.name, q: REC.place.quote, cue: "rWhere" },
];
const NOTE = filed.spoken.text;

// the page render is 1779 x 2566 px; the quoted words, measured on it
const PAGE_W = 1779;
const PAGE_H = 2566;
const QUOTE = [
  { x0: 709, x1: 1591, y: 1214 },
  { x0: 203, x1: 790, y: 1297 },
];
// the German page render is 1276 x 1608 px; the sentence Muse read and translated, measured on it (glyph bottoms), and
// both texts verbatim from the recorded run's transcript and translation
const G_W = 1276;
const G_H = 1608;
const G_QUOTE = [
  { x0: 812, x1: 1253, y: 613 },
  { x0: 374, x1: 1253, y: 669 },
  { x0: 371, x1: 769, y: 723 },
];
const G_FOCUS_Y = 668;
const G_DE = "Ich habe mich niemals dahin ausgesprochen, daß wir in Deutschland eine absolute Monarchie gehabt hätten.";
const G_EN = "I have never expressed myself to the effect that we in Germany had had an absolute monarchy.";

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
  // the light table glows under both letters, until the sack covers it
  const tableA = 1 - smooth(cues.sacks - 0.3, cues.sacks + 0.4, t);
  // the 1927 page lifts away (a touch smaller, gone in 0.3 s) just before the German letter lands
  const pageA = 1 - smooth(cues.german - 0.35, cues.german - 0.05, t);
  const pageLift = 1 - 0.02 * smooth(cues.german - 0.35, cues.german - 0.05, t);
  const ul = (k: number) => clamp((t - cues.quote0 - k * 1.9) / 1.6);
  // the German letter drops onto the table on the heavy spring: from a little above and larger, its shadow tightening,
  // with a small turn that dies out as it touches down; its sentence lands where the quote was (its left edge clear
  // of the column)
  const gu = t - cues.german + 0.12;
  const glift = 1 - spring(gu);
  const gA = smooth(cues.german - 0.12, cues.german + 0.16, t) * (1 - smooth(cues.sacks - 0.2, cues.sacks + 0.5, t));
  const gs = lerp(0.8, 0.84, smoother(cues.german - 0.12, cues.sacks + 0.5, t)) * (1 + 0.045 * glift);
  const gx = 745 - (G_W * gs * 0.045 * glift) / 2 + noise1(t * 0.3, 6) * 2;
  const gy = 545 - G_FOCUS_Y * gs - glift * 16 + noise1(t * 0.27, 7) * 1.5;
  const grot = glift * 1.2 + settle(gu - 0.2) * 0.9;
  const gul = (k: number) => clamp((t - cues.german - 0.5 - k * 0.45) / 0.5);
  const typed = Math.round(G_EN.length * clamp((t - cues.german - 1.3) / 2.0));
  const caret = t > cues.german + 1.2 && t < cues.german + 3.9 && (typed < G_EN.length || Math.floor(t * 2.4) % 2 === 0);
  // the sack of torn slips
  const sackA = smooth(cues.sacks - 0.3, cues.sacks + 0.4, t) * (1 - smooth(cues.card - 0.5, cues.card + 0.2, t));
  const u = smoother(cues.sacks - 0.5, cues.card + 0.5, t);
  const view = { yaw: lerp(-46, -30, u), pitch: lerp(32, 40, u), fov: lerp(80, 64, u), roll: noise1(t * 0.2, 5) * 0.3, exposure: 0.88, sat: 0.6, warm: 0.7, vignette: 0.55 };
  const cardA = smooth(cues.card - 0.2, cues.card + 0.4, t);
  // filed: the German column gives way to the record; the record leaves with the letter
  const colA = 1 - smooth(cues.record - 0.25, cues.record + 0.2, t);
  const recA = smooth(cues.record, cues.record + 0.45, t) * (1 - smooth(cues.sacks - 0.2, cues.sacks + 0.5, t));
  const rowIn = (cue: number) => easeOut(clamp((t - cue) / 0.35));
  const quoted = smooth(cues.rQuote, cues.rQuote + 0.5, t);
  const noteIn = easeOut(clamp((t - cues.note) / 0.4));
  const noteTyped = Math.round(NOTE.length * clamp((t - cues.note - 0.9) / 1.6));
  const mic = t > cues.note && t < cues.note + 0.9 ? 0.55 + 0.45 * Math.abs(Math.sin((t - cues.note) * 9)) : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      {tableA > 0.01 && <AbsoluteFill style={{ opacity: tableA, background: "radial-gradient(ellipse 46% 64% at 55% 50%, rgba(255,238,208,0.5), rgba(250,224,186,0.25) 45%, rgba(51,44,39,0) 100%)" }} />}
      {pageA > 0.01 && (
        <AbsoluteFill style={{ opacity: pageA }}>
          <div style={{ position: "absolute", left: sx - fx * s, top: sy - fy * s, width: PAGE_W * s, height: PAGE_H * s, transform: `scale(${pageLift})` }}>
            <Img src={staticFile("kit/fdr/page-0.png")} style={{ width: "100%", height: "100%", filter: "drop-shadow(0 18px 36px rgba(18,12,8,0.55))" }} />
            {QUOTE.map((q, i) => (
              <div key={i} style={{ position: "absolute", left: q.x0 * s, top: q.y * s + 10 * s, height: Math.max(2, 5 * s), width: (q.x1 - q.x0) * s * ul(i), background: C.violet, borderRadius: 2, opacity: 0.9 }} />
            ))}
          </div>
          <div style={{ position: "absolute", left: 120, top: 330, width: 560, opacity: easeOut(clamp((t - 0.6) / 0.6)) * (1 - smooth(cues.german - 0.7, cues.german - 0.1, t)) }}>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.chalk2, marginBottom: 14 }}>Muse read the page</div>
            <div style={{ fontFamily: F.mono, fontSize: 25, lineHeight: 1.55, color: C.chalk3 }}>
              cost of $42 a week.{" "}
              <span style={{ color: t > cues.quote0 ? C.violetLt : C.chalk3 }}>I am starting a Patients' Aid Fund to help these poor children</span> and hope to be able to assist about 15 out of the 50 patients.
            </div>
            <div style={{ marginTop: 22, fontFamily: F.serif, fontWeight: 500, fontSize: 22, color: C.chalk3 }}>Franklin D. Roosevelt to Julian Goldman, 1927. Simulated tear, recorded run: 10 of 10 pieces placed, 13 of 13 joins right.</div>
          </div>
        </AbsoluteFill>
      )}
      {gA > 0.01 && (
        <AbsoluteFill style={{ opacity: gA }}>
          <div style={{ position: "absolute", left: gx, top: gy, width: G_W * gs, height: G_H * gs, transform: `rotate(${grot}deg)`, transformOrigin: "50% 40%" }}>
            {/* re-levelled to the 1927 page's paper (this photo is darker and cooler): exposure and warmth only */}
            <Img
              src={staticFile("kit/stresemann/page-0.png")}
              style={{ width: "100%", height: "100%", filter: `brightness(1.2) sepia(0.12) drop-shadow(0 ${18 + glift * 26}px ${36 + glift * 34}px rgba(18,12,8,${0.55 + glift * 0.1}))` }}
            />
            {G_QUOTE.map((q, i) => (
              <div key={i} style={{ position: "absolute", left: q.x0 * gs, top: (q.y + 6) * gs, height: Math.max(2, 4 * gs), width: (q.x1 - q.x0) * gs * gul(i), background: C.violet, borderRadius: 2, opacity: 0.9 }} />
            ))}
          </div>
          <div style={{ position: "absolute", left: 120, top: 330, width: 560, opacity: colA }}>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.chalk2, marginBottom: 14, opacity: easeOut(clamp((t - cues.german - 0.2) / 0.5)) }}>Muse read the page in German and translated it</div>
            <div style={{ fontFamily: F.mono, fontSize: 22, lineHeight: 1.55, color: gul(0) > 0 ? C.violetLt : C.chalk3, opacity: easeOut(clamp((t - cues.german - 0.35) / 0.5)) }}>{G_DE}</div>
            <div style={{ marginTop: 22, fontFamily: F.serif, fontWeight: 500, fontSize: 31, lineHeight: 1.32, color: C.chalk }}>
              {G_EN.slice(0, typed)}
              {caret && <span style={{ display: "inline-block", width: 3, height: "0.92em", marginLeft: 2, marginRight: -5, verticalAlign: "-0.1em", background: C.violetLt }} />}
              <span style={{ color: "transparent" }}>{G_EN.slice(typed)}</span>
            </div>
            <div style={{ marginTop: 22, fontFamily: F.serif, fontWeight: 500, fontSize: 22, color: C.chalk3, opacity: easeOut(clamp((t - cues.german - 3.0) / 0.6)) }}>Gustav Stresemann to Gustav Reimann, 1922. Simulated tear, recorded run: 10 of 10 pieces placed, 16 of 16 joins right.</div>
          </div>
          {recA > 0.01 && (
            <div style={{ position: "absolute", left: 120, top: 218, width: 580, opacity: recA }}>
              <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.chalk2, marginBottom: 16 }}>Muse Wonder filed the page</div>
              <div style={{ borderTop: "1px solid rgba(243,238,228,0.28)" }}>
                {ROWS.map((r) => {
                  const a = rowIn(cues[r.cue] + (r.cue === "record" ? 0.3 : 0));
                  return (
                    <div key={r.k} style={{ display: "flex", gap: 22, padding: "11px 0 10px", borderBottom: "1px solid rgba(243,238,228,0.12)", opacity: a, transform: `translateY(${8 * (1 - a)}px)` }}>
                      <div style={{ width: 132, flex: "none", fontFamily: F.sans, fontSize: 20, color: C.chalk3, paddingTop: 7 }}>{r.k}</div>
                      <div>
                        <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 36, lineHeight: 1.15, color: C.chalk }}>{r.v}</div>
                        {r.q && <div style={{ marginTop: 3, fontFamily: F.mono, fontSize: 19, color: quoted > 0 ? C.violetLt : C.chalk3, opacity: 0.75 + 0.25 * quoted }}>“{r.q}”</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 12, fontFamily: F.serif, fontWeight: 500, fontSize: 21, color: C.chalk3, opacity: quoted }}>Every field quotes the page; the app checked each quote against the transcript.</div>
              {noteIn > 0.01 && (
                <div style={{ marginTop: 26, opacity: noteIn, transform: `translateY(${8 * (1 - noteIn)}px)` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.chalk2 }}>
                    <svg width="26" height="26" viewBox="0 0 20 20" style={{ opacity: mic }}>
                      <path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5ZM5 9.5a5 5 0 0 0 10 0M10 14.5v3M7 17.5h6" fill="none" stroke={C.chalk} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Where it came from, spoken
                  </div>
                  <div style={{ marginTop: 10, minHeight: 64, fontFamily: F.mono, fontSize: 22, lineHeight: 1.5, color: C.chalk }}>
                    {NOTE.slice(0, noteTyped)}
                    <span style={{ color: "transparent" }}>{NOTE.slice(noteTyped)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: F.serif, fontWeight: 500, fontSize: 20, color: C.chalk3, opacity: easeOut(clamp((t - cues.note - 2.4) / 0.5)) }}>Written down by Muse Voice Transcribe on the live site in {(filed.spoken.ms / 1000).toFixed(1)} s (a synthetic voice for this film).</div>
                </div>
              )}
            </div>
          )}
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
          <TornWord text="Untorn" t={t} t0={cues.card} seat={cues.seat} x={W / 2} y={250} size={250} align="center" gap={3.2} />
          <div style={{ position: "absolute", left: 0, right: 0, top: 560, textAlign: "center", fontFamily: F.serif, fontWeight: 500, fontSize: 54, color: C.chalk2, opacity: easeOut(clamp((t - cues.seat - 0.15) / 0.6)), transform: `translateY(${(1 - easeOut(clamp((t - cues.seat - 0.15) / 0.6))) * 10}px)` }}>Reads across the tears.</div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 668, textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 36, color: C.chalk, letterSpacing: "0.01em", opacity: easeOut(clamp((t - cues.seat - 0.5) / 0.6)) }}>untorn.vercel.app</div>
          <div style={{ position: "absolute", left: 120, right: 120, top: 880, textAlign: "center", fontFamily: F.sans, fontSize: 17, lineHeight: 1.6, color: C.chalk3, opacity: easeOut(clamp((t - cues.seat - 0.8) / 0.6)) }}>
            <span style={{ color: C.chalk2 }}>Built with Meta SAM 3.1, Muse Spark, Muse Spark Open, Muse Wonder and Muse Voice Transcribe.</span>
            <br />
            Narration: ElevenLabs. Archive photos: Maximilian Schönherr, Wikimedia Commons, CC BY-SA 4.0, reprojected and cropped.
            <br />
            Letters: public domain (Science History Institute; Missouri History Museum; Wikimedia Commons). Benchmark image: ShredBench, Apache-2.0.
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
void easeIO;
void soft;
