import { describe, expect, it } from "vitest";
import { analyzeFragment } from "./fragment";
import { poseApply, poseCompose, poseInvert, type Pose } from "./geom";
import { bestRun, matchData, matchFragments, MATCH_DEFAULTS, textSeeds } from "./match";
import { gridTear, scatterPage } from "./__tests__/synth";
import type { Fragment } from "./types";

/** True pose taking fragment b's photo coordinates into fragment a's (poses map page → photo). */
const trueRel = (poses: Pose[], a: number, b: number) => poseCompose(poses[a], poseInvert(poses[b]));

function close(p: Pose, q: Pose, f: Fragment, px = 3, deg = 1) {
  const [x1, y1] = poseApply(p, ...f.centroid);
  const [x2, y2] = poseApply(q, ...f.centroid);
  const dth = Math.abs(Math.atan2(Math.sin(p.theta - q.theta), Math.cos(p.theta - q.theta)));
  return Math.hypot(x1 - x2, y1 - y2) <= px && dth <= (deg * Math.PI) / 180;
}

describe("bestRun", () => {
  it("bridges near points and short misses, and counts only inliers", () => {
    // 1 = inlier, 2 = near (a noise blob), 0 = unmatched
    const inl = Uint8Array.from([0, 1, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0]);
    const run = bestRun(inl, new Uint8Array(inl.length), 15)!;
    expect(run).toEqual([1, 8, 5]);
  });
  it("wraps around the outline", () => {
    const inl = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1, 1, 1]);
    expect(bestRun(inl, new Uint8Array(inl.length), 2)).toEqual([7, 5, 5]);
  });
});

describe("matchFragments on a torn grid", () => {
  const page = gridTear(520, 420, 3, 2, 21);
  const { inputs, poses } = scatterPage(page, 5, { noise: 0.6 });
  const frags = inputs.map((inp, i) => analyzeFragment(inp, i)!);
  const m = matchFragments(frags);
  const idx = (id: string) => Number(id.slice(1));

  it("finds every neighbouring pair with the true pose", () => {
    // 3 × 2 grid: horizontal neighbours (0,1) (1,2) (3,4) (4,5), vertical (0,3) (1,4) (2,5)
    const pairs = [
      [0, 1],
      [1, 2],
      [3, 4],
      [4, 5],
      [0, 3],
      [1, 4],
      [2, 5],
    ];
    for (const [a, b] of pairs) {
      const hit = m.candidates.find((c) => {
        const [ia, ib] = [idx(c.a), idx(c.b)];
        return ((ia === a && ib === b) || (ia === b && ib === a)) && close(c.pose, trueRel(poses, ia, ib), frags[ib]);
      });
      expect(hit, `pair ${a}-${b}`).toBeDefined();
      expect(hit!.fineRms).toBeLessThan(0.9);
    }
  });

  it("ranks true joins first: every unambiguous strong candidate is true", () => {
    const strong = m.candidates.filter((c) => c.margin >= 1.4 && c.score >= 60);
    expect(strong.length).toBeGreaterThanOrEqual(5);
    for (const c of strong) expect(close(c.pose, trueRel(poses, idx(c.a), idx(c.b)), frags[idx(c.b)], 4, 1.5)).toBe(true);
  });

  it("finds no twins on a single page", () => {
    expect(m.twinGroups).toHaveLength(0);
  });
});

describe("text-line seeds and pruning", () => {
  // two neighbours of a page with text lines every 22 px, far apart and turned in the photo
  const page = gridTear(420, 360, 2, 1, 4);
  const { inputs, poses } = scatterPage(page, 9, { noise: 0.5 });
  const frags = inputs.map((inp, i) => analyzeFragment(inp, i)!);

  it("seeds the true join from the lines alone (rotation from the lines, translation by voting)", () => {
    const data = frags.map((f) => matchData(f));
    const seeds = textSeeds(data[0], data[1], MATCH_DEFAULTS);
    expect(seeds.length).toBeGreaterThan(0);
    const truth = trueRel(poses, 0, 1);
    // the best peak lands within a few px and the rotation within the lines' accuracy
    expect(seeds.some((s) => close(s.pose, truth, frags[1], 8, 2))).toBe(true);
  });

  it("keeps the true join and never lets a text-contradicted one through", () => {
    const m = matchFragments(frags);
    const truth = trueRel(poses, 0, 1);
    const real = m.candidates.filter((c) => close(c.pose, truth, frags[1], 3, 1));
    expect(real.length).toBeGreaterThan(0);
    expect(real[0].text).toBeTruthy();
    expect(real[0].text!.angle).toBeLessThan((2 * Math.PI) / 180);
    for (const c of m.candidates) {
      if (!c.text || !c.text.angleValid) continue;
      expect(c.text.angle).toBeLessThanOrEqual(MATCH_DEFAULTS.textMaxAngle);
      expect(c.text.flipped).toBe(false);
    }
  });
});
