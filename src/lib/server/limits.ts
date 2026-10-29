// Keeping the live pipeline alive for everyone: a per-IP rate limit, a daily model-spend cap and a per-instance
// queue. All env-configurable. IPs are only kept as salted hashes.
//
//   RUNS_PER_IP_PER_HOUR      live runs one address may start per hour (default 8)
//   SESSIONS_PER_IP_PER_HOUR  phone codes one address may make per hour (default 30)
//   DAILY_SPEND_CAP_USD       model spend per UTC day across all runs (default 10)
//   MAX_CONCURRENT_RUNS       pipelines one server instance runs at once; the rest queue (default 4)
//   MAX_QUEUE                 runs that may wait per instance before "busy" (default 12)

import { createHash } from "node:crypto";
import { RunError } from "@/lib/run/errors";
import type { Store } from "./store";

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};

export const limits = () => ({
  runsPerIpPerHour: num("RUNS_PER_IP_PER_HOUR", 8),
  sessionsPerIpPerHour: num("SESSIONS_PER_IP_PER_HOUR", 30),
  dailyCapUsd: num("DAILY_SPEND_CAP_USD", 10),
  maxConcurrent: Math.max(1, num("MAX_CONCURRENT_RUNS", 4)),
  maxQueue: num("MAX_QUEUE", 12),
  /** Counted for a run until its real cost is known. */
  estimateUsd: 0.2,
});

/** The caller's address as the platform reports it (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

export function ipHash(ip: string): string {
  return createHash("sha256")
    .update(`${process.env.IP_HASH_SALT ?? "untorn-ip"}:${ip}`)
    .digest("hex")
    .slice(0, 16);
}

export const day = (d = new Date()) => d.toISOString().slice(0, 10);

// ── in-memory sliding windows: the first line, free and instant ────────────────────────────────────────────
const windows = new Map<string, number[]>();
function hit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const xs = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (xs.length >= max) {
    windows.set(key, xs);
    return false;
  }
  xs.push(now);
  windows.set(key, xs);
  if (windows.size > 5000) for (const k of [...windows.keys()].slice(0, 1000)) windows.delete(k);
  return true;
}

export function admitSession(ip: string) {
  if (!hit(`s:${ipHash(ip)}`, limits().sessionsPerIpPerHour, 3600_000)) throw new RunError("rate-limited");
}

type LedgerEntry = { runId: string; ip: string; micro: number; done: boolean; at: Date };

function parseLedger(key: string, at: Date): LedgerEntry | null {
  const m = /^ledger\/\d{4}-\d{2}-\d{2}\/([0-9a-f]{16}|health)\/([a-z0-9-]+)_(\d+)\.(s|d)$/.exec(key);
  return m ? { ip: m[1], runId: m[2], micro: Number(m[3]), done: m[4] === "d", at } : null;
}

/** Today's spend so far (USD): settled runs at their cost, runs in flight at the estimate. */
export async function spendToday(store: Store): Promise<{ usd: number; runs: number; byIp: Map<string, LedgerEntry[]> }> {
  const files = await store.list(`ledger/${day()}/`);
  const byRun = new Map<string, LedgerEntry>();
  for (const f of files) {
    const e = parseLedger(f.key, f.uploadedAt);
    if (!e) continue;
    const prev = byRun.get(e.runId);
    if (!prev || (e.done && !prev.done)) byRun.set(e.runId, e);
  }
  const byIp = new Map<string, LedgerEntry[]>();
  let micro = 0;
  for (const e of byRun.values()) {
    micro += e.micro;
    byIp.set(e.ip, [...(byIp.get(e.ip) ?? []), e]);
  }
  return { usd: micro / 1e6, runs: byRun.size, byIp };
}

/**
 * Admit a live run, or throw "rate-limited" / "daily-cap". Writes a started record that counts towards both limits
 * until settleRun replaces it with the real cost. Health runs pass ip "health" and skip the per-IP limit.
 */
export async function admitRun(store: Store, ip: string, runId: string): Promise<{ ipKey: string }> {
  const L = limits();
  const ipKey = ip === "health" ? "health" : ipHash(ip);
  if (ipKey !== "health" && !hit(`r:${ipKey}`, L.runsPerIpPerHour, 3600_000)) throw new RunError("rate-limited");
  const today = await spendToday(store);
  if (today.usd + L.estimateUsd > L.dailyCapUsd) throw new RunError("daily-cap");
  if (ipKey !== "health") {
    const recent = (today.byIp.get(ipKey) ?? []).filter((e) => Date.now() - e.at.getTime() < 3600_000);
    if (recent.length >= L.runsPerIpPerHour) throw new RunError("rate-limited");
  }
  await store.put(`ledger/${day()}/${ipKey}/${runId}_${Math.round(L.estimateUsd * 1e6)}.s`, "1", "text/plain"); // Blob refuses empty bodies
  return { ipKey };
}

/** Record a finished (or failed) run's real model cost. */
export async function settleRun(store: Store, ipKey: string, runId: string, usd: number): Promise<void> {
  await store.put(`ledger/${day()}/${ipKey}/${runId}_${Math.round(usd * 1e6)}.d`, "1", "text/plain"); // Blob refuses empty bodies
}

// ── per-instance queue ───────────────────────────────────────────────────────────────────────────────────
let running = 0;
const waiting: (() => void)[] = [];

/** Wait for a pipeline slot on this instance. `onQueued` hears the position while waiting. Returns release(). */
export async function acquireSlot(onQueued: (position: number) => void, signal?: AbortSignal): Promise<() => void> {
  const L = limits();
  if (running >= L.maxConcurrent) {
    if (waiting.length >= L.maxQueue) throw new RunError("busy");
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        const i = waiting.indexOf(go);
        if (i >= 0) waiting.splice(i, 1);
        reject(new RunError("timeout", "The run was stopped."));
      };
      waiting.push(go);
      signal?.addEventListener("abort", stop, { once: true });
      onQueued(waiting.length);
    });
  }
  running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    const next = waiting.shift();
    if (next) next();
  };
}

/** For tests. */
export function resetLimits() {
  windows.clear();
  running = 0;
  waiting.length = 0;
}
