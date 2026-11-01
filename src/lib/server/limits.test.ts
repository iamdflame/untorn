import { afterEach, describe, expect, it, vi } from "vitest";
import { admitRun, dailyCapFor, settleRun } from "./limits";
import { memoryStore } from "./store";

describe("dailyCapFor", () => {
  it("allows more spend on the judging days than on the others", () => {
    expect(dailyCapFor("2026-11-03")).toBe(1.5);
    expect(dailyCapFor("2026-11-04")).toBe(4);
    expect(dailyCapFor("2026-11-09")).toBe(4);
    expect(dailyCapFor("2026-11-10")).toBe(1.5);
  });

  it("keeps ten capped days to 10 Nov within the credit left on 1 Nov (about $35)", () => {
    const days = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(days.reduce((s, d) => s + dailyCapFor(d), 0)).toBeLessThanOrEqual(30);
  });
});

describe("admitRun", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses an address its seventh run of the day, with a plain reason", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "100");
    const store = memoryStore();
    for (let i = 0; i < 6; i++) {
      const { ipKey } = await admitRun(store, "203.0.113.7", `run-${i}`);
      await settleRun(store, ipKey, `run-${i}`, 0.1);
    }
    await expect(admitRun(store, "203.0.113.7", "run-6")).rejects.toMatchObject({ code: "rate-limited", message: expect.stringMatching(/today's live runs/) });
    await expect(admitRun(store, "203.0.113.8", "run-7")).resolves.toBeTruthy();
  });

  it("refuses every run once the day's spend reaches the cap", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "0.5");
    const store = memoryStore();
    const { ipKey } = await admitRun(store, "203.0.113.9", "run-a");
    await settleRun(store, ipKey, "run-a", 0.4);
    await expect(admitRun(store, "203.0.113.10", "run-b")).rejects.toMatchObject({ code: "daily-cap" });
  });
});
