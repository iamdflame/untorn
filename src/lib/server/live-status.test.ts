import { describe, expect, it } from "vitest";
import { hostsSeen, notePauses, refusedWithin, resetPauseCache } from "./live-status";
import { memoryStore } from "./store";

describe("hostsSeen", () => {
  const run = (warnings: string[], reads: { ok: boolean; model?: string; error?: string }[]) => ({ warnings: warnings.map((code) => ({ code })), reads, transcripts: [] });

  it("reads Meta's API off SAM 3.1, and the open weights off their own reads", () => {
    expect(hostsSeen(run(["sam-refused"], [{ ok: false, model: "muse-spark-open", error: "billing" }]))).toEqual({ metaRefused: true, openAnswered: false, openRefused: true });
    expect(hostsSeen(run([], [{ ok: true, model: "muse-spark-open" }, { ok: false, model: "muse-spark-1.3", error: "auth" }]))).toEqual({ metaRefused: false, openAnswered: true, openRefused: false });
  });

  it("a slow or failed open read is not a refusal", () => {
    expect(hostsSeen(run([], [{ ok: false, model: "muse-spark-open", error: "timeout" }])).openRefused).toBe(false);
  });
});

describe("notePauses", () => {
  const run = (reads: { ok: boolean; model?: string }[]) => ({ warnings: [], reads, transcripts: [] });

  it("records a refusal the reads can't show (a hedge's lane Muse Spark answered), until an open answer lifts it", async () => {
    resetPauseCache();
    const store = memoryStore();
    await notePauses(store, run([{ ok: true, model: "muse-spark-1.3" }]), "run a", { openRefused: true });
    expect(await refusedWithin(store, "open", 60_000)).toBe(true);
    // a run that never asked the open weights learns nothing about them: the record stays
    await notePauses(store, run([{ ok: true, model: "muse-spark-1.3" }]), "run b");
    expect(await refusedWithin(store, "open", 60_000)).toBe(true);
    await notePauses(store, run([{ ok: true, model: "muse-spark-open" }]), "run c");
    expect(await refusedWithin(store, "open", 60_000)).toBe(false);
  });
});
