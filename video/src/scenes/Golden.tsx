// 0:57 Tear your own: the real app, run live from this repository's production build (frames from the replay of the
// recorded live run, 3840x2160). The laptop shows "Tear your own" and the QR code; the phone takes the photo and sends
// it; the laptop picks it up and the real pipeline runs live; the page comes back and Muse reads it back. The waits
// are cut, and the clock shows the run's real elapsed time, jumps included.

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import frames from "../data/golden-frames.json";
import { Label } from "../components/Label";
import { clamp, easeIO, easeOut, lerp, noise1, smooth, smoother, soft, spring } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type GoldenCues = { phone: number; live: number; reads: number; close: number; assemble: number; climax: number; transcript: number; result: number; end: number };
export const GOLDEN_CUES: GoldenCues = { phone: 2.2, live: 6.6, reads: 9.0, close: 10.4, assemble: 13.4, climax: 16.6, transcript: 17.8, result: 20.6, end: 23.2 };

const CW = 3840;
const CH = 2160;
type Cam = { x: number; y: number; z: number }; // focus (capture px) and zoom (1 = whole capture fills the window)
type Seg = { t0: number; t1: number; f0: number; step: number; cam0: Cam; cam1: Cam; max?: number };

const WIDE: Cam = { x: CW / 2, y: CH / 2, z: 1 };
function edl(c: GoldenCues): Seg[] {
  return [
    // the QR waits on the laptop (held before the page jumps to the run) until the phone has sent the photo
    { t0: 0, t1: c.live, f0: 12, step: 1, max: 104, cam0: { x: 1900, y: 1250, z: 1.55 }, cam1: { x: 2050, y: 1200, z: 1.75 } },
    { t0: c.live, t1: c.reads, f0: 116, step: 2, cam0: WIDE, cam1: { x: CW / 2 + 40, y: CH / 2, z: 1.04 } },
    { t0: c.reads, t1: c.close, f0: 300, step: 2, cam0: { x: CW / 2 + 40, y: CH / 2, z: 1.04 }, cam1: { x: CW / 2 + 60, y: CH / 2 + 20, z: 1.08 } },
    { t0: c.close, t1: c.assemble, f0: 600, step: 1, cam0: { x: 1500, y: 1580, z: 2.05 }, cam1: { x: 1530, y: 1600, z: 2.2 } },
    { t0: c.assemble, t1: c.climax, f0: 900, step: 2, cam0: { x: CW / 2 + 380, y: CH / 2, z: 1.15 }, cam1: { x: CW / 2 + 420, y: CH / 2, z: 1.22 } },
    { t0: c.climax, t1: c.transcript, f0: 1255, step: 1, cam0: WIDE, cam1: { x: CW / 2, y: CH / 2 - 30, z: 1.04 } },
    { t0: c.transcript, t1: c.result, f0: 1430, step: 1, cam0: { x: 1180, y: 1430, z: 1.85 }, cam1: { x: 1180, y: 1450, z: 1.92 } },
    { t0: c.result, t1: c.end + 1, f0: 1530, step: 1, cam0: { x: CW / 2, y: CH / 2, z: 1.0 }, cam1: { x: CW / 2, y: CH / 2 + 60, z: 1.06 } },
  ];
}

/** The real elapsed time of the run at a capture frame: page time since the request, plus every wait cut so far. */
function realElapsed(frameNo: number): number | null {
  const fr = frames.frames[frameNo] as [number, string, number | null, number];
  if (!fr || fr[2] == null) return null;
  const ms = fr[2];
  let add = 0;
  let acc = 0;
  for (const c of frames.cuts) {
    // where this cut sits on the compressed clock
    const at = c.realTo - acc - c.cutMs;
    acc += c.cutMs;
    if (ms >= at) add += c.cutMs;
  }
  return (ms + add) / 1000;
}

const file = (n: number) => {
  const fr = frames.frames[Math.max(0, Math.min(frames.frames.length - 1, n))] as [number, string, number | null, number];
  return `capture/golden/seq-${fr[1]}/f${String(fr[0]).padStart(5, "0")}.jpg`;
};

const Window: React.FC<{ src: string; cam: Cam; x: number; y: number; w: number; dim?: number }> = ({ src, cam, x, y, w, dim = 0 }) => {
  const h = (w * 9) / 16;
  const s = (w / CW) * cam.z;
  const left = w / 2 - cam.x * s;
  const top = h / 2 - cam.y * s;
  // keep the capture covering the window
  const L = Math.min(0, Math.max(w - CW * s, left));
  const T = Math.min(0, Math.max(h - CH * s, top));
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 14, overflow: "hidden", boxShadow: "0 30px 70px rgba(14,10,8,0.6), 0 2px 6px rgba(14,10,8,0.5)", outline: `1px solid ${C.chalkHair2}`, background: C.room3 }}>
      <Img src={staticFile(src)} style={{ position: "absolute", left: L, top: T, width: CW * s, height: CH * s }} />
      {dim > 0 && <div style={{ position: "absolute", inset: 0, background: C.room, opacity: dim }} />}
    </div>
  );
};

