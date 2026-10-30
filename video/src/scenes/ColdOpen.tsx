// 0:00 Cold open: one continuous camera move on the light table, built from the recorded run's real data.
// Macro on a torn edge of the real photo -> pull back to the whole photo -> SAM 3.1's outlines draw on in graphite ->
// the desk drops away and the paper lifts -> the pieces turn to the solver's true angles and fly home in the product's
// order, each on an arc with a slight bank, settling with the app's heavy spring -> Muse's read lights violet across
// one tear ("hope") -> the torn "Untorn" wordmark slides together as the last piece seats.

import React, { useCallback, useMemo } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import cutMeta from "../data/cutouts-fdr.json";
import scene from "../data/scene-fdr-1927.json";
import { FrameCanvas, depthOfField, grain, type DrawFn } from "../lib/canvas";
import { useImages } from "../lib/images";
import { clamp, easeIO, lerp, noise1, settle, smooth, smoother, spring } from "../lib/motion";
import { camZoomPath, drawPiece, drawShadow, edgeLight, fit, lightTable, polyLength, polyPath, linePath, room, setCam, w2s, type Cam, type Cut, type CutMeta, type PoseNow } from "../lib/paper";
import { C, F, FPS, H, W } from "../theme";
import { TornWord } from "../components/TornWord";
import { Label } from "../components/Label";

const KIT = "kit/fdr";
type SP = (typeof scene.pieces)[number];
type SS = (typeof scene.seams)[number];

/** The beat sheet (seconds). */
export const CO = {
  pull0: 1.0,
  pull1: 4.3,
  trace0: 3.75,
  traceDur: 0.62,
  traceStag: 0.11,
  lift0: 5.75,
  lift1: 6.25,
  exp0: 6.15,
  exp1: 7.05,
  fly0: 7.05,
  flyStep: 0.29,
  fly: 0.95,
  word: 0, // set below: when "hope" reads
  title0: 9.7,
  end: 12.0,
  // the pull-apart into the next scene: the page opens along its seams and the room gives way to what lies behind
  exit0: 12.0,
  exit1: 13.4,
};

const pieces = scene.pieces as SP[];
const seams = scene.seams as SS[];
// the product's order (a spanning tree from the strongest clue), with the two pieces whose seam reads "hope" first
const byIdx = (id: string) => (scene.pieces as SP[]).findIndex((p) => p.id === id);
const FIRST = [byIdx("p1"), byIdx("p0")];
const order = [...FIRST, ...scene.order.map((o) => o.piece).filter((p) => !FIRST.includes(p))];
const orderIdx: Record<number, number> = {};
order.forEach((p, i) => (orderIdx[p] = i));
const LAST = order[order.length - 1];
const stepT = (i: number) => CO.fly0 + i * CO.flyStep;
const landT = (pi: number) => stepT(orderIdx[pi]) + CO.fly * 0.62;

// the read the cold open lands on: "hope", across the tear between p0 and p1
const HOPE = seams.find((s) => s.read?.word === "hope")!;
CO.word = Math.max(landT(HOPE.a), landT(HOPE.b)) + 0.1;

const [PX0, PY0, PX1, PY1] = scene.pagesBox;
const PCX = (PX0 + PX1) / 2;
const PCY = (PY0 + PY1) / 2;
const K = (PX1 - PX0) / 820;

// exploded positions: out from the page centre, like the app's assembly drawing (a little tighter for the frame)
const EX = pieces.map((p) => {
  const vx = p.home[0] - PCX;
  const vy = p.home[1] - PCY;
  const vl = Math.hypot(vx, vy) || 1;
  return [p.home[0] + vx * 0.34 + (vx / vl) * 52 * K, p.home[1] + vy * 0.34 + (vy / vl) * 52 * K] as [number, number];
});

function poseAt(p: SP, t: number): PoseNow & { home: number; k: number } {
  const ps = poseHome(p, t);
  const e = smoother(CO.exit0, CO.exit1, t);
  if (e <= 0 || !p.placed) return ps;
  const vx = p.home[0] - PCX;
  const vy = p.home[1] - PCY;
  const vl = Math.hypot(vx, vy) || 1;
  const k = 2.6 * e * e;
  return { ...ps, x: ps.x + (vx * 0.42 + (vx / vl) * 60 * K) * k, y: ps.y + (vy * 0.42 + (vy / vl) * 60 * K) * k, a: ps.a + 0.05 * e * Math.sign(vx || 1), lift: Math.max(ps.lift, Math.min(1, e * 1.6)), sc: 1 + 0.022 * Math.min(1, e * 1.6) };
}

