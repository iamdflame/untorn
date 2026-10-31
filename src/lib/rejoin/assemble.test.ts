import { describe, expect, it } from "vitest";
import { ASSEMBLE_DEFAULTS, completePages, decide, linesAstray, type ContentEvidence } from "./assemble";
import { analyzeFragment } from "./fragment";
import { poseApply, poseCompose, poseInvert } from "./geom";
import { matchData, type MatchData } from "./match";
import { gridTrusted, lineConsensus } from "./textlines";
import type { Candidate, Pose, TextCheck } from "./types";
import { gridTear, scatterPage, scatterPiece } from "./__tests__/synth";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "a~b#0",
  a: "a",
  b: "b",
  pose: { theta: 0, tx: 0, ty: 0 },
  overlap: 220,
  rms: 0.8,
  areaOverlap: 0,
  conditioning: 0.9,
  shapeRms: 0.5,
  fineRms: 0.6,
  // below the bar for geometry alone (margin 1.4): only a read can confirm these
  score: 120,
  confidence: 0.4,
  margin: 1.2,
  marginOther: 1.2,
  segmentsA: [0],
  segmentsB: [0],
  seamA: [0, 120],
  seamB: [0, 120],
  appearance: null,
  twinGroup: null,
  edge: "torn",
  text: null,
  ...over,
});

const lines = (over: Partial<TextCheck> = {}): TextCheck => ({
  angle: 0.01,
  phase: 0.03,
  pitchRatio: 1,
  weight: 0.9,
  angleValid: true,
  phaseValid: true,
  flipped: false,
  logLR: 4,
  ...over,
});

const logit = (p: number) => Math.log(p / (1 - p));
/** `n` reads of one candidate, all saying `same` at `confidence`. */
const reads = (id: string, same: boolean, confidence: number, n = 1): ContentEvidence =>
  new Map([[id, { logOdds: n * (same ? 1 : -1) * logit(confidence), votes: n, pos: same ? n : 0 }]]);

