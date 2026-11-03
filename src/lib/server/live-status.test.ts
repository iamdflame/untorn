import { describe, expect, it } from "vitest";
import { hostsSeen } from "./live-status";

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
