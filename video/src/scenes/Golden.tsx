// 1:04 Tear your own: the real app on untorn.vercel.app, run live (frames from the replay of that recorded live run,
// 3840x2160). The laptop shows "Tear your own" and the QR code; the phone page takes the photo and sends it; the laptop
// picks it up and the real pipeline runs live; the page comes back and Muse reads it back. The waits are cut, and the
// clock shows the run's real elapsed time, jumps included, and stops when the run is done.
// Framing rule: a camera either shows the hero's headline whole or leaves it out entirely, and never holds on a slice.
// The beat has a swap flag (src/data/golden.json): `sim` (a simulated tear, filmed) and `real` (the user's own torn
// page, filmed only once it is cleared). Each variant brings its capture, its label and the frames the edit cuts on.

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import golden from "../data/golden.json";
import simFrames from "../data/golden-frames.json";
import realFrames from "../data/golden-frames-real.json";
import { Label } from "../components/Label";
import { clamp, easeIO, easeOut, lerp, noise1, smooth, smoother, soft, spring } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type GoldenCues = { phone: number; live: number; reads: number; close: number; assemble: number; climax: number; transcript: number; result: number; end: number };
export const GOLDEN_CUES: GoldenCues = { phone: 2.2, live: 6.6, reads: 9.0, close: 10.4, assemble: 13.4, climax: 16.6, transcript: 17.8, result: 20.6, end: 23.2 };

const CW = 3840;
const CH = 2160;
export type Cam = { x: number; y: number; z: number }; // focus (capture px) and zoom (1 = whole capture fills the window)
/** One shot: capture frames f0, f0+step, ... (held at max), the camera easing from cam0 to cam1 over [move] (scene
 *  seconds; the whole shot by default). */
type Seg = { t0: number; t1: number; f0: number; step: number; cam0: Cam; cam1: Cam; max?: number; move?: [number, number] };
export type Tear = "sim" | "real";
export type Frames = { dir: string; step: number; cuts: { realFrom: number; realTo: number; cutMs: number }[]; doneReal: number; blank?: number[]; frames: (string | number | null)[][] };
type Marks = { qr: number; qrHold: number; hero: number; lift: number; read: number; readHold: number; readAt: number[]; home: number; climax: number; typing: number; whole: number };
type Variant = { label: string; marks: Marks; frames: Frames };
export const DEFAULT_TEAR = golden.use as Tear;

export function variant(tear: Tear): Variant {
  const v = golden.variants[tear];
  const frames = (tear === "real" ? realFrames : simFrames) as Frames;
  if (!v.marks || !frames.frames.length)
    throw new Error(`The "${tear}" tear-your-own beat has no capture yet: film it (video/README.md, "Swap the real-tear beat"), then set its marks in src/data/golden.json.`);
  return { label: v.label, marks: v.marks as Marks, frames };
}

const WIDE: Cam = { x: CW / 2, y: CH / 2, z: 1 };
const WIDE_IN: Cam = { x: CW / 2, y: CH / 2 - 8, z: 1.025 }; // still shows the headline whole, with its margin
// The capture frames the edit cuts on come from the variant's marks (src/data/golden.json, with notes on what each
// frame shows); the cameras are framed on the hero's own layout, which both variants share.
function edl(c: GoldenCues, m: Marks): Seg[] {
  const [rx, ry] = m.readAt;
  return [
    // the panel whole as the QR appears, then (as the phone comes in) in on the QR and its URL; the QR is held
    // before the page jumps to the run until the phone has sent the photo
    { t0: 0, t1: c.live, f0: m.qr, step: 1, max: m.qrHold, cam0: { x: 1920, y: 1420, z: 1.39 }, cam1: { x: 2500, y: 1120, z: 2.4 }, move: [c.phone - 0.3, c.phone + 0.8] },
    // the hero takes the run and the photo lands (headline whole)
    { t0: c.live, t1: c.reads, f0: m.hero, step: 1, cam0: WIDE, cam1: WIDE_IN },
    // SAM 3.1 finds the pieces: the stage alone, the photo filling the window (the headline fully out)
    { t0: c.reads, t1: c.close, f0: m.lift, step: 1, cam0: { x: 2760, y: 1080, z: 1.73 }, cam1: { x: 2780, y: 1060, z: 1.8 } },
    // Muse reads across a tear: the loupe, its word and its reason (status line and headline out)
    { t0: c.close, t1: c.assemble, f0: m.read, step: 1, max: m.readHold, cam0: { x: rx, y: ry, z: 2.45 }, cam1: { x: rx, y: ry + 10, z: 2.55 } },
    // the page comes back together (headline whole)
    { t0: c.assemble, t1: c.climax, f0: m.home, step: 1, cam0: WIDE, cam1: WIDE_IN },
    // the climax, continuous with the assembly: the last tear closes under "Orleans"; in until the close-up fills the
    // window (its right edge, the bottom bar and the header all out)
    { t0: c.climax, t1: c.transcript, f0: m.climax, step: 1, cam0: WIDE_IN, cam1: { x: 1440, y: 1150, z: 1.35 } },
    // Muse reads the page back: the headline whole with the transcript typing under it (the button below, out)
    { t0: c.transcript, t1: c.result, f0: m.typing, step: 1, cam0: { x: 1026, y: 690, z: 1.87 }, cam1: { x: 1000, y: 700, z: 1.92 } },
    // the whole page, read
    { t0: c.result, t1: c.end + 1, f0: m.whole, step: 1, cam0: WIDE, cam1: WIDE_IN },
  ];
}

