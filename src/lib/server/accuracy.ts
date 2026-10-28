// Score a run against a sample's answer key (true piece poses, photo → page): the hourly health run asserts the
// join accuracy on the fixed sample stays where it was.

import { poseApply, poseCompose, poseInvert, type Pose } from "@/lib/rejoin/geom";
import type { RunResult } from "@/lib/run/types";

export type AnswerKey = { pieces: { piece: number; page: number; pose: Pose; photoPolygon: [number, number][] }[] };

export type RunScore = {
  pieces: number;
  /** Result pieces matched to a true piece. */
  matched: number;
  joins: number;
  correctJoins: number;
  joinAccuracy: number;
  /** The largest group of pieces placed consistently with the truth on one page. */
  placedCorrectly: number;
};

function inside(p: [number, number], poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const centroid = (poly: [number, number][]): [number, number] => {
  let x = 0;
  let y = 0;
  for (const [a, b] of poly) {
    x += a;
    y += b;
  }
  return [x / poly.length, y / poly.length];
};

/** The key piece that covers most of a result piece (grid samples inside both outlines). */
function bestOverlap<K extends { photoPolygon: [number, number][] }>(poly: [number, number][], keys: K[]): K | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const counts = new Array(keys.length).fill(0);
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const q: [number, number] = [x0 + ((i + 0.5) / 24) * (x1 - x0), y0 + ((j + 0.5) / 24) * (y1 - y0)];
      if (!inside(q, poly)) continue;
      keys.forEach((k, n) => {
        if (inside(q, k.photoPolygon)) counts[n]++;
      });
    }
  }
  let best = -1;
  counts.forEach((c, n) => {
    if (c > 0 && (best < 0 || c > counts[best])) best = n;
  });
  return best >= 0 ? keys[best] : null;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Do two relative poses (b's photo frame into a's) agree within px / degrees at point q? */
function agree(r1: Pose, r2: Pose, q: [number, number], px: number, deg: number): boolean {
  const [x1, y1] = poseApply(r1, q[0], q[1]);
  const [x2, y2] = poseApply(r2, q[0], q[1]);
  return Math.hypot(x1 - x2, y1 - y2) <= px && Math.abs(wrap(r1.theta - r2.theta)) <= (deg * Math.PI) / 180;
}

export function scoreRun(result: RunResult, key: AnswerKey, tol = { px: 6, deg: 2 }): RunScore {
  const truth = new Map<string, { pose: Pose; c: [number, number] }>();
  for (const p of result.pieces) {
    const k = bestOverlap(p.polygon, key.pieces);
    if (k) truth.set(p.id, { pose: k.pose, c: centroid(p.polygon) });
  }
  const placedPose = new Map<string, Pose>();
  for (const page of result.pages) for (const f of page.pieces) placedPose.set(f.id, f.pose);
  const rel = (pa: Pose, pb: Pose) => poseCompose(poseInvert(pa), pb);

  let correct = 0;
  for (const j of result.joins) {
    const ta = truth.get(j.a);
    const tb = truth.get(j.b);
    const pa = placedPose.get(j.a);
    const pb = placedPose.get(j.b);
    if (!ta || !tb || !pa || !pb) continue;
    if (agree(rel(pa, pb), rel(ta.pose, tb.pose), tb.c, tol.px, tol.deg)) correct++;
  }

  let best = 0;
  for (const page of result.pages) {
    for (const ref of page.pieces) {
      const tr = truth.get(ref.id);
      if (!tr) continue;
      let n = 0;
      for (const f of page.pieces) {
        const tf = truth.get(f.id);
        if (tf && agree(rel(ref.pose, f.pose), rel(tr.pose, tf.pose), tf.c, tol.px * 2, tol.deg)) n++;
      }
      best = Math.max(best, n);
    }
  }
  return {
    pieces: result.pieces.length,
    matched: truth.size,
    joins: result.joins.length,
    correctJoins: correct,
    joinAccuracy: result.joins.length ? correct / result.joins.length : 0,
    placedCorrectly: best,
  };
}
