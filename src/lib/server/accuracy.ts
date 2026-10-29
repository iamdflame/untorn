// Score a run against a sample's answer key (true piece poses, photo → page): the hourly health run asserts the
// join accuracy on the fixed sample stays where it was.

import { fitRigid, poseApply, poseCompose, poseInvert, type Pose } from "@/lib/rejoin/geom";
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

// ── Detailed scoring against a generator's ground truth (scripts/score-sample.ts) ─────────────────────────────

/** The tear generator's ground truth (scripts/gen/tear.py): each piece's polygon on its page and in the photo. */
export type TearTruth = {
  page_size: [number, number];
  pieces: { page: number; piece: number; page_polygon: [number, number][]; photo_polygon: [number, number][] }[];
};

/** Answer key from generator truth: the rigid pose photo → page of each piece (its two polygons share vertices). */
export function answerKeyFromTruth(gt: TearTruth): AnswerKey {
  return {
    pieces: gt.pieces.map((p) => {
      const n = Math.min(p.page_polygon.length, p.photo_polygon.length);
      const a = new Float64Array(2 * n);
      const b = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        a.set(p.photo_polygon[i], 2 * i);
        b.set(p.page_polygon[i], 2 * i);
      }
      return { piece: p.piece, page: p.page, pose: fitRigid(a, b).pose, photoPolygon: p.photo_polygon };
    }),
  };
}

export type DetailedScore = {
  pieces: { found: number; truth: number; matched: number; duplicates: number };
  /** Per true page: pieces placed correctly (the largest group consistent with the truth), pieces split off into a
   *  second correct group, and the page's total. */
  pages: { page: number; pieces: number; placedCorrectly: number; splitOff: number }[];
  placedCorrectly: number;
  splitOff: number;
  /** Placed pieces that sit on a rebuilt page in a way the truth contradicts (wrong page or wrong pose). */
  misplaced: { id: string; truePage: number | null; resultPage: string }[];
  unplaced: number;
  joins: { total: number; correct: number; byClue: Record<string, { total: number; correct: number }> };
  reads: {
    total: number;
    pair: number;
    choice: number;
    failed: number;
    /** Answered with confidence above 0.5 (the solver weighs only these). */
    decisive: number;
    /** Decisive reads that agree with the truth, out of the decisive reads the truth can judge. */
    correct: number;
    judged: number;
  };
  /** Rebuilt page → the true page most of its pieces come from. */
  pageMap: Record<string, number | null>;
};

/** Do two pieces touch on their true page (a shared tear: some vertices within `px`)? */
function touching(p: [number, number][], q: [number, number][], px = 4): boolean {
  for (const [x, y] of p) for (const [u, v] of q) if (Math.abs(x - u) <= px && Math.abs(y - v) <= px) return true;
  return false;
}

