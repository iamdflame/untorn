// 0:28 The twins, staged like a trick with the recorded stack run's real pieces: the torn piece Muse read against
// (p3) with an empty slot, and three scraps from three different letters with the very same torn edge (p1, p21, p5).
// Each is tried in the slot at the solver's own fit; two make no words and get a red pencil strike; a beat; the third
// completes the words in violet. Geometry from twins.json (solver prepare()), pixels from the app's cut-outs.

import React, { useCallback, useMemo } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import cutMeta from "../data/cutouts-twins.json";
import stack from "../data/scene-stack-3-letters.json";
import twins from "../data/twins.json";
import numbers from "../data/numbers.json";
import { FrameCanvas, grain, type DrawFn } from "../lib/canvas";
import { useImages } from "../lib/images";
import { applyPose, clamp, composePose, easeIO, easeOut, lerp, noise1, settle, smooth, smoother, spring, type Pose } from "../lib/motion";
import { camZoomPath, drawPiece, drawShadow, edgeLight, lightTable, polyPath, room, setCam, w2s, type Cam, type Cut, type CutMeta, type PoseNow } from "../lib/paper";
import { C, F, FPS, H, W } from "../theme";
import { Label } from "../components/Label";

const KIT = "kit/twins";
type SP = (typeof stack.pieces)[number];
const byId = new Map((stack.pieces as SP[]).map((p) => [p.id, p]));
const P3 = twins.anchor.pagePose as Pose; // anchor photo -> upright page
const anchor = byId.get(twins.anchor.id)!;
const cands = twins.candidates.map((c) => ({ ...c, piece: byId.get(c.id)!, T: composePose(P3, c.pose as Pose) }));

/** Where the tear cuts the words Muse read (page-2 px, measured on the joined pieces): "I a|m", "witne|ss". */
const RINGS: [number, number][] = [
  [332, 483],
  [300, 544],
];

export type TwinsCues = { fan: number; tie: number; reads: number; tryA: number; tryB: number; tryC: number; verdict: number; end: number };
export const TWINS_CUES: TwinsCues = { fan: 1.2, tie: 3.4, reads: 5.2, tryA: 6.0, tryB: 7.5, tryC: 9.9, verdict: 10.7, end: 15.5 };

/** World placement of a piece's centroid and turn under a pose. */
const placeUnder = (p: SP, T: Pose) => {
  const [x, y] = applyPose(T, p.c[0], p.c[1]);
  return { x, y, a: T.theta };
};
const A0 = placeUnder(anchor, P3);
const slot = cands.map((c) => placeUnder(c.piece, c.T));
// the row of scraps under the slot, each in the slot's orientation so the shared edge reads as identical
const slotC = slot[2];
const span = Math.max(...cands.map((c) => c.piece.r)) * 1.75;
const rowY = A0.y + Math.max(anchor.r, cands[2].piece.r) * 1.55;
const rowX = (k: number) => (A0.x + slotC.x) / 2 + (k - 1) * span;
const row = cands.map((c, k) => ({ x: rowX(k) + (slot[k].x - slotC.x) * 0, y: rowY, a: slot[k].a }));

function scrapPose(k: number, t: number, cues: TwinsCues): PoseNow & { k: number } {
  const tries = [cues.tryA, cues.tryB, cues.tryC];
  const ts = tries[k];
  const stackPos = { x: rowX(1), y: rowY, a: slot[k].a };
  // fan out from one stack into three
  const fu = easeIO(clamp((t - cues.fan - k * 0.06) / 0.9));
  let x = lerp(stackPos.x, row[k].x, fu);
  let y = lerp(stackPos.y, row[k].y, fu) - Math.sin(Math.PI * fu) * 30;
  let a = row[k].a;
  let lift = t < cues.fan ? 0.3 : Math.sin(Math.PI * fu) * 0.8;
  let sc = 1;
  let kk = 0;
  if (t >= ts) {
    const e = t - ts;
    const back = k === 2 ? 99 : 0.95; // wrong scraps go back after the strike
    const kin = spring(Math.min(e, back));
    const arc = Math.sin(Math.PI * clamp(kin)) * 80;
    x = lerp(row[k].x, slot[k].x, kin);
    y = lerp(row[k].y, slot[k].y, kin) - arc;
    a = slot[k].a + 0.03 * settle(e - 0.42);
    lift = 1 - smooth(0.25, 0.75, e / 0.95);
    kk = kin;
    if (e > back) {
      const kout = spring(e - back);
      x = lerp(slot[k].x, row[k].x, kout);
      y = lerp(slot[k].y, row[k].y, kout) - Math.sin(Math.PI * clamp(kout)) * 60;
      lift = Math.sin(Math.PI * clamp(kout)) * 0.9;
    }
  }
  sc = 1 + 0.022 * lift;
  return { x, y, a, lift, sc, k: kk };
}

