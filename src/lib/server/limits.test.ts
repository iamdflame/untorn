import { afterEach, describe, expect, it, vi } from "vitest";
import { admitRun, dailyCapFor, publicShareFor, settleRun } from "./limits";
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

  it("stops visitors at the public share of the cap; runs from the judges' link may use the rest", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "1");
    vi.stubEnv("PUBLIC_CAP_SHARE", "0.5");
    const store = memoryStore();
    const { ipKey } = await admitRun(store, "203.0.113.20", "run-p");
    await settleRun(store, ipKey, "run-p", 0.35);
    // $0.35 spent and a run's $0.20 estimate: past the public half, within the whole cap
    await expect(admitRun(store, "203.0.113.21", "run-q")).rejects.toMatchObject({ code: "daily-cap" });
    await expect(admitRun(store, "203.0.113.21", "run-r", { reserved: true })).resolves.toBeTruthy();
    // the 12-hourly health run is ours: it may use the whole cap too
    await expect(admitRun(store, "health", "run-h")).resolves.toBeTruthy();
  });

  it("lets runs from the judges' link go on past an address's six, up to their own limit (judges may share an office's)", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "100");
    vi.stubEnv("JUDGE_RUNS_PER_IP_PER_DAY", "8");
    const store = memoryStore();
    for (let i = 0; i < 6; i++) {
      const { ipKey } = await admitRun(store, "203.0.113.30", `run-${i}`);
      await settleRun(store, ipKey, `run-${i}`, 0.1);
    }
    await expect(admitRun(store, "203.0.113.30", "run-6")).rejects.toMatchObject({ code: "rate-limited" });
    for (let i = 7; i < 9; i++) {
      const { ipKey } = await admitRun(store, "203.0.113.30", `run-${i}`, { reserved: true });
      await settleRun(store, ipKey, `run-${i}`, 0.1);
    }
    await expect(admitRun(store, "203.0.113.30", "run-9", { reserved: true })).rejects.toMatchObject({ code: "rate-limited" });
  });
});

describe("publicShareFor", () => {
  it("keeps half of each judging day's cap for the judges' link, and none on the other days", () => {
    expect(publicShareFor("2026-11-03")).toBe(1);
    expect(publicShareFor("2026-11-04")).toBe(0.5);
    expect(publicShareFor("2026-11-09")).toBe(0.5);
    expect(publicShareFor("2026-11-10")).toBe(1);
  });
});