describe("decide: a read confirms a join only where the geometry agrees", () => {
  const o = ASSEMBLE_DEFAULTS;

  it("accepts a clear 'same' on a fit no other partner beats", () => {
    const c = cand();
    const out = decide([c], reads(c.id, true, 0.9), o);
    expect(out).toHaveLength(1);
    expect(out[0].decidedBy).toBe("geometry+content");
    // without the read, geometry alone is not enough
    expect(decide([c], null, o)).toHaveLength(0);
  });

  it("counts another alignment of the same two pieces as no rival partner", () => {
    const c = cand({ margin: 0.8, marginOther: 1.6 });
    expect(decide([c], reads(c.id, true, 0.9), o)).toHaveLength(1);
  });

  it("does not let a 'same' override an outline fit that prefers another partner on that edge", () => {
    const c = cand({ margin: 0.8, marginOther: 0.8 });
    expect(decide([c], reads(c.id, true, 0.95), o)).toHaveLength(0);
    // candidates from before marginOther existed fall back on the plain margin
    const old = cand({ margin: 0.8, marginOther: undefined });
    expect(decide([old], reads(old.id, true, 0.95), o)).toHaveLength(0);
  });

  it("lets a sure 'same' past a rival partner only when Muse has surely ruled that rival out (the retake's curl)", () => {
    // p4–p9 (true, score 278) against p5–p9 (false, score 328) on the same edge of p9
    const c = cand({ id: "p4~p9#1", a: "p4", b: "p9", score: 278, margin: 0.85, marginOther: 0.85 });
    const rival = cand({ id: "p5~p9#4", a: "p5", b: "p9", score: 328, margin: 1.18, marginOther: 1.18 });
    const rivals = new Map([[c.id, [rival]], [rival.id, [c]]]);
    const ev = (same: number, other: number): ContentEvidence =>
      new Map([...reads(c.id, true, same), ...reads(rival.id, false, other)]);
    expect(decide([c, rival], ev(0.9, 0.85), o, rivals).map((d) => d.c.id)).toEqual([c.id]);
    // the rival only doubtfully ruled out, or the read for this join not sure enough: refused as before
    expect(decide([c, rival], ev(0.9, 0.7), o, rivals)).toHaveLength(0);
    expect(decide([c, rival], ev(0.8, 0.95), o, rivals)).toHaveLength(0);
    // the rival not read at all: refused
    expect(decide([c, rival], reads(c.id, true, 0.95), o, rivals)).toHaveLength(0);
    // and off
    expect(decide([c, rival], ev(0.9, 0.95), { ...o, ruledOutRead: 0 }, rivals)).toHaveLength(0);
  });

  it("does not let a 'same' join pieces whose text lines do not continue", () => {
    for (const t of [lines({ angle: (25 * Math.PI) / 180 }), lines({ phase: 0.45 }), lines({ flipped: true })]) {
      const c = cand({ text: t });
      expect(decide([c], reads(c.id, true, 0.95), o)).toHaveLength(0);
    }
    // lines that continue, or lines too faint to judge, leave the read to decide
    expect(decide([cand({ text: lines() })], reads("a~b#0", true, 0.9), o)).toHaveLength(1);
    expect(decide([cand({ text: lines({ angle: 0.5, weight: 0.3 }) })], reads("a~b#0", true, 0.9), o)).toHaveLength(1);
    // an unmeasurable phase is no evidence against the join
    expect(decide([cand({ text: lines({ phase: 0.45, phaseValid: false }) })], reads("a~b#0", true, 0.9), o)).toHaveLength(1);
  });

  it("takes a hesitant 'same' for no clue", () => {
    const c = cand();
    expect(decide([c], reads(c.id, true, 0.55), o)).toHaveLength(0);
    expect(decide([c], reads(c.id, true, 0.65), o)).toHaveLength(0);
    expect(decide([c], reads(c.id, true, 0.75), o)).toHaveLength(1);
    // two hesitant reads that agree add up
    expect(decide([c], reads(c.id, true, 0.62, 2), o)).toHaveLength(1);
  });

  it("lets the outline and continuing lines outvote one unsure 'not the same'", () => {
    // a fit geometry alone would take, its lines continuing in direction and phase
    const strong = cand({ margin: 2, marginOther: 2, score: 160, confidence: 0.8, text: lines({ logLR: 4 }) });
    expect(decide([strong], reads(strong.id, false, 0.85), o)).toHaveLength(1);
    // not against a sure read, nor with lines that only half measure, nor for a fit geometry alone would not take
    expect(decide([strong], reads(strong.id, false, 0.95), o)).toHaveLength(0);
    expect(decide([cand({ ...strong, text: lines({ logLR: 4, phaseValid: false }) })], reads(strong.id, false, 0.85), o)).toHaveLength(0);
    expect(decide([cand({ ...strong, text: lines({ logLR: 2 }) })], reads(strong.id, false, 0.85), o)).toHaveLength(0);
    expect(decide([cand({ ...strong, margin: 1.2, marginOther: 1.2 })], reads(strong.id, false, 0.85), o)).toHaveLength(0);
    // nor for a fit geometry alone takes only just: a chance fit on the real photo stood at margin 1.54
    expect(decide([cand({ ...strong, margin: 1.6, marginOther: 1.6 })], reads(strong.id, false, 0.85), o)).toHaveLength(0);
  });

  it("leaves twins and straight cuts to the reads, as before", () => {
    // inside a twin group geometry is tied: the rival partner's fit is no evidence against the read
    const twin = cand({ twinGroup: "twin-a-0", margin: 0.95, marginOther: 0.95 });
    const two = reads(twin.id, true, 0.9, 2);
    const out = decide([twin], two, o);
    expect(out).toHaveLength(1);
    expect(out[0].decidedBy).toBe("content");
    const cut = cand({ edge: "cut", margin: 0.9, marginOther: 0.9 });
    expect(decide([cut], reads(cut.id, true, 0.9), o)).toHaveLength(1);
  });
});

describe("linesAstray: pieces whose text lines contradict their page", () => {
  const o = ASSEMBLE_DEFAULTS;
  // a page with typed lines every 22 px torn 3 × 2, every piece scattered at its own rotation
  const page = gridTear(600, 420, 3, 2, 11);
  const scatter: Pose[] = [0.3, -1.2, 2.2, 0.9, -2.6, 1.6].map((theta, k) => ({ theta, tx: 500 + 700 * (k % 3), ty: 500 + 700 * Math.floor(k / 3) }));
  const frags = scatter.map((p, k) => analyzeFragment(scatterPiece(page, k, p, { noise: 0.4 }), k)!);
  const consensus = lineConsensus(frags);
  const byId = new Map(frags.map((f) => [f.id, { f } as unknown as MatchData] as const));
  const ids = frags.map((f) => f.id);
  // the true page: each piece's photo → page
  const truth = new Map(frags.map((f, k) => [f.id, poseInvert(scatter[k])] as const));
  /** The page with piece `id` turned by `deg` about its centroid. */
  const turned = (id: string, deg: number) => {
    const [cx, cy] = byId.get(id)!.f.centroid;
    const turn = poseCompose({ theta: 0, tx: cx, ty: cy }, poseCompose({ theta: (deg * Math.PI) / 180, tx: 0, ty: 0 }, { theta: 0, tx: -cx, ty: -cy }));
    return new Map([...truth].map(([k, p]) => [k, k === id ? poseCompose(p, turn) : p] as const));
  };

  it("leaves the true page alone", () => {
    expect(frags.filter((f) => gridTrusted(f, consensus)).length).toBeGreaterThanOrEqual(4);
    expect(linesAstray(ids, byId, truth, consensus, o)).toEqual([]);
  });

  it("finds a piece a chain of joins turned off its neighbours' lines", () => {
    const victim = ids.find((id) => gridTrusted(byId.get(id)!.f, consensus))!;
    for (const deg of [26, 154, -40]) expect(linesAstray(ids, byId, turned(victim, deg), consensus, o)).toEqual([victim]);
    // within the join tolerance it is still on the page's lines
    expect(linesAstray(ids, byId, turned(victim, 3), consensus, o)).toEqual([]);
  });

  it("needs trusted lines: a blank piece, or one page with no line pitch, says nothing", () => {
    const victim = ids[0];
    const blank = new Map(byId);
    blank.set(victim, { f: { ...byId.get(victim)!.f, text: null } } as unknown as MatchData);
    expect(linesAstray(ids, blank, turned(victim, 26), consensus, o)).toEqual([]);
    expect(linesAstray(ids, byId, turned(victim, 26), null, o)).toEqual([]);
    // two pieces with lines: the stronger one's direction stands, the other is off it
    expect(linesAstray(ids.slice(0, 2), byId, turned(ids[0], 30), consensus, o).length).toBe(1);
  });

  it("keeps a piece whose own estimate is an alias but whose ink runs along the page's lines", () => {
    const victim = ids.find((id) => gridTrusted(byId.get(id)!.f, consensus))!;
    const f = byId.get(victim)!.f;
    // its text angle a quarter turn off (columns read as lines), its pixels unchanged
    const alias = new Map(byId);
    alias.set(victim, { f: { ...f, text: { ...f.text!, angle: f.text!.angle + Math.PI / 2 } } } as unknown as MatchData);
    expect(linesAstray(ids, alias, truth, consensus, o)).toEqual([]);
  });
});