const paths = ["fx/grain.png", ...[twins.anchor.id, ...twins.candidates.map((c) => c.id)].flatMap((id) => ["lit", "edge", "shadow", "contact", "plain"].map((k) => `${KIT}/${id}-${k}.png`))];
const anchorOutline = typeof Path2D === "undefined" ? null : polyPath(anchor.poly);
const candOutline = typeof Path2D === "undefined" ? [] : cands.map((c) => polyPath(c.piece.poly));

export const Twins: React.FC<{ cues?: TwinsCues; debug?: boolean }> = ({ cues = TWINS_CUES, debug = false }) => {
  const imgs = useImages(paths);
  const cuts = useMemo(() => {
    if (!imgs) return null;
    const m: Record<string, Cut> = {};
    for (const id of [twins.anchor.id, ...twins.candidates.map((c) => c.id)]) {
      const meta = (cutMeta as unknown as Record<string, CutMeta>)[id];
      m[id] = { ...meta, lit: imgs[`${KIT}/${id}-lit.png`], plain: imgs[`${KIT}/${id}-plain.png`], edge: imgs[`${KIT}/${id}-edge.png`], shadow: imgs[`${KIT}/${id}-shadow.png`], contact: imgs[`${KIT}/${id}-contact.png`] };
    }
    return m;
  }, [imgs]);

  const camAt = useCallback(
    (t: number): Cam => {
      const wide: Cam = { s: 0.0, wx: (A0.x + slotC.x) / 2, wy: (A0.y + rowY) / 2 + 30, sx: W / 2, sy: H / 2 - 10 };
      const extentX = span * 3.2;
      const extentY = rowY - A0.y + anchor.r * 2.3;
      wide.s = Math.min(W / extentX, (H - 140) / extentY);
      // during the tries the camera leans in on the seam
      const seam: Cam = { s: wide.s * 1.75, wx: (A0.x + slotC.x) / 2, wy: A0.y - anchor.r * 0.1, sx: W / 2, sy: H * 0.45 };
      const lean = smoother(cues.tryA - 0.2, cues.tryA + 0.6, t) * (1 - smoother(cues.verdict + 2.6, cues.verdict + 3.6, t));
      const c = camZoomPath(wide, seam, lean);
      return { ...c, sx: c.sx + noise1(t * 0.3, 7) * 2, sy: c.sy + noise1(t * 0.27, 8) * 1.5 };
    },
    [cues],
  );

  const draw = useCallback<DrawFn>(
    (g, t, frame) => {
      if (!imgs || !cuts) return;
      room(g, W, H);
      const c = camAt(t);
      const [lx, ly] = w2s(c, A0.x, A0.y);
      lightTable(g, lx, ly + 60, Math.max(W, H) * 0.7, 1);
      setCam(g, c);
      const poses = cands.map((_, k) => scrapPose(k, t, cues));
      const anchorPose: PoseNow = { x: A0.x, y: A0.y, a: A0.a, lift: 0, sc: 1 };
      // the empty slot: a soft recess the shape of the twins' shared outline
      g.save();
      g.translate(slot[2].x, slot[2].y);
      g.rotate(slot[2].a);
      g.fillStyle = "rgba(20,14,10,0.16)";
      if (candOutline[2]) g.fill(candOutline[2]);
      g.restore();
      drawShadow(g, cuts[anchor.id], anchorPose, c.s, 1);
      drawPiece(g, cuts[anchor.id], anchorPose, 1);
      edgeLight(g, cuts[anchor.id], anchorPose, 0.5);
      // scraps: the one being tried on top
      const zo = [0, 1, 2].sort((a, b) => poses[a].lift - poses[b].lift);
      zo.forEach((k) => drawShadow(g, cuts[cands[k].id], poses[k], c.s, 1));
      zo.forEach((k) => {
        const tries = [cues.tryA, cues.tryB, cues.tryC];
        const rejected = k < 2 && t > tries[k] + 1.6;
        drawPiece(g, cuts[cands[k].id], poses[k], 1, rejected ? 0.55 : 1);
        edgeLight(g, cuts[cands[k].id], poses[k], 0.5);
      });
      // the shared torn edge, traced in graphite on all three (identical by construction of a stack tear)
      const tieA = smooth(cues.tie - 0.2, cues.tie + 0.4, t) * (1 - smooth(cues.tryA - 0.4, cues.tryA, t));
      if (tieA > 0.01)
        cands.forEach((cd, k) => {
          const ps = poses[k];
          g.save();
          g.translate(ps.x, ps.y);
          g.rotate(ps.a);
          g.globalAlpha = tieA;
          g.strokeStyle = C.ink;
          g.lineWidth = 2.2 / c.s;
          g.lineJoin = "round";
          if (candOutline[k]) g.stroke(candOutline[k]);
          g.restore();
        });
      // red pencil strikes on the scraps that make no words
      [0, 1].forEach((k) => {
        const tries = [cues.tryA, cues.tryB];
        const s0 = tries[k] + 0.55;
        const pr = clamp((t - s0) / 0.22);
        if (pr <= 0) return;
        const ps = poses[k];
        const r = cands[k].piece.r * 0.62;
        g.save();
        g.translate(ps.x, ps.y);
        g.strokeStyle = C.red;
        g.lineCap = "round";
        g.lineWidth = 7 / c.s;
        g.globalAlpha = 0.9;
        g.beginPath();
        g.moveTo(-r, r * 0.55);
        g.lineTo(-r + 2 * r * pr, r * 0.55 - 1.1 * r * pr);
        g.stroke();
        g.restore();
      });
      if (debug) {
        setCam(g, c);
        g.lineWidth = 1 / c.s;
        for (let x = Math.floor((A0.x - 1200) / 50) * 50; x < A0.x + 1600; x += 50) {
          g.strokeStyle = x % 200 === 0 ? "rgba(255,0,0,0.8)" : "rgba(255,0,0,0.25)";
          g.beginPath();
          g.moveTo(x, A0.y - 900);
          g.lineTo(x, A0.y + 1400);
          g.stroke();
          if (x % 200 === 0) {
            g.fillStyle = "red";
            g.font = `${14 / c.s}px monospace`;
            g.fillText(String(x), x + 2 / c.s, A0.y - 300);
          }
        }
        for (let y = Math.floor((A0.y - 900) / 50) * 50; y < A0.y + 1400; y += 50) {
          g.strokeStyle = y % 200 === 0 ? "rgba(0,0,255,0.8)" : "rgba(0,0,255,0.25)";
          g.beginPath();
          g.moveTo(A0.x - 1200, y);
          g.lineTo(A0.x + 1600, y);
          g.stroke();
          if (y % 200 === 0) {
            g.fillStyle = "blue";
            g.font = `${14 / c.s}px monospace`;
            g.fillText(String(y), A0.x - 500, y - 2 / c.s);
          }
        }
      }
      // the words complete: violet rings on the real pixels where the tear cuts them
      const ringA = smooth(cues.verdict - 0.05, cues.verdict + 0.3, t);
      if (ringA > 0.01) {
        setCam(g, c);
        RINGS.forEach(([rx, ry], i) => {
          const k = clamp((t - cues.verdict - i * 0.12) / 0.35);
          g.save();
          g.globalAlpha = ringA;
          g.strokeStyle = C.violet;
          g.lineWidth = 3.2 / c.s;
          g.beginPath();
          g.arc(rx, ry, (22 + 10 * (1 - k)) , -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
          g.stroke();
          g.restore();
        });
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      grain(g, imgs["fx/grain.png"], frame, 0.09);
      void anchorOutline;
    },
    [imgs, cuts, camAt, cues, debug],
  );

  const t = useCurrentFrame() / FPS;
  const verdictA = easeOut(clamp((t - cues.verdict) / 0.4));
  const tieA = smooth(cues.tie - 0.2, cues.tie + 0.4, t) * (1 - smooth(cues.tryA - 0.4, cues.tryA, t));
  const cam = camAt(t);
  const scoreLabel = cands.map((cd) => Math.round(cd.score)).join(" · ");
  const [w0, w1] = numbers.twins.words.map((w) => w.split("|"));
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <FrameCanvas draw={draw} ready={!!cuts} />
      {/* scrap tags A B C, riding on the scraps in the row */}
      {cands.map((cd, k) => {
        const ps = scrapPose(k, t, cues);
        const [sx, sy] = w2s(cam, ps.x, ps.y + cd.piece.r * 0.62);
        const a = smooth(cues.fan + 0.4, cues.fan + 1.0, t) * (1 - smooth(cues.verdict + 2.4, cues.verdict + 3, t));
        const rejected = k < 2 && t > [cues.tryA, cues.tryB][k] + 0.6;
        return (
          <div key={cd.key} style={{ position: "absolute", left: sx, top: sy, transform: "translate(-50%, 0)", opacity: a, fontFamily: F.sans, fontWeight: 700, fontSize: 26, width: 44, height: 44, borderRadius: 22, display: "grid", placeItems: "center", color: C.chalk, background: rejected ? C.red : k === 2 && t > cues.verdict ? C.violet : "rgba(42,46,52,0.92)", boxShadow: "0 4px 14px rgba(20,14,10,0.35)" }}>
            {cd.key}
          </div>
        );
      })}
      {tieA > 0.01 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 438, textAlign: "center", opacity: tieA, fontFamily: F.serif, fontWeight: 500, fontSize: 40, color: C.chalk, textShadow: "0 2px 12px rgba(20,14,10,0.6)" }}>
          Shape: three alike. <span style={{ color: C.chalk2 }}>Edge fit {scoreLabel}, a tie.</span>
        </div>
      )}
      {verdictA > 0.01 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 104, textAlign: "center", opacity: verdictA }}>
          <div style={{ fontFamily: F.serif, fontWeight: 500, fontSize: 64, color: C.chalk }}>
            Only C makes words:{" "}
            <span style={{ color: C.violetLt }}>
              {w0[0]}
              <i style={{ display: "inline-block", width: 5, height: "0.8em", background: C.violetLt, margin: "0 6px", verticalAlign: "-0.06em", borderRadius: 1 }} />
              {w0[1]}
            </span>
            ,{" "}
            <span style={{ color: C.violetLt }}>
              {w1[0]}
              <i style={{ display: "inline-block", width: 5, height: "0.8em", background: C.violetLt, margin: "0 6px", verticalAlign: "-0.06em", borderRadius: 1 }} />
              {w1[1]}
            </span>
            .
          </div>
          <div style={{ margin: "14px auto 0", maxWidth: 1180, fontFamily: F.mono, fontSize: 22, lineHeight: 1.45, color: C.chalk2, opacity: smooth(cues.verdict + 0.6, cues.verdict + 1.1, t) }}>
            Muse Spark: C, confidence {twins.confidence}. “{numbers.twins.reason.replace(/ with aligned baselines\.$/, "…")}”
          </div>
        </div>
      )}
      <Label t={t} t0={1.0} x={96} y={40}>
        Simulated stack tear of three real letters, recorded run. In this run's 22 stack reads, Muse picked the true neighbour 22 times; chance is 1 in 3.
      </Label>
    </AbsoluteFill>
  );
};
