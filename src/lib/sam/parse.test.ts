import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openSamStream, samFrames } from "./client";
import { parseSamText, readOutputTextDeltas, SamTextAccumulator, UpstreamError } from "./parse";

// Cut from real SAM 3.1 output: the e1 "head" concept cache (lossless masks) and a live point prompt (one_bit masks).
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const concept = fixture("concept-head-sl142.sam.txt");
const point = fixture("point-head-sl142.sam.txt");
const image = fixture("image-head-sl142.sam.txt");

function sse(events: unknown[], splitEvery = 7): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += splitEvery) c.enqueue(bytes.slice(i, i + splitEvery));
      c.close();
    },
  });
}

describe("parseSamText on real output", () => {
  it("reads the concept cache: frames, ids, boxes, confidence, height-first masks", () => {
    const frames = parseSamText(concept);
    expect(frames.map((f) => f.frame)).toEqual([0, 1, 2]);
    const [manikin, rescuer] = frames[0].objects;
    expect(manikin).toMatchObject({ id: 0, box: [343, 277, 368, 300], frameW: 640, frameH: 360 });
    expect(manikin.confidence).toBeCloseTo(0.7037, 4);
    expect(manikin.mask).toMatchObject({ x: 0, y: 0, h: 24, w: 26 });
    expect(manikin.mask?.data.startsWith("~")).toBe(true);
    expect(rescuer).toMatchObject({ id: 1, box: [325, 17, 398, 112] });
    expect(rescuer.mask).toMatchObject({ h: 96, w: 74 });
  });

  it("reads the live point-prompt output", () => {
    const frames = parseSamText(point);
    expect(frames.map((f) => f.frame)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.objects.length === 1 && f.objects[0].id === 1)).toBe(true);
    expect(frames[0].objects[0].mask?.data.startsWith("!")).toBe(true);
    expect(frames[0].objects[0].mask).toMatchObject({ h: 90, w: 71 });
  });

  it("reads a single image", () => {
    const [f] = parseSamText(image);
    expect(f.frame).toBe(0);
    expect(f.objects[0]).toMatchObject({ id: 0, box: [325, 17, 398, 113] });
  });
});

describe("SamTextAccumulator", () => {
  it("returns the same frames however the text is split", () => {
    const whole = parseSamText(concept + point);
    for (const step of [1, 13, 500, 100000]) {
      const acc = new SamTextAccumulator();
      const got = [];
      const text = concept + point;
      for (let i = 0; i < text.length; i += step) got.push(...acc.push(text.slice(i, i + step)));
      got.push(...acc.end());
      expect(got).toEqual(whole);
    }
  });
});

describe("the Responses event stream", () => {
  it("yields output text deltas across arbitrary byte splits", async () => {
    const lines = point.split(/(?=<\d+f>)/);
    const stream = sse([{ type: "response.created" }, ...lines.map((delta) => ({ type: "response.output_text.delta", delta })), { type: "response.completed" }]);
    const frames = [];
    for await (const f of samFrames(stream)) frames.push(f);
    expect(frames).toEqual(parseSamText(point));
  });

  it("throws UpstreamError on a mid-stream error event", async () => {
    const stream = sse([{ type: "response.output_text.delta", delta: lines0() }, { type: "error", code: "server_shutting_down", message: "draining" }]);
    const read = async () => {
      for await (const d of readOutputTextDeltas(stream)) void d;
    };
    await expect(read()).rejects.toMatchObject({ name: "UpstreamError", code: "server_shutting_down", message: "draining" });
  });

  it("maps a non-2xx answer to UpstreamError with its status and code, before any byte", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Billing account issue.", type: "billing_error", code: "billing_not_configured" } }), {
        status: 402,
      })) as typeof fetch;
    const body = { model: "sam-3.1", stream: true, metadata: { include_confidence: "true", mask_encoding: "one_bit" }, input: [] } as never;
    const err = await openSamStream(body, { apiKey: "LLM_test_secret", fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ status: 402, code: "billing_not_configured", message: "Billing account issue." });
    expect(String((err as Error).message)).not.toContain("LLM_test_secret");
  });
});

function lines0() {
  return point.split("\n")[0];
}