/** The real elapsed time of the run at a capture frame: page time since the request, plus every wait cut so far,
 *  stopping when the run's done event arrived. */
export function realElapsed(frames: Frames, frameNo: number): { s: number; done: boolean } | null {
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
  const real = ms + add;
  return { s: Math.min(real, frames.doneReal) / 1000, done: real >= frames.doneReal };
}

export const file = (frames: Frames, n: number) => {
  let i = Math.max(0, Math.min(frames.frames.length - 1, n));
  // a frame the replay caught between two paints shows the frame before it
  while (i > 0 && frames.blank?.includes(i)) i--;
  const fr = frames.frames[i] as [number, string, number | null, number];
  return `${frames.dir}/seq-${fr[1]}/f${String(fr[0]).padStart(5, "0")}.jpg`;
};

export const Window: React.FC<{ src: string; cam: Cam; x: number; y: number; w: number; dim?: number }> = ({ src, cam, x, y, w, dim = 0 }) => {
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

export const phoneScreens = (frames: Frames) => ["phone-1-guide", "phone-2-check", "phone-3-sending", "phone-4-sent"].map((n) => `${frames.dir}/phone/${n}.png`);

const Phone: React.FC<{ t: number; c: GoldenCues; screens: string[] }> = ({ t, c, screens }) => {
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
        {screens.map((p, i) => (
          <Img key={p} src={staticFile(p)} style={{ position: "absolute", inset: 0, width: pw, height: ph, opacity: i === step ? 1 : 0 }} />
        ))}
        {tap > 0 && tap < 0.6 && (
          <div style={{ position: "absolute", left: pw * 0.5 - 40, top: ph * 0.857 - 40, width: 80, height: 80, borderRadius: 40, border: `2px solid ${C.chalk}`, opacity: (1 - tap / 0.6) * 0.8, transform: `scale(${0.6 + tap * 1.2})` }} />
        )}
      </div>
    </div>
  );
};

export const Golden: React.FC<{ cues?: GoldenCues; tear?: Tear }> = ({ cues = GOLDEN_CUES, tear = DEFAULT_TEAR }) => {
  const t = useCurrentFrame() / FPS;
  const { label, marks, frames } = variant(tear);
  const segs = edl(cues, marks);
  const seg = segs.find((s) => t >= s.t0 && t < s.t1) ?? segs[segs.length - 1];
  const k = seg.move ? smoother(seg.move[0], seg.move[1], t) : smoother(seg.t0, seg.t1, t);
  const cam = { x: lerp(seg.cam0.x, seg.cam1.x, k), y: lerp(seg.cam0.y, seg.cam1.y, k), z: lerp(seg.cam0.z, seg.cam1.z, k) };
  const fno = Math.min(seg.max ?? Infinity, seg.f0 + Math.floor((t - seg.t0) * FPS) * seg.step);
  // the laptop window makes room for the phone, then takes the frame back
  const side = smooth(cues.phone - 0.1, cues.phone + 0.6, t) * (1 - smooth(cues.live - 0.5, cues.live, t));
  // the window keeps clear of our own type: the label band above (to y 92) and the caption band below (from y 924)
  const ww = lerp(1458, 1180, side);
  const wx = lerp((W - 1458) / 2, 130, side) + noise1(t * 0.25, 4) * 2;
  const wy = lerp(98, 150, side);
  const el = realElapsed(frames, fno);
  const clockA = el == null ? 0 : smooth(cues.live + 0.2, cues.live + 0.6, t);
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(255,238,208,0.16), rgba(51,44,39,0) 75%)" }} />
      <Window src={file(frames, fno)} cam={cam} x={wx} y={wy} w={ww} dim={side * 0.25} />
      <Phone t={t} c={cues} screens={phoneScreens(frames)} />
      {clockA > 0.01 && el != null && (
        <div style={{ position: "absolute", right: 104, top: 30, opacity: clockA, display: "flex", alignItems: "center", gap: 12, fontFamily: F.sans, fontSize: 21, color: C.chalk2 }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: C.chalk, opacity: el.done ? 0.9 : 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2)) }} />
          <span>{el.done ? "live run, done in" : "live run, elapsed"}</span>
          <span style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 30, color: C.chalk, fontVariantNumeric: "tabular-nums lining-nums" }}>
            {Math.floor(el.s / 60)}:{String(Math.floor(el.s % 60)).padStart(2, "0")}
          </span>
        </div>
      )}
      <Label t={t} t0={0.6} x={96} y={40}>
        {label}
      </Label>
    </AbsoluteFill>
  );
};
void easeIO;
void easeOut;
void soft;
