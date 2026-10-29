import { describe, expect, it } from "vitest";
import { museContentCheck, fragmentsFromSegments, type ChooseContinuation, type VerifySeam } from "./adapters";
import { poseApply, poseCompose, poseInvert, type Pose } from "./geom";
import { renderChoiceSheet, renderSeam } from "./seam";
import { renderPage } from "./render";
import { askPlanned, contentRequests, finish, prepare, solve } from "./solve";
import { gridTear, scatterPage } from "./__tests__/synth";
import type { ContentCheck, FragmentInput, SolveResult } from "./types";

/** Every placed fragment agrees with the truth up to one rigid transform per page (3 px, 1°). */
function placedCorrectly(res: SolveResult, inputs: FragmentInput[], truth: Map<string, Pose>) {
  const centroid = (id: string) => {
    const f = inputs.find((x) => x.id === id)!;
    return [f.x0 + f.mask.width / 2, f.y0 + f.mask.height / 2] as [number, number];
  };
  let ok = 0;
  for (const page of res.pages) {
    const ref = page.fragments[0];
    // page → truth, from the first fragment: truth_k⁻¹ maps photo → true page
    const G = poseCompose(poseInvert(truth.get(ref.id)!), poseInvert(ref.pose));
    for (const pf of page.fragments) {
      const c = centroid(pf.id);
      const [x1, y1] = poseApply(poseCompose(G, pf.pose), ...c);
      const [x2, y2] = poseApply(poseInvert(truth.get(pf.id)!), ...c);
      const pred = poseCompose(G, pf.pose);
      const tr = poseInvert(truth.get(pf.id)!);
      const dth = Math.abs(Math.atan2(Math.sin(pred.theta - tr.theta), Math.cos(pred.theta - tr.theta)));
      if (Math.hypot(x1 - x2, y1 - y2) <= 3 && dth <= Math.PI / 180) ok++;
    }
  }
  return ok;
}