const PHONE = ["capture/golden/phone/phone-1-guide.png", "capture/golden/phone/phone-2-check.png", "capture/golden/phone/phone-3-sending.png", "capture/golden/phone/phone-4-sent.png"];

const Phone: React.FC<{ t: number; c: GoldenCues }> = ({ t, c }) => {
  const u = t - c.phone;
  const inK = spring(u);
  const outK = smooth(c.live - 0.45, c.live, t);
  if (u < 0 || outK >= 1) return null;
  const pw = 404;
  const ph = (pw * 2556) / 1179;
  // which screen: guide, check (the photo), sending, sent
  const step = u < 1.0 ? 0 : u < 2.55 ? 1 : u < 2.9 ? 2 : 3;
  const tap = u - 2.4;
  return (
    <div style={{ position: "absolute", left: W - 150 - pw + (1 - inK) * 520, top: (H - ph) / 2 - 6, width: pw, height: ph, transform: `rotate(${(1 - inK) * 6}deg)`, opacity: 1 - outK }}>
      <div style={{ position: "absolute", inset: -11, borderRadius: 66, background: "#1d1916", boxShadow: "0 36px 80px rgba(14,10,8,0.65), inset 0 0 0 1.5px rgba(243,238,228,0.18)" }} />
      <div style={{ position: "absolute", inset: 0, borderRadius: 56, overflow: "hidden", background: C.room }}>
        {PHONE.map((p, i) => (
          <Img key={p} src={staticFile(p)} style={{ position: "absolute", inset: 0, width: pw, height: ph, opacity: i === step ? 1 : 0 }} />
        ))}
        {tap > 0 && tap < 0.6 && (
          <div style={{ position: "absolute", left: pw * 0.5 - 40, top: ph * 0.857 - 40, width: 80, height: 80, borderRadius: 40, border: `2px solid ${C.chalk}`, opacity: (1 - tap / 0.6) * 0.8, transform: `scale(${0.6 + tap * 1.2})` }} />
        )}
      </div>
    </div>
  );
};

export const Golden: React.FC<{ cues?: GoldenCues }> = ({ cues = GOLDEN_CUES }) => {
  const t = useCurrentFrame() / FPS;
  const segs = edl(cues);
  const seg = segs.find((s) => t >= s.t0 && t < s.t1) ?? segs[segs.length - 1];
  const k = smoother(seg.t0, seg.t1, t);
  const cam = { x: lerp(seg.cam0.x, seg.cam1.x, k), y: lerp(seg.cam0.y, seg.cam1.y, k), z: lerp(seg.cam0.z, seg.cam1.z, k) };
  const fno = Math.min(seg.max ?? Infinity, seg.f0 + Math.floor((t - seg.t0) * FPS) * seg.step);
  // the laptop window makes room for the phone, then takes the frame back
  const side = smooth(cues.phone - 0.1, cues.phone + 0.6, t) * (1 - smooth(cues.live - 0.5, cues.live, t));
  const ww = lerp(1720, 1180, side);
  const wx = lerp((W - 1720) / 2, 130, side) + noise1(t * 0.25, 4) * 2;
  const wy = lerp((H - (1720 * 9) / 16) / 2 - 10, (H - (1180 * 9) / 16) / 2, side);
  const el = realElapsed(fno);
  const clockA = el == null ? 0 : smooth(cues.live + 0.2, cues.live + 0.6, t);
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(255,238,208,0.16), rgba(51,44,39,0) 75%)" }} />
      <Window src={file(fno)} cam={cam} x={wx} y={wy} w={ww} dim={side * 0.25} />
      <Phone t={t} c={cues} />
      {clockA > 0.01 && el != null && (
        <div style={{ position: "absolute", right: 104, top: 30, opacity: clockA, display: "flex", alignItems: "center", gap: 12, fontFamily: F.sans, fontSize: 21, color: C.chalk2 }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: C.chalk, opacity: 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2)) }} />
          <span>live run, elapsed</span>
          <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 30, color: C.chalk, fontVariantNumeric: "tabular-nums lining-nums" }}>
            {Math.floor(el / 60)}:{String(Math.floor(el % 60)).padStart(2, "0")}
          </span>
        </div>
      )}
      <Label t={t} t0={0.6} x={96} y={40}>
        Simulated tear of a real 1903 letter, sent from a phone. Live run, waits cut.
      </Label>
    </AbsoluteFill>
  );
};
void easeIO;
void easeOut;
void soft;
