import { describe, expect, it } from "vitest";
import { cutEdges, matchCuts } from "./cuts";
import { analyzeFragment } from "./fragment";
import { poseApply, poseCompose, poseInvert } from "./geom";
import { MATCH_DEFAULTS, matchData } from "./match";
import { gridTear, scatterPage } from "./__tests__/synth";

describe("straight cuts", () => {
  // a 2×2 page: the vertical division is a straight cut, the horizontal one a tear
  const page = gridTear(480, 400, 2, 2, 12, true);
  const { inputs, poses } = scatterPage(page, 9, { noise: 0.5 });
  const frags = inputs.map((inp, i) => analyzeFragment(inp, i)!);
  const data = frags.map((f) => matchData(f));

  it("finds the straight edges of a piece: two page edges and the cut", () => {
    const edges = cutEdges(data[0]);
    expect(edges.length).toBeGreaterThanOrEqual(3);
    expect(edges.every((e) => e.rms < 1.6)).toBe(true);
  });

  it("proposes the true join across the cut, at the true pose", () => {
    const cands = matchCuts(data, MATCH_DEFAULTS);
    for (const [a, b] of [
      [0, 1],
      [2, 3],
    ]) {
      const truth = poseCompose(poses[a], poseInvert(poses[b]));
      const c = frags[b].centroid;
      const hit = cands.find((x) => {
        if (x.a !== `p${a}` || x.b !== `p${b}`) return false;
        const [x1, y1] = poseApply(truth, ...c);
        const [x2, y2] = poseApply(x.pose, ...c);
        return Math.hypot(x1 - x2, y1 - y2) < 4;
      });
      expect(hit, `cut ${a}-${b}`).toBeDefined();
      expect(hit!.edge).toBe("cut");
    }
  });
});