function poseHome(p: SP, t: number): PoseNow & { home: number; k: number } {
  const i = orderIdx[p.i];
  if (t <= CO.exp0) return { x: p.c[0], y: p.c[1], a: 0, lift: smooth(CO.lift0, CO.lift1, t), sc: 1, home: 0, k: 0 };
  const ts = stepT(i);
  const [ex, ey] = EX[p.i];
  if (t < ts) {
    const st = CO.exp0 + (i % 5) * 0.045;
    const u = clamp((t - st) / (CO.exp1 - CO.exp0 - 0.18));
    const up = easeIO(u);
    const ua = easeIO(clamp(u * 1.15));
    const dx = ex - p.c[0];
    const dy = ey - p.c[1];
    const dd = Math.hypot(dx, dy) || 1;
    const arc = Math.sin(Math.PI * up) * Math.min(90 * K, dd * 0.12);
    return { x: lerp(p.c[0], ex, up) + (dy / dd) * arc, y: lerp(p.c[1], ey, up) - Math.abs(dx / dd) * arc, a: lerp(0, p.ang, ua), lift: 1, sc: 1 + 0.022, bank: Math.sin(Math.PI * up) * 0.5 * Math.sign(dx || 1), home: 0, k: 0 };
  }
  const e = t - ts;
  const k = spring(e);
  const dd = Math.hypot(p.home[0] - ex, p.home[1] - ey);
  const arc = Math.sin(Math.PI * clamp(k)) * Math.min(60 * K, dd * 0.16);
  const dir = Math.sign(p.home[0] - ex || 1);
  const lift = 1 - smooth(0.25, 0.75, e / CO.fly);
  return {
    x: lerp(ex, p.home[0], k),
    y: lerp(ey, p.home[1], k) - arc,
    a: p.ang + 0.035 * settle(e - 0.42) + 0.04 * Math.sin(Math.PI * clamp(k)) * dir,
    lift,
    sc: 1 + 0.022 * lift,
    bank: Math.sin(Math.PI * clamp(k)) * 0.45 * dir * lift,
    home: smooth(0.55, 0.9, e / CO.fly),
    k,
  };
}

