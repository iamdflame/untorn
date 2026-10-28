import { describe, expect, it } from "vitest";
import { hedge } from "./hedge";

const wait = (ms: number, signal: AbortSignal, value: string) =>
  new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => resolve(value), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

describe("hedge", () => {
  it("starts a second lane when the first is slow, takes the first good answer and aborts the other", async () => {
    const aborted: number[] = [];
    const r = await hedge(
      (signal, lane) => {
        signal.addEventListener("abort", () => aborted.push(lane));
        return wait(lane === 0 ? 500 : 20, signal, `lane${lane}`);
      },
      { afterMs: 30, ok: () => true },
    );
    expect(r).toMatchObject({ result: "lane1", lane: 1, lanesStarted: 2 });
    expect(aborted).toEqual([0]);
  });

  it("never hedges a fast call, or when afterMs is 0", async () => {
    let started = 0;
    const run = (signal: AbortSignal) => {
      started++;
      return wait(10, signal, "fast");
    };
    expect((await hedge(run, { afterMs: 200, ok: () => true })).lanesStarted).toBe(1);
    expect((await hedge(run, { afterMs: 0, ok: () => true })).lanesStarted).toBe(1);
    expect(started).toBe(2);
  });

  it("settles at once on a final bad result, and moves on early from a retryable one", async () => {
    let lanes = 0;
    const final = await hedge(
      async () => {
        lanes++;
        return "400";
      },
      { afterMs: 1000, ok: (r) => r === "ok", final: (r) => r === "400" },
    );
    expect(final.result).toBe("400");
    expect(lanes).toBe(1);
    const early = await hedge(async (_s, lane) => (lane === 0 ? "busy" : "ok"), { afterMs: 1000, ok: (r) => r === "ok" });
    expect(early).toMatchObject({ result: "ok", lane: 1 });
  });

  it("rejects when the caller aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 10);
    await expect(hedge((s) => wait(500, s, "x"), { afterMs: 100, signal: ac.signal, ok: () => true })).rejects.toThrow("stop");
  });
});
