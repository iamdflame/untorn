import { describe, expect, it } from "vitest";
import { analyzeFragment } from "./fragment";
import { poseApply, poseCompose, poseInvert, wrapAngle, type Pose } from "./geom";
import { polygonOf } from "./polygon";
import { matchStraight, pieceShapes } from "./straight";
import { assembleTiles } from "./tiling";
import { scatterPage, voronoiPage } from "./__tests__/synth";

// A 640 × 860 page cut into 8 Voronoi cells, scattered at random rotations with slight boundary noise.
const page = voronoiPage(640, 860, 8, 7);
const { inputs, poses } = scatterPage(page, 21, { noise: 0.4, text: "blocks" });
const frags = inputs.map((inp, i) => analyzeFragment(inp, i)!);
const shapes = pieceShapes(frags);

/** True pose of piece b in piece a's photo frame. */
const truth = (a: number, b: number): Pose => poseCompose(poses[a], poseInvert(poses[b]));
const close = (p: Pose, q: Pose, at: [number, number], px = 5, deg = 1) => {
  const [x1, y1] = poseApply(p, ...at);
  const [x2, y2] = poseApply(q, ...at);
  return Math.hypot(x1 - x2, y1 - y2) <= px && Math.abs(wrapAngle(p.theta - q.theta)) <= (deg * Math.PI) / 180;
};

/** Neighbouring cells: pairs that share a long boundary on the page (counted on a pixel grid). */
function neighbours(minLen: number): [number, number][] {
  const count = new Map<string, number>();
  for (let y = 0; y < page.height; y++) {
    for (let x = 0; x + 1 < page.width; x++) {
      const a = page.label(x, y);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const b = page.label(x + dx, y + dy);
        if (b < 0 || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
  }
  return [...count.entries()].filter(([, n]) => n >= minLen).map(([k]) => k.split("|").map(Number) as [number, number]);
}

describe("straight sides (Voronoi cells)", () => {
  it("finds every cell's straight sides and corners", () => {
    for (const f of frags) {
      const poly = polygonOf(f.outline);
      const straight = poly.sides.filter((s) => s.kind === "straight");
      expect(straight.length).toBeGreaterThanOrEqual(3);
      // a convex cell: straight sides cover almost all of its outline, and most ends are corners
      expect(poly.straightLength / poly.perimeter).toBeGreaterThan(0.85);
      const corners = straight.flatMap((s) => s.ends).filter((e) => e.vertex).length;
      expect(corners).toBeGreaterThanOrEqual(straight.length);
    }
  });

  it("proposes every long shared cut at its true pose", () => {
    const cands = matchStraight(shapes);
    for (const [a, b] of neighbours(90)) {
      const hit = cands.find((c) => {
        const [i, j] = c.a === `p${a}` && c.b === `p${b}` ? [a, b] : c.a === `p${b}` && c.b === `p${a}` ? [b, a] : [-1, -1];
        return i >= 0 && close(c.pose, truth(i, j), frags[j].centroid);
      });
      expect(hit, `cut ${a}-${b}`).toBeDefined();
      expect(hit!.straight.ends).toBeGreaterThanOrEqual(1);
    }
  });

  /** Every pair of placed pieces sits as on the page: relative poses match the truth. */
  const expectTruePlacements = (fragments: { id: string; pose: Pose }[]) => {
    const placed = new Map(fragments.map((p) => [p.id, p.pose] as const));
    const ids = [...placed.keys()].map((id) => Number(id.slice(1)));
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const rel = poseCompose(poseInvert(placed.get(`p${a}`)!), placed.get(`p${b}`)!);
        expect(close(rel, truth(a, b), frags[b].centroid, 8, 1.5), `pieces ${a}, ${b}`).toBe(true);
      }
    }
  };

  it("places only true joins from geometry and ink alone", () => {
    const res = assembleTiles(shapes, matchStraight(shapes), null);
    expect(res.pages.length).toBeGreaterThanOrEqual(1);
    for (const p of res.pages) expectTruePlacements(p.fragments);
    const placed = res.pages.reduce((n, p) => n + p.fragments.length, 0);
    expect(placed).toBeGreaterThanOrEqual(5);
  });

  it("assembles the whole page once readings confirm the joins geometry proposes", () => {
    const cands = matchStraight(shapes);
    // an oracle reading: "same" exactly for the candidates at the true pose
    const verdicts = new Map(
      cands.map((c) => {
        const a = Number(c.a.slice(1));
        const b = Number(c.b.slice(1));
        return [c.id, { same: close(c.pose, truth(a, b), frags[b].centroid, 6, 1.5), confidence: 0.9 }] as const;
      }),
    );
    const res = assembleTiles(shapes, cands, verdicts);
    expect(res.unplaced).toHaveLength(0);
    expect(res.pages).toHaveLength(1);
    expectTruePlacements(res.pages[0].fragments);
  });

  it("lets a reading veto a join and supply the content clue, never forcing one", () => {
    // two pages cut into 4 cells each, with the same typeface and line pitch: pixels alone cannot tell them apart,
    // so an oracle reading says "no" to every cross-page candidate and "yes" to every true join
    const p1 = voronoiPage(500, 640, 4, 11);
    const p2 = voronoiPage(500, 640, 4, 12);
    const s1 = scatterPage(p1, 3, { textSeed: 1, prefix: "a", text: "blocks" });
    const s2 = scatterPage(p2, 4, { textSeed: 9, prefix: "b", row: 2, text: "blocks" });
    const all = pieceShapes([...s1.inputs, ...s2.inputs].map((inp, i) => analyzeFragment(inp, i)!));
    const cands = matchStraight(all);
    const truthOf = (id: string) => (id[0] === "a" ? s1.poses[Number(id.slice(1))] : s2.poses[Number(id.slice(1))]);
    const verdicts = new Map(
      cands.map((c) => {
        const ok = c.a[0] === c.b[0] && close(c.pose, poseCompose(truthOf(c.a), poseInvert(truthOf(c.b))), all.find((x) => x.f.id === c.b)!.f.centroid, 6, 1.5);
        return [c.id, { same: ok, confidence: 0.9 }] as const;
      }),
    );
    const res = assembleTiles(all, cands, verdicts);
    for (const j of res.joins) expect(j.a[0], j.candidate).toBe(j.b[0]);
    expect(res.pages.map((p) => p.fragments.length).sort()).toEqual([4, 4]);
  });
});