/* ---------------- the camera: one continuous move ---------------- */
const FRAME = { x: 0, y: 0, w: W, h: H };
const allBox = (() => {
  const xs = pieces.flatMap((p) => [p.bbox[0], p.bbox[2]]);
  const ys = pieces.flatMap((p) => [p.bbox[1], p.bbox[3]]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
})();
const explBox = (() => {
  const xs: number[] = [];
  const ys: number[] = [];
  pieces.forEach((p, i) => {
    xs.push(EX[i][0] - p.r * 0.8, EX[i][0] + p.r * 0.8);
    ys.push(EX[i][1] - p.r * 0.8, EX[i][1] + p.r * 0.8);
  });
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
})();

// the macro: the torn edge of p0 where "hope" will read, in the photo (p0 lies where SAM found it)
const hopeOnP0 = (() => {
  const p = pieces[HOPE.a];
  // the seam's point (page coords) back into the photo: photo = c + R(-ang) (world - home)
  const [mx, my] = HOPE.mid;
  const dx = mx - p.home[0];
  const dy = my - p.home[1];
  const c = Math.cos(-p.ang);
  const s = Math.sin(-p.ang);
  return [p.c[0] + c * dx - s * dy, p.c[1] + s * dx + c * dy] as [number, number];
})();

const CAM = {
  macroA: { s: 2.25, wx: hopeOnP0[0] - 40, wy: hopeOnP0[1] + 10, sx: W * 0.5, sy: H * 0.47 } as Cam,
  macroB: { s: 2.05, wx: hopeOnP0[0] + 30, wy: hopeOnP0[1] - 12, sx: W * 0.5, sy: H * 0.47 } as Cam,
  photo: fit(allBox, FRAME, 36),
  expl: fit(explBox, { x: W * 0.3, y: 0, w: W * 0.7, h: H }, 40),
  final: fit({ x0: PX0 - 120, y0: PY0 - 90, x1: PX1 + 120, y1: PY1 + 90 }, { x: W * 0.36, y: 0, w: W * 0.6, h: H }, 0),
};
CAM.photo = { ...CAM.photo, s: CAM.photo.s * 1.0 };
const CAM_END = { ...CAM.final, s: CAM.final.s * 1.045, sy: CAM.final.sy - 6 };

function camAt(t: number): Cam {
  // drift: a breath of handheld-free motion so the frame is never dead still
  const drift = (c: Cam, amp: number): Cam => ({ ...c, sx: c.sx + noise1(t * 0.35, 1) * amp, sy: c.sy + noise1(t * 0.31, 2) * amp * 0.6 });
  if (t < CO.pull0) return drift(camZoomPath(CAM.macroA, CAM.macroB, smoother(0, CO.pull0 + 0.6, t)), 2);
  if (t < CO.pull1) {
    const from = camZoomPath(CAM.macroA, CAM.macroB, smoother(0, CO.pull0 + 0.6, t));
    return drift(camZoomPath(from, CAM.photo, smoother(CO.pull0, CO.pull1, t)), 2);
  }
  if (t < CO.exp0) return drift(CAM.photo, 3);
  if (t < CO.fly0 + 0.5) return drift(camZoomPath(CAM.photo, CAM.expl, smoother(CO.exp0 - 0.1, CO.fly0 + 0.5, t)), 3);
  const lastSeat = stepT(order.length - 1) + CO.fly;
  if (t < lastSeat + 0.2) return drift(camZoomPath(CAM.expl, CAM.final, smoother(CO.fly0 + 0.5, lastSeat + 0.2, t)), 2.5);
  const settled = camZoomPath(CAM.final, CAM_END, smoother(lastSeat + 0.2, CO.end + 1.2, t));
  const e = smoother(CO.exit0, CO.exit1, t);
  if (e <= 0) return drift(settled, 2);
  return drift({ ...settled, s: settled.s * (1 + 1.25 * e * e), wx: lerp(settled.wx, PCX, e), wy: lerp(settled.wy, PCY, e), sx: lerp(settled.sx, W / 2, e) }, 2);
}

/* ---------------- drawing ---------------- */
const paths = [
  `${KIT}/photo.jpg`,
  "fx/grain.png",
  ...pieces.flatMap((p) => ["lit", "plain", "edge", "shadow", "contact"].map((k) => `${KIT}/${p.id}-${k}.png`)),
];
const outlinePaths = typeof Path2D === "undefined" ? [] : pieces.map((p) => polyPath(p.poly));
const outlineLen = pieces.map((p) => polyLength(p.poly));
const seamPaths = typeof Path2D === "undefined" ? [] : seams.map((s) => linePath(s.line));
const seamLen = seams.map((s) => polyLength(s.line, false));

/** Film time to the cold open's own time: piecewise linear through [film, own] pairs (beats moved onto the voice). */
export function warpTime(t: number, warp?: [number, number][]) {
  if (!warp || warp.length < 2) return t;
  if (t <= warp[0][0]) return warp[0][1] + (t - warp[0][0]);
  for (let i = 1; i < warp.length; i++) if (t <= warp[i][0]) return lerp(warp[i - 1][1], warp[i][1], (t - warp[i - 1][0]) / (warp[i][0] - warp[i - 1][0]));
  const [a, b] = warp[warp.length - 1];
  return b + (t - a);
}

export const ColdOpen: React.FC<{ warp?: [number, number][] }> = ({ warp }) => {
  const imgs = useImages(paths);
  const cuts = useMemo(() => {
    if (!imgs) return null;
    const m: Record<string, Cut> = {};
    for (const p of pieces) {
      const meta = (cutMeta as unknown as Record<string, CutMeta>)[p.id];
      m[p.id] = { ...meta, lit: imgs[`${KIT}/${p.id}-lit.png`], plain: imgs[`${KIT}/${p.id}-plain.png`], edge: imgs[`${KIT}/${p.id}-edge.png`], shadow: imgs[`${KIT}/${p.id}-shadow.png`], contact: imgs[`${KIT}/${p.id}-contact.png`] };
    }
    return m;
  }, [imgs]);

  const draw = useCallback<DrawFn>(
    (out, tf, frame, scratch) => {
      if (!imgs || !cuts) return;
      const t = warpTime(tf, warp);
      const g = scratch.a.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      const ex = smoother(CO.exit0, CO.exit1, t);
      const bgA = 1 - smooth(0.05, 0.6, ex);
      g.clearRect(0, 0, W, H);
      if (bgA > 0.001) {
        g.globalAlpha = bgA;
        room(g, W, H);
        g.globalAlpha = 1;
      }
      const c = camAt(t);
      const poses = pieces.map((p) => poseAt(p, t));
      const lit = smooth(CO.lift0, CO.lift1 + 0.15, t);
      const photoA = 1 - smooth(CO.lift0, CO.lift1, t);
      const shadowA = smooth(CO.lift0 + 0.1, CO.lift1, t);

      // the light table comes up under the paper as the desk drops away
      const [lx, ly] = w2s(c, lerp((allBox.x0 + allBox.x1) / 2, PCX, smooth(CO.exp0, CO.fly0 + 1, t)), lerp((allBox.y0 + allBox.y1) / 2, PCY, smooth(CO.exp0, CO.fly0 + 1, t)));
      lightTable(g, lx, ly, Math.max(W, H) * 0.62 * clamp(c.s / CAM.final.s, 0.6, 1.6), smooth(CO.lift0, CO.lift1 + 0.4, t) * bgA);

      // the photo of the desk, then the paper over it
      setCam(g, c);
      if (photoA > 0.002) {
        g.globalAlpha = photoA;
        g.drawImage(imgs[`${KIT}/photo.jpg`], 0, 0, scene.photo.width, scene.photo.height);
        const PW = scene.photo.width;
        const PH = scene.photo.height;
        const fe = 150;
        const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
          const gr = g.createLinearGradient(x0, y0, x1, y1);
          gr.addColorStop(0, "rgba(51,44,39,1)");
          gr.addColorStop(1, "rgba(51,44,39,0)");
          g.fillStyle = gr;
          g.fillRect(rx, ry, rw, rh);
        };
        edge(0, 0, fe, 0, -2, -2, fe + 2, PH + 4);
        edge(PW, 0, PW - fe, 0, PW - fe, -2, fe + 2, PH + 4);
        edge(0, 0, 0, fe, -2, -2, PW + 4, fe + 2);
        edge(0, PH, 0, PH - fe, -2, PH - fe, PW + 4, fe + 2);
        g.globalAlpha = 1;
      }
      const z = pieces.map((_, i) => i).sort((a, b) => poses[a].lift - poses[b].lift || (orderIdx[a] ?? 0) - (orderIdx[b] ?? 0));
      if (shadowA > 0) z.forEach((i) => drawShadow(g, cuts[pieces[i].id], poses[i], c.s, shadowA * (1 - smooth(0.3, 0.8, ex))));
      // the plain exposure sits exactly on the photo, so before the lift it is invisible: draw only once lifting
      const paperA = 1 - smooth(0.55, 0.95, ex);
      if (t > CO.lift0 - 0.05) z.forEach((i) => drawPiece(g, cuts[pieces[i].id], poses[i], lit, paperA));
      if (lit > 0.02) z.forEach((i) => edgeLight(g, cuts[pieces[i].id], poses[i], lit * 0.55 * (1 - smooth(0.2, 0.8, ex))));

      // SAM 3.1's outlines: traced on the photo in graphite with a paper-white halo, then handed over to the paper
      const outA = 1 - smooth(CO.exp1 - 0.5, CO.exp1 + 0.3, t);
      if (outA > 0.01)
        pieces.forEach((p, i) => {
          const pr = clamp((t - (CO.trace0 + i * CO.traceStag)) / CO.traceDur);
          if (pr <= 0) return;
          const ps = poses[i];
          g.save();
          g.translate(ps.x, ps.y);
          g.rotate(ps.a);
          g.scale(ps.sc, ps.sc);
          g.globalAlpha = outA;
          g.lineJoin = "round";
          g.lineCap = "round";
          g.setLineDash(pr < 1 ? [outlineLen[i] * pr, outlineLen[i]] : []);
          g.strokeStyle = "rgba(250,246,238,0.92)";
          g.lineWidth = 6.5 / c.s;
          g.stroke(outlinePaths[i]);
          g.strokeStyle = C.ink;
          g.lineWidth = 2.6 / c.s;
          g.stroke(outlinePaths[i]);
          g.restore();
        });
      g.setLineDash([]);

      // seams as the pieces land: violet where Muse read across, graphite where the edge alone decided
      seams.forEach((s, i) => {
        if (!s.line.length) return;
        const land = Math.max(landT(s.a), landT(s.b));
        const pr = clamp((t - land) / 0.45);
        if (pr <= 0) return;
        g.save();
        g.setLineDash(pr < 1 ? [seamLen[i] * pr, seamLen[i]] : []);
        if (s.read) {
          g.strokeStyle = C.violet;
          g.lineWidth = (s === HOPE ? 2.6 : 1.8) / c.s;
          g.globalAlpha = 0.95 * (1 - smooth(0, 0.25, ex));
        } else {
          g.strokeStyle = C.ink;
          g.lineWidth = 0.9 / c.s;
          g.globalAlpha = 0.35 * (1 - smooth(0, 0.25, ex));
        }
        g.stroke(seamPaths[i]);
        g.restore();
      });

      // balloons: numbered once while SAM finds the pieces, then gone
      g.setTransform(1, 0, 0, 1, 0, 0);
      const bc = { x: (allBox.x0 + allBox.x1) / 2, y: (allBox.y0 + allBox.y1) / 2 };
      pieces.forEach((p, i) => {
        const done = CO.trace0 + i * CO.traceStag + CO.traceDur;
        const a = smooth(done - 0.1, done + 0.2, t) * (1 - smooth(CO.lift0 - 0.2, CO.lift0 + 0.3, t));
        if (a < 0.01) return;
        const [sx, sy] = w2s(c, poses[i].x, poses[i].y);
        let dx = poses[i].x - bc.x;
        let dy = poses[i].y - bc.y;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        const off = p.r * c.s * 0.42 + 26;
        const bx = clamp(sx + dx * off, 30, W - 30);
        const by = clamp(sy + dy * off, 30, H - 30);
        const pop = 1 + 0.25 * Math.exp(-9 * Math.max(0, t - done)) * Math.sin(Math.max(0, t - done) * 14);
        g.globalAlpha = a;
        g.strokeStyle = C.ink;
        g.lineWidth = 1.3;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(bx - dx * 19, by - dy * 19);
        g.stroke();
        g.fillStyle = C.ink;
        g.beginPath();
        g.arc(sx, sy, 3, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(bx, by, 19 * pop, 0, Math.PI * 2);
        g.fillStyle = C.filmHi;
        g.fill();
        g.lineWidth = 1.4;
        g.strokeStyle = C.ink;
        g.stroke();
        g.fillStyle = C.ink;
        g.font = `600 19px ${F.sans}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(p.k), bx, by + 0.5);
        g.globalAlpha = 1;
      });

      // the lens: shallow focus in macro, opening up as the camera pulls back (never over the word being read)
      const dof = clamp((c.s - 0.55) / 1.6) * 7;
      out.setTransform(1, 0, 0, 1, 0, 0);
      depthOfField(out, scratch, scratch.a, W * 0.5, H * 0.47, W * 0.42, H * 0.46, dof);
      grain(out, imgs["fx/grain.png"], frame, 0.09 * bgA);
    },
    [imgs, cuts, warp],
  );

  const frame = useCurrentFrame();
  const t = warpTime(frame / FPS, warp);
  const exitA = 1 - smooth(CO.exit0 - 0.1, CO.exit0 + 0.5, t);
  const c = camAt(t);
  // the read word sits just off the seam, in the paper's own space
  const [wx, wy] = w2s(c, HOPE.mid[0], HOPE.mid[1]);
  const wordA = smooth(CO.word, CO.word + 0.35, t) * (1 - smooth(CO.word + 1.7, CO.word + 2.15, t)) * exitA;
  const lastSeat = stepT(order.length - 1) + CO.fly * 0.62;
  return (
    <AbsoluteFill>
      <FrameCanvas draw={draw} ready={!!cuts} />
      {wordA > 0.01 && (
        <div
          style={{
            position: "absolute",
            left: wx,
            top: wy - 84 - 10 * (1 - easeIO(clamp((t - CO.word) / 0.5))),
            transform: "translateX(-50%)",
            opacity: wordA,
            fontFamily: F.serif,
            fontWeight: 500,
            fontSize: 58,
            letterSpacing: "-0.01em",
            color: C.violet,
            textShadow: `0 0 2px ${C.filmHi}, 0 0 10px rgba(250,252,254,0.95), 0 0 22px rgba(250,252,254,0.8)`,
          }}
        >
          hope
        </div>
      )}
      <div style={{ opacity: exitA }}>
        <TornWord text="Untorn" t={t} t0={CO.title0} seat={lastSeat} x={150} y={392} size={176} />
        <Label t={t} t0={4.4} x={110} y={40}>
          Simulated tear of a real 1927 letter, recorded run.
        </Label>
      </div>
    </AbsoluteFill>
  );
};