describe("completePages: a second chance against the finished page", () => {
  // a page torn 3 × 3 with typed lines, scattered; all but the centre piece placed where they belong
  const page = gridTear(900, 840, 3, 3, 23);
  const { inputs, poses } = scatterPage(page, 5, { noise: 0.4 });
  const frags = inputs.map((inp, k) => analyzeFragment(inp, k)!);
  const data = frags.map((f) => matchData(f));
  const byId = new Map(data.map((d) => [d.f.id, d] as const));
  const consensus = lineConsensus(frags);
  const radius = new Map(data.map((d) => [d.f.id, Math.max(...Array.from({ length: d.n }, (_, i) => Math.hypot(d.X[i] - d.f.centroid[0], d.Y[i] - d.f.centroid[1])))] as const));
  const truth = new Map(frags.map((f, k) => [f.id, poseInvert(poses[k])] as const));
  const state = (left: string[]) => {
    const placed = frags.map((f) => f.id).filter((id) => !left.includes(id));
    const members = new Map<string, string[]>([[placed[0], placed], ...left.map((id) => [id, [id]] as [string, string[]])]);
    const comp = new Map<string, string>([...placed.map((id) => [id, placed[0]] as [string, string]), ...left.map((id) => [id, id] as [string, string])]);
    return {
      byId,
      members,
      comp,
      pose: new Map(truth),
      used: new Map(data.map((d) => [d.f.id, new Uint8Array(d.n)] as const)),
      radius,
      consensus,
    };
  };

  it("lays a set-aside piece into its gap from its text lines alone, where it belongs", () => {
    const s = state(["p4"]);
    const made = completePages(s, ["p4"], [], null, ASSEMBLE_DEFAULTS);
    expect(made.map((p) => p.unit)).toEqual(["p4"]);
    expect(made[0].seams.length).toBeGreaterThanOrEqual(2);
    // where the truth has it, relative to the page
    const [cx, cy] = byId.get("p4")!.f.centroid;
    const [x1, y1] = poseApply(made[0].pose, cx, cy);
    const [x2, y2] = poseApply(truth.get("p4")!, cx, cy);
    expect(Math.hypot(x1 - x2, y1 - y2)).toBeLessThan(4);
    expect(Math.abs(Math.atan2(Math.sin(made[0].pose.theta - truth.get("p4")!.theta), Math.cos(made[0].pose.theta - truth.get("p4")!.theta)))).toBeLessThan((1 * Math.PI) / 180);
    expect(s.members.get("p0")).toContain("p4");
  });

  it("leaves a piece out when no gap holds it on two sides", () => {
    // the corner p8 with both its neighbours (p5, p7) off the page: nothing holds it
    const s = state(["p5", "p7", "p8"]);
    expect(completePages(s, ["p8"], [], null, ASSEMBLE_DEFAULTS)).toEqual([]);
  });

  it("does not place a piece where a read said they are not the same", () => {
    const rel = poseCompose(poseInvert(truth.get("p1")!), truth.get("p4")!);
    const no = cand({ id: "p1~p4#0", a: "p1", b: "p4", pose: rel });
    const evidence: ContentEvidence = new Map([[no.id, { logOdds: -2, votes: 1, pos: 0 }]]);
    expect(completePages(state(["p4"]), ["p4"], [no], evidence, ASSEMBLE_DEFAULTS)).toEqual([]);
  });
});
