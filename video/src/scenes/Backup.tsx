// The backup cut (the insurance): a plain, captioned walkthrough of the product from the same captures as the film,
// in a quiet window on the room, no narration, a quiet score. Every segment says what it is (recorded run, live run,
// speed) under the window; the live run keeps its real elapsed clock, waits cut.
import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { BACKUP, BACKUP_STARTS, BFPS, type BSeg } from "../film/backupEdit";
import { clamp, smooth } from "../lib/motion";
import { C, F, W } from "../theme";
import { file, phoneScreens, realElapsed, variant, Window } from "./Golden";

const WX = 160;
const WY = 28;
const WW = 1600;
const WH = (WW * 9) / 16;
const WHOLE = { x: 1920, y: 1080, z: 1 };

const heroFile = (n: number) => `capture/hero/default/f${String(Math.max(0, Math.min(1073, n))).padStart(5, "0")}.jpg`;

const Caption: React.FC<{ seg: BSeg; t: number; dur: number }> = ({ seg, t, dur }) => {
  if (seg.kind === "card") return null;
  const n = seg.captions.length;
  const i = Math.min(n - 1, Math.floor((t / dur) * n));
  const t0 = (i * dur) / n;
  const t1 = ((i + 1) * dur) / n;
  const a = clamp((t - t0) / 0.15) * clamp((t1 - t + 0.02) / 0.15);
  return (
    <>
      <div style={{ position: "absolute", left: WX, top: WY + WH + 12, width: WW, display: "flex", justifyContent: "space-between", fontFamily: F.serif, fontWeight: 500, fontSize: 19, color: C.chalk3 }}>
        <span>{seg.label}</span>
      </div>
      <div style={{ position: "absolute", left: (W - 1500) / 2, width: 1500, top: WY + WH + 50, textAlign: "center", opacity: a, fontFamily: F.sans, fontWeight: 500, fontSize: 31, lineHeight: 1.3, color: C.chalk, textWrap: "balance" }}>{seg.captions[i]}</div>
    </>
  );
};

const Clock: React.FC<{ fno: number }> = ({ fno }) => {
  const { frames } = variant("sim");
  const el = realElapsed(frames, fno);
  if (!el) return null;
  return (
    <div style={{ position: "absolute", right: W - (WX + WW), top: WY + WH + 8, display: "flex", alignItems: "baseline", gap: 10, fontFamily: F.sans, fontSize: 18, color: C.chalk2 }}>
      <span>{el.done ? "live run, done in" : "live run, elapsed"}</span>
      <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 24, color: C.chalk, fontVariantNumeric: "tabular-nums lining-nums" }}>
        {Math.floor(el.s / 60)}:{String(Math.floor(el.s % 60)).padStart(2, "0")}
      </span>
    </div>
  );
};

const Segment: React.FC<{ seg: BSeg; dur: number }> = ({ seg, dur }) => {
  const t = useCurrentFrame() / BFPS;
  const frame = useCurrentFrame();
  let body: React.ReactNode = null;
  let clock: React.ReactNode = null;
  if (seg.kind === "hero") {
    const n = Math.min(seg.f1, seg.f0 + frame * seg.step);
    body = <Window src={heroFile(n)} cam={WHOLE} x={WX} y={WY} w={WW} />;
  } else if (seg.kind === "golden") {
    const { frames } = variant("sim");
    const n = Math.min(seg.f1, seg.f0 + frame * seg.step);
    body = <Window src={file(frames, n)} cam={WHOLE} x={WX} y={WY} w={WW} />;
    if (seg.clock) clock = <Clock fno={n} />;
  } else if (seg.kind === "phone") {
    const screens = phoneScreens(variant("sim").frames);
    const ph = 800;
    const pw = (ph * 1179) / 2556;
    const gap = 36;
    const x0 = (W - (4 * pw + 3 * gap)) / 2;
    body = (
      <>
        {screens.map((s, i) => {
          const a = smooth(0.15 + i * 1.1, 0.45 + i * 1.1, t);
          return (
            <div key={s} style={{ position: "absolute", left: x0 + i * (pw + gap), top: WY + (WH - ph) / 2, width: pw, height: ph, borderRadius: 34, overflow: "hidden", opacity: a, boxShadow: `0 20px 50px rgba(14,10,8,0.6), 0 0 0 1.5px ${C.chalkHair2}` }}>
              <Img src={staticFile(s)} style={{ width: pw, height: ph }} />
            </div>
          );
        })}
      </>
    );
  } else if (seg.kind === "page") {
    const z = 1 + 0.06 * smooth(0, dur, t);
    body = <Window src={seg.src} cam={{ x: 2300, y: 900, z }} x={WX} y={WY} w={WW} />;
  } else {
    const a = smooth(0.1, 0.6, t);
    body = (
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: a }}>
        <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 180, lineHeight: 1, color: C.chalk, letterSpacing: "-0.02em" }}>Untorn</div>
        <div style={{ marginTop: 26, fontFamily: F.serif, fontWeight: 500, fontSize: 46, color: C.chalk2 }}>Reads across the tears.</div>
        <div style={{ marginTop: 22, fontFamily: F.sans, fontWeight: 600, fontSize: 32, color: C.chalk }}>untorn.vercel.app</div>
        <div style={{ position: "absolute", bottom: 46, left: 0, right: 0, textAlign: "center", fontFamily: F.sans, fontSize: 17, lineHeight: 1.6, color: C.chalk3 }}>
          Built with Meta SAM 3.1 and Muse Spark. Letters: public domain (Science History Institute; Missouri History Museum; Missouri Historical Society).
          <br />
          Benchmark image and protocol: ShredBench (Apache-2.0). Score: original synthesis.
        </div>
      </div>
    );
  }
  return (
    <AbsoluteFill>
      {body}
      {clock}
      <Caption seg={seg} t={t} dur={dur} />
    </AbsoluteFill>
  );
};

export const Backup: React.FC<{ audio?: boolean }> = ({ audio = true }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 60% 60% at 50% 45%, rgba(255,238,208,0.12), rgba(51,44,39,0) 75%)" }} />
      {BACKUP.map((seg, i) => {
        const from = Math.round(BACKUP_STARTS[i] * BFPS);
        const to = Math.round(BACKUP_STARTS[i + 1] * BFPS);
        return (
          <Sequence key={i} from={from} durationInFrames={to - from} name={`${seg.kind}-${i}`}>
            <Segment seg={seg} dur={(to - from) / BFPS} />
          </Sequence>
        );
      })}
      {audio ? <Audio src={staticFile("audio/backup.wav")} /> : null}
    </AbsoluteFill>
  );
};
