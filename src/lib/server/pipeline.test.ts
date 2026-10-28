import { describe, expect, it } from "vitest";
import { RunError } from "@/lib/run/errors";
import { STAGES, type RunEvent } from "@/lib/run/types";
import { eventsFromResult } from "@/lib/run/replay";
import { fakeDeps, fakeScene } from "./__tests__/fake-run";
import { runPipeline } from "./pipeline";

const put = async (name: string) => `/files/${name}`;

describe("runPipeline (mocked models)", async () => {
  const scene = await fakeScene();

  it("emits every true stage in order and ends with the stored result", async () => {
    const events: RunEvent[] = [];
    const deps = fakeDeps(put);
    const stored: string[] = [];
    const result = await runPipeline(scene.photo, { ...deps, putAsset: async (n) => (stored.push(n), `/files/${n}`) }, { runId: "test-run-1", source: "upload" }, (e) => events.push(e));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("done");
    const order = events.filter((e) => e.type === "stage" && e.status === "active").map((e) => (e as { stage: string }).stage);
    expect(order).toEqual([...STAGES]);
    // each content event comes inside its stage
    const idx = (t: string) => types.indexOf(t as RunEvent["type"]);
    expect(idx("segment")).toBeLessThan(idx("match"));
    expect(idx("match")).toBeLessThan(idx("assemble"));
    expect(idx("assemble")).toBeLessThan(idx("transcribe"));
    expect(result.pieces).toHaveLength(6);
    expect(result.reads.length).toBe(result.asks.length);
    expect(result.reads.every((r) => r.ok && r.image?.startsWith("data:image/jpeg;base64,"))).toBe(true);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages[0].image).toBe("/files/page-0.png");
    expect(result.joins.length).toBeGreaterThan(0);
    // both clues per join: shape fit, and the words Muse read where it was asked
    expect(result.joins.some((j) => j.read && j.read.words.length)).toBe(true);
    expect(result.transcripts[0].translation?.to).toBe("en");
    expect(result.cost.usd).toBeGreaterThan(0);
    expect(stored).toEqual(expect.arrayContaining(["photo.jpg", "page-0.png", "result.json"]));
    expect(deps.calls.segment).toBe(1);
  });

  it("replays a stored result as the same event sequence", async () => {
    const events: RunEvent[] = [];
    const result = await runPipeline(scene.photo, fakeDeps(put), { runId: "test-run-2", source: "upload" }, (e) => events.push(e));
    const replay = eventsFromResult(result);
    const live = events.filter((e) => e.type !== "tick" && e.type !== "photo");
    expect(replay.filter((e) => e.type !== "photo").map((e) => e.type)).toEqual(live.map((e) => e.type));
    expect(replay.at(-1)).toMatchObject({ type: "done" });
  });

  it("turns SAM failure and an empty photo into designed errors", async () => {
    await expect(runPipeline(scene.photo, fakeDeps(put, { segment: "fail" }), { runId: "t3", source: "upload" }, () => {})).rejects.toMatchObject({ code: "model-error" });
    await expect(runPipeline(scene.photo, fakeDeps(put, { segment: "empty" }), { runId: "t4", source: "upload" }, () => {})).rejects.toBeInstanceOf(RunError);
  });

  it("keeps going on shape alone when every Muse read fails", async () => {
    const events: RunEvent[] = [];
    const result = await runPipeline(scene.photo, fakeDeps(put, { museFails: true }), { runId: "t5", source: "upload" }, (e) => events.push(e));
    expect(result.warnings.map((w) => w.code)).toContain("reading-failed");
    expect(result.reads.every((r) => !r.ok)).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("stops reading at the deadline and assembles with what it has", async () => {
    const result = await runPipeline(scene.photo, fakeDeps(put, { readDelayMs: 2000 }), { runId: "t6", source: "upload", readDeadlineMs: 150 }, () => {});
    expect(result.warnings.map((w) => w.code)).toContain("slow-reading");
    expect(result.timings.read).toBeLessThan(1500);
  });
});