describe("solve on one torn page (geometry only)", async () => {
  const page = gridTear(520, 420, 3, 2, 21);
  const { inputs, poses } = scatterPage(page, 5, { noise: 0.6 });
  const truth = new Map(inputs.map((f, k) => [f.id, poses[k]] as const));
  const res = await solve(inputs);

  it("puts all six pieces on one page at the right poses", () => {
    expect(res.pages).toHaveLength(1);
    expect(res.pages[0].fragments).toHaveLength(6);
    expect(res.unplaced).toHaveLength(0);
    expect(placedCorrectly(res, inputs, truth)).toBe(6);
  });

  it("reports seam appearance on strong candidates: one paper tone, ink correlation in range", () => {
    const strong = res.candidates.filter((c) => c.score >= 25);
    expect(strong.length).toBeGreaterThan(0);
    for (const c of strong) {
      expect(c.appearance).not.toBeNull();
      expect(c.appearance!.tone).toBeLessThan(5); // one paper stock
      if (c.appearance!.ink !== null) {
        expect(c.appearance!.ink).toBeGreaterThanOrEqual(-1);
        expect(c.appearance!.ink).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reports joins decided by geometry, a confident page, and renders it", () => {
    expect(res.joins.length).toBeGreaterThanOrEqual(5);
    expect(res.joins.every((j) => j.decidedBy === "geometry")).toBe(true);
    expect(res.pages[0].confidence).toBeGreaterThan(0.5);
    expect(res.pages[0].completeness).toBeGreaterThan(0.8);
    const img = renderPage(res.pages[0], prepare(inputs).fragments);
    expect(img.width).toBeGreaterThan(400);
    let painted = 0;
    for (let i = 3; i < img.data.length; i += 4) painted += img.data[i] ? 1 : 0;
    expect(painted / (img.width * img.height)).toBeGreaterThan(0.6);
  });
});

describe("stack tears: identical outlines on different pages", async () => {
  // two pages torn by the same paths: pieces have twins with the same outline and different words
  const page = gridTear(520, 420, 2, 2, 33);
  const s1 = scatterPage(page, 7, { noise: 0.5, textSeed: 1, prefix: "x" });
  const s2 = scatterPage(page, 8, { noise: 0.5, textSeed: 2, prefix: "y", row: 2 });
  const inputs = [...s1.inputs, ...s2.inputs];
  const truth = new Map(inputs.map((f, k) => [f.id, k < 4 ? s1.poses[k] : s2.poses[k - 4]] as const));
  const pageOf = (id: string) => id[0];

  it("geometry alone detects the twins and places nothing wrongly", async () => {
    const res = await solve(inputs);
    const prep = prepare(inputs);
    expect(prep.match.twinGroups.length).toBeGreaterThan(0);
    for (const p of res.pages) expect(new Set(p.fragments.map((f) => pageOf(f.id))).size).toBe(1);
    expect(res.unplaced.filter((u) => u.reason === "twin-unresolved").length).toBeGreaterThan(0);
  });

  it("with a correct content check, both pages are rebuilt", async () => {
    const prep = prepare(inputs);
    const byId = new Map(prep.match.candidates.map((c) => [c.id, c] as const));
    const oracle: ContentCheck = async (req) => {
      if (req.kind === "pair") {
        const c = byId.get(req.candidate)!;
        return { kind: "pair", id: req.id, same: pageOf(c.a) === pageOf(c.b), confidence: 0.95 };
      }
      const k = req.candidates.findIndex((id) => {
        const c = byId.get(id)!;
        return pageOf(c.a) === pageOf(c.b);
      });
      return { kind: "choice", id: req.id, choice: k >= 0 ? k : null, confidence: 0.95 };
    };
    const res = await solve(inputs, { content: oracle });
    expect(res.pages).toHaveLength(2);
    for (const p of res.pages) {
      expect(p.fragments).toHaveLength(4);
      expect(new Set(p.fragments.map((f) => pageOf(f.id))).size).toBe(1);
    }
    expect(placedCorrectly(res, inputs, truth)).toBe(8);
    expect(res.joins.some((j) => j.decidedBy === "content")).toBe(true);
  });

  it("the tree strategy reads fewer sheets and rebuilds the same pages", async () => {
    const asked = { all: 0, tree: 0 };
    for (const strategy of ["all", "tree"] as const) {
      const prep = prepare(inputs, { twinStrategy: strategy });
      const byId = new Map(prep.match.candidates.map((c) => [c.id, c] as const));
      const oracle: ContentCheck = async (req) => {
        if (req.kind === "pair") return { kind: "pair", id: req.id, same: pageOf(byId.get(req.candidate)!.a) === pageOf(byId.get(req.candidate)!.b), confidence: 0.95 };
        const k = req.candidates.findIndex((id) => pageOf(byId.get(id)!.a) === pageOf(byId.get(id)!.b));
        return { kind: "choice", id: req.id, choice: k >= 0 ? k : null, confidence: 0.95 };
      };
      const { reqs, verdicts } = await askPlanned(prep, oracle, 4);
      asked[strategy] = reqs.filter((r) => r.kind === "choice").length;
      const res = finish(prep, reqs, verdicts);
      expect(res.pages).toHaveLength(2);
      for (const p of res.pages) expect(new Set(p.fragments.map((f) => pageOf(f.id))).size).toBe(1);
      expect(placedCorrectly(res, inputs, truth)).toBe(8);
    }
    expect(asked.tree).toBeLessThan(asked.all);
  });

  it("renders the k-way sheet and the pair seam the content check reads", () => {
    const prep = prepare(inputs);
    const reqs = contentRequests(prep);
    const choice = reqs.find((r) => r.kind === "choice")!;
    expect(choice.kind).toBe("choice");
    const sheet = choice.render();
    const k = choice.kind === "choice" ? choice.candidates.length : 0;
    expect(sheet.width).toBe(420 + 40);
    expect(sheet.height).toBe(20 + (150 + 34) * (k + 1) - 34 + 20);
    const cand = prep.match.candidates[0];
    const seam = renderSeam(prep.byId, cand);
    expect([seam.width, seam.height]).toEqual([420, 150]);
    const anchor = choice.kind === "choice" ? choice.anchor : "";
    const cands = choice.kind === "choice" ? choice.candidates.map((id) => prep.match.candidates.find((c) => c.id === id)!) : [];
    expect(renderChoiceSheet(prep.byId, anchor, cands).height).toBe(sheet.height);
  });
});

describe("S2 adapters", () => {
  it("maps verifySeam and chooseContinuation outcomes to verdicts, failures to null", async () => {
    const page = gridTear(400, 300, 2, 1, 4);
    const { inputs } = scatterPage(page, 3, { noise: 0.4 });
    const prep = prepare(inputs);
    const cand = prep.match.candidates[0];
    const req = { kind: "pair" as const, id: "pair:x", candidate: cand.id, a: cand.a, b: cand.b, uprightKnown: false, render: () => renderSeam(prep.byId, cand) };
    let rotated: boolean | undefined;
    const verifySeam: VerifySeam = async (img, o) => {
      rotated = o?.rotated;
      expect(img.mime).toBe("image/png");
      expect(img.data.slice(1, 4)).toEqual(Uint8Array.from([80, 78, 71])); // "PNG"
      return { ok: true, value: { same_place: true, confidence: 0.92, words_across: ["born"], reason: "bo+rn" }, meta: {} };
    };
    const chooseContinuation: ChooseContinuation = async () => ({ ok: false, error: { code: "timeout", message: "x" }, meta: {} });
    const check = museContentCheck({ verifySeam, chooseContinuation });
    expect(await check(req)).toEqual({ kind: "pair", id: "pair:x", same: true, confidence: 0.92, reason: "bo+rn", wordsAcross: ["born"] });
    expect(rotated).toBe(true);
    const choiceReq = { kind: "choice" as const, id: "c", anchor: cand.a, twinGroup: null, candidates: [cand.id], uprightKnown: true, render: () => renderChoiceSheet(prep.byId, cand.a, [cand]) };
    expect(await check(choiceReq)).toBeNull();
  });

  it("crops solver inputs from segmentFragments-style masks", () => {
    const photo = { width: 6, height: 4, data: new Uint8ClampedArray(6 * 4 * 4).map((_, i) => i % 256) };
    const [f] = fragmentsFromSegments(photo, [{ id: "s0", mask: { x: 2, y: 1, width: 3, height: 2, data: [1, 1, 0, 0, 1, 1] } }]);
    expect([f.x0, f.y0, f.mask.width, f.mask.height]).toEqual([2, 1, 3, 2]);
    expect(Array.from(f.mask.data)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(f.rgba!.data[0]).toBe(photo.data[4 * (1 * 6 + 2)]);
  });
});
