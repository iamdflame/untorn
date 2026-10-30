// Placement against the replica's ground truth: every cell's exact page → photo pose is known (shred.ts), so each
// segmented piece can be matched to its cell, and every pair of pieces on a rebuilt page compared with the truth.

import type { SegmentedFragment } from "../../../src/lib/rejoin/adapters";
import { poseApply, poseCompose, poseInvert, wrapAngle, type Pose } from "../../../src/lib/rejoin/geom";
import type { ShredTruth } from "../../bench/shredbench/shred";

export type PlacedPage = { fragments: { id: string; pose: Pose }[] };

/** Mask centroid of a segmented piece, in photo pixels. */
function centroid(f: SegmentedFragment): [number, number] {
  const { x, y, width, height, data } = f.mask;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!data[r * width + c]) continue;
      sx += x + c + 0.5;
      sy += y + r + 0.5;
      n++;
    }
  }
  return n ? [sx / n, sy / n] : [x, y];
}

/**
 * How many pieces sit where they belong: on each rebuilt page, the largest set of pieces whose relative poses all
 * agree with the truth (within tolPx at the piece's centroid and tolDeg), summed over the page holding most of them.
 * Pieces off that page count as not placed, even when a smaller group is right among itself.
 */
export function placementScore(truth: ShredTruth, segs: SegmentedFragment[], pages: PlacedPage[], tolPx = 20, tolDeg = 2): number {
  const s = truth.scale;
  // the cell under each piece: the one whose centre (the photo position of its page centroid) is nearest
  const cellOf = new Map<string, number>();
  const centreOf = new Map<string, [number, number]>();
  for (const f of segs) {
    const c = centroid(f);
    centreOf.set(f.id, c);
    let best = -1;
    let bd = Infinity;
    truth.cells.forEach((cell, k) => {
      const d = Math.hypot(cell.centre[0] - c[0], cell.centre[1] - c[1]);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    if (best >= 0 && bd < 0.5 * s * Math.sqrt(truth.cells[best].area)) cellOf.set(f.id, best);
  }
  // true map from one piece's photo frame to another's: photo_i = T_i(page), T(page) = s R(θ)(page − c) + centre
  const T = (k: number): Pose & { s: number } => {
    const cell = truth.cells[k];
    const cs = Math.cos(cell.theta);
    const sn = Math.sin(cell.theta);
    return { theta: cell.theta, tx: cell.centre[0] - s * (cs * cell.centroid[0] - sn * cell.centroid[1]), ty: cell.centre[1] - s * (sn * cell.centroid[0] + cs * cell.centroid[1]), s };
  };
  const trueRel = (i: number, j: number) => {
    // photo_j → page → photo_i; the scales cancel, so the composition is rigid
    const Ti = T(i);
    const Tj = T(j);
    return (x: number, y: number): [number, number] => {
      const dx = (x - Tj.tx) / s;
      const dy = (y - Tj.ty) / s;
      const cj = Math.cos(-Tj.theta);
      const sj = Math.sin(-Tj.theta);
      const px = cj * dx - sj * dy;
      const py = sj * dx + cj * dy;
      const ci = Math.cos(Ti.theta);
      const si = Math.sin(Ti.theta);
      return [s * (ci * px - si * py) + Ti.tx, s * (si * px + ci * py) + Ti.ty];
    };
  };
  let best = 0;
  for (const p of pages) {
    const ids = p.fragments.map((f) => f.id).filter((id) => cellOf.has(id));
    const pose = new Map(p.fragments.map((f) => [f.id, f.pose] as const));
    const agree = (a: string, b: string) => {
      const rel = poseCompose(poseInvert(pose.get(a)!), pose.get(b)!);
      const [cx, cy] = centreOf.get(b)!;
      const [x1, y1] = poseApply(rel, cx, cy);
      const [x2, y2] = trueRel(cellOf.get(a)!, cellOf.get(b)!)(cx, cy);
      const ti = truth.cells[cellOf.get(a)!].theta;
      const tj = truth.cells[cellOf.get(b)!].theta;
      return Math.hypot(x1 - x2, y1 - y2) <= tolPx && Math.abs(wrapAngle(rel.theta - (ti - tj))) <= (tolDeg * Math.PI) / 180;
    };
    for (const r of ids) best = Math.max(best, ids.filter((j) => j === r || agree(r, j)).length);
  }
  return best;
}