export function scoreDetailed(result: RunResult, key: AnswerKey, truth?: TearTruth, tol = { px: 6, deg: 2 }): DetailedScore {
  const keyOf = new Map<string, AnswerKey["pieces"][number]>();
  const centre = new Map<string, [number, number]>();
  const hits = new Map<AnswerKey["pieces"][number], number>();
  for (const p of result.pieces) {
    const k = bestOverlap(p.polygon, key.pieces);
    if (!k) continue;
    keyOf.set(p.id, k);
    centre.set(p.id, centroid(p.polygon));
    hits.set(k, (hits.get(k) ?? 0) + 1);
  }
  const rel = (pa: Pose, pb: Pose) => poseCompose(poseInvert(pa), pb);
  const pageMap: Record<string, number | null> = {};
  const misplaced: DetailedScore["misplaced"] = [];
  const groups: { page: number; size: number }[] = [];
  for (const page of result.pages) {
    const votes = new Map<number, number>();
    for (const f of page.pieces) {
      const k = keyOf.get(f.id);
      if (k) votes.set(k.page, (votes.get(k.page) ?? 0) + 1);
    }
    const major = [...votes].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    pageMap[page.id] = major;
    // the largest group of this page's pieces placed consistently with the truth on the majority page
    let best: string[] = [];
    for (const ref of page.pieces) {
      const kr = keyOf.get(ref.id);
      if (!kr || kr.page !== major) continue;
      const ok = page.pieces.filter((f) => {
        const kf = keyOf.get(f.id);
        return kf && kf.page === major && agree(rel(ref.pose, f.pose), rel(kr.pose, kf.pose), centre.get(f.id)!, tol.px * 2, tol.deg);
      });
      if (ok.length > best.length) best = ok.map((f) => f.id);
    }
    const good = new Set(best);
    for (const f of page.pieces) if (!good.has(f.id)) misplaced.push({ id: f.id, truePage: keyOf.get(f.id)?.page ?? null, resultPage: page.id });
    if (major !== null && best.length) groups.push({ page: major, size: best.length });
  }
  const truePages = [...new Set(key.pieces.map((k) => k.page))].sort((a, b) => a - b);
  const pages = truePages.map((g) => {
    const sizes = groups
      .filter((x) => x.page === g)
      .map((x) => x.size)
      .sort((a, b) => b - a);
    return { page: g, pieces: key.pieces.filter((k) => k.page === g).length, placedCorrectly: sizes[0] ?? 0, splitOff: sizes.slice(1).reduce((s, v) => s + v, 0) };
  });

  const placedPose = new Map<string, Pose>();
  for (const page of result.pages) for (const f of page.pieces) placedPose.set(f.id, f.pose);
  const byClue: DetailedScore["joins"]["byClue"] = {};
  let correctJoins = 0;
  for (const j of result.joins) {
    const ka = keyOf.get(j.a);
    const kb = keyOf.get(j.b);
    const pa = placedPose.get(j.a);
    const pb = placedPose.get(j.b);
    const ok = !!(ka && kb && pa && pb && ka.page === kb.page && agree(rel(pa, pb), rel(ka.pose, kb.pose), centre.get(j.b)!, tol.px, tol.deg));
    const clue = j.loop ? `${j.decidedBy} (loop)` : j.decidedBy;
    const c = (byClue[clue] ??= { total: 0, correct: 0 });
    c.total++;
    if (ok) {
      c.correct++;
      correctJoins++;
    }
  }

  // reads against the truth: a choice is right when it picks the one candidate that touches the anchor on its true
  // page; a pair read is right when "same place" matches whether the two pieces touch on one true page
  const polyOf = (k: AnswerKey["pieces"][number]) => truth?.pieces.find((p) => p.page === k.page && p.piece === k.piece)?.page_polygon ?? null;
  const neighbours = (a: string, b: string): boolean | null => {
    const ka = keyOf.get(a);
    const kb = keyOf.get(b);
    if (!ka || !kb) return null;
    if (ka.page !== kb.page) return false;
    const pa = polyOf(ka);
    const pb = polyOf(kb);
    return pa && pb ? touching(pa, pb) : null;
  };
  let decisive = 0;
  let judged = 0;
  let correct = 0;
  for (const r of result.reads) {
    if (!r.ok || r.confidence <= 0.5) continue;
    if (r.kind === "pair" && r.same !== null) {
      decisive++;
      const t = neighbours(r.pieces[0], r.pieces[1]);
      if (t === null) continue;
      judged++;
      if (t === r.same) correct++;
    } else if (r.kind === "choice" && r.choice !== null) {
      decisive++;
      const truthIdx = r.pieces.slice(1).map((id) => neighbours(r.pieces[0], id));
      if (truthIdx.some((t) => t === null) || truthIdx.filter((t) => t).length !== 1) continue;
      judged++;
      if (truthIdx[r.choice]) correct++;
    }
  }
  return {
    pieces: { found: result.pieces.length, truth: key.pieces.length, matched: keyOf.size, duplicates: [...hits.values()].filter((n) => n > 1).length },
    pages,
    placedCorrectly: pages.reduce((s, p) => s + p.placedCorrectly, 0),
    splitOff: pages.reduce((s, p) => s + p.splitOff, 0),
    misplaced,
    unplaced: result.unplaced.length,
    joins: { total: result.joins.length, correct: correctJoins, byClue },
    reads: {
      total: result.reads.length,
      pair: result.reads.filter((r) => r.kind === "pair").length,
      choice: result.reads.filter((r) => r.kind === "choice").length,
      failed: result.reads.filter((r) => !r.ok).length,
      decisive,
      correct,
      judged,
    },
    pageMap,
  };
}

/** Character error rate: edit distance over the reference length, on whitespace-normalised text (gap marks dropped). */
export function cer(hyp: string, ref: string): number {
  const norm = (s: string) =>
    s
      .replace(/\[…\]|\[\.\.\.\]/g, " ")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(hyp);
  const b = norm(ref);
  if (!b.length) return a.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / b.length;
}
