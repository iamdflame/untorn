import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderScene, SCENE_PIECES } from "./__fixtures__/scene";
import { evaluateMasks } from "./mask-eval";
import { mergeDetections, segmentFragments, type SegmentOptions } from "./segment";

// Real SAM 3.1 answers recorded on renderScene() by scripts/live/record-segment-fixture.mts, keyed by prompt text.
const recorded = JSON.parse(readFileSync(new URL("./__fixtures__/segment-scene.sam.json", import.meta.url), "utf8")) as {
  responses: { text: string; status: number; sse: string }[];
};
const PASS1 = recorded.responses.find((r) => r.text === "torn piece of paper")!;
const EMPTY_SSE = 'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
const gt = SCENE_PIECES.map((p, piece) => ({ piece, photo_polygon: p }));

type Rule = (text: string) => Response | Error | null | "hang";
function samFetch(rule: Rule = () => null) {
  const texts: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const text = JSON.parse(String(init!.body)).input[0].content[0].text as string;
    texts.push(text);
    const special = rule(text);
    if (special === "hang") {
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }
    if (special instanceof Error) throw special;
    if (special) return special;
    const hit = recorded.responses.find((r) => r.text === text);
    if (!hit) return new Response(JSON.stringify({ error: { message: `no fixture for ${text.slice(0, 40)}` } }), { status: 400 });
    return new Response(hit.sse, { status: hit.status, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { impl, texts };
}

const base: SegmentOptions = { apiKey: "test-key", hedgeAfterMs: 0 };

describe("segmentFragments on recorded SAM output", () => {
  it.each(["auto", "snap", "crops", "fullres-boxes"] as const)("%s: finds the 3 pieces with sub-pixel outlines", async (variant) => {
    const f = samFetch();
    const r = await segmentFragments(await renderScene(), { ...base, variant, fetchImpl: f.impl });
    expect(r.width).toBe(640);
    expect(r.pass1).toMatchObject({ concept: "torn piece of paper", count: 3, tiled: false });
    expect(r.fragments).toHaveLength(3);
    const ev = evaluateMasks(gt, r.fragments.map((x) => x.mask)).summary;
    expect(ev.detected).toBe(3);
    expect(ev.meanIoU).toBeGreaterThan(0.97);
    expect(ev.medianBoundaryPx).toBeLessThan(1);
    for (const fr of r.fragments) {
      expect(fr.polygon.length).toBeGreaterThan(8);
      expect(fr.refined).toBe(true);
      expect(fr.confidence).toBeGreaterThan(0.5);
      expect(fr.area).toBeGreaterThan(1000);
    }
    // reading order: top row left to right, then the bottom piece
    expect(r.fragments.map((x) => Math.round(x.box[0] / 100))).toEqual([0, 3, 2]);
    expect(r.samCalls).toBe(variant === "crops" ? 4 : variant === "fullres-boxes" ? 2 : 1);
    expect(r.warnings).toEqual([]);
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(r.timings.pass1Ms);
    expect(new Set(r.fragments.map((x) => x.method))).toEqual(new Set([variant === "crops" ? "crop" : variant === "fullres-boxes" ? "fullres" : "snap"]));
  });

  it("falls back to the next concept when the first finds nothing", async () => {
    const f = samFetch((t) => (t === "torn piece of paper" ? new Response(EMPTY_SSE, { status: 200 }) : t === "piece of paper" ? new Response(PASS1.sse, { status: 200 }) : null));
    const r = await segmentFragments(await renderScene(), { ...base, variant: "snap", fetchImpl: f.impl });
    expect(r.pass1.concept).toBe("piece of paper");
    expect(r.fragments).toHaveLength(3);
    expect(r.warnings).toEqual(['concept "torn piece of paper" found nothing']);
  });

  it("keeps a snapped mask, marked unrefined, when a crop refinement fails", async () => {
    const f = samFetch((t) => (t.startsWith("<0f>") ? new Response(JSON.stringify({ error: { message: "bad box" } }), { status: 400 }) : null));
    const r = await segmentFragments(await renderScene(), { ...base, variant: "crops", fetchImpl: f.impl });
    expect(r.fragments).toHaveLength(3);
    expect(r.fragments.every((x) => !x.refined && x.method === "snap-fallback")).toBe(true);
    expect(r.warnings).toHaveLength(3);
    expect(evaluateMasks(gt, r.fragments.map((x) => x.mask)).summary.medianBoundaryPx).toBeLessThan(1);
  });

  it("retries a pass-1 network error and a 503", async () => {
    let n = 0;
    const f = samFetch((t) => {
      if (t !== "torn piece of paper") return null;
      n++;
      if (n === 1) return new TypeError("fetch failed");
      if (n === 2) return new Response("{}", { status: 503 });
      return null;
    });
    const r = await segmentFragments(await renderScene(), { ...base, variant: "snap", fetchImpl: f.impl });
    expect(r.fragments).toHaveLength(3);
    expect(r.calls.map((c) => c.ok)).toEqual([false, false, true]);
  });

  it("hedges a hung pass-1 request: a second one answers", async () => {
    let n = 0;
    const f = samFetch((t) => (t === "torn piece of paper" && ++n === 1 ? "hang" : null));
    const r = await segmentFragments(await renderScene(), { ...base, variant: "snap", fetchImpl: f.impl, hedgeAfterMs: 50 });
    expect(r.fragments).toHaveLength(3);
    expect(r.calls.some((c) => c.stage.endsWith("#hedge") && c.ok)).toBe(true);
    expect(r.timings.pass1Ms).toBeLessThan(5000);
  });

  it("does not retry a 400 on pass 1", async () => {
    const f = samFetch(() => new Response(JSON.stringify({ error: { message: "invalid prompt" } }), { status: 400 }));
    await expect(segmentFragments(await renderScene(), { ...base, fetchImpl: f.impl })).rejects.toThrow("invalid prompt");
    expect(f.texts).toHaveLength(1);
  });
});

describe("mergeDetections", () => {
  const sq = (x: number, y: number, s: number, confidence: number) => {
    const data = new Uint8Array(s * s).fill(1);
    return { full: { x, y, width: s, height: s, data }, confidence };
  };
  it("drops near-duplicates (keeping the more confident) and unions of several pieces", () => {
    const a = sq(0, 0, 10, 0.9), a2 = sq(1, 0, 10, 0.5), b = sq(20, 0, 10, 0.8);
    const union = { full: { x: 0, y: 0, width: 30, height: 10, data: new Uint8Array(300).fill(1) }, confidence: 0.95 };
    expect(mergeDetections([a2, a, b, union])).toEqual([a, b]);
  });
});
