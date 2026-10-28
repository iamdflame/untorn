// Liveness: the hourly cron runs the fixed sample through the real pipeline and asserts the join accuracy against
// its answer key; GET /api/health reports the last run. Records: health/<iso time>.json, kept 14 days.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SAMPLE, SAMPLES } from "@/lib/run/samples";
import type { RunEvent } from "@/lib/run/types";
import { scoreRun, type AnswerKey, type RunScore } from "./accuracy";
import { randomId } from "./ids";
import { admitRun, settleRun } from "./limits";
import { liveDeps } from "./live";
import { runPipeline, type PipelineDeps } from "./pipeline";
import { readSample } from "./runs";
import { getJson, type Store } from "./store";

export type HealthRecord = {
  at: string;
  ok: boolean;
  sample: string;
  ms: number;
  stages: Record<string, number>;
  score: RunScore | null;
  costUsd: number;
  /** What failed, when ok is false. */
  problem?: string;
};

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return process.env[k] && Number.isFinite(v) ? v : d;
};

/** The bar a health run must clear (the recorded baseline: 12 of 13 joins right, 8 pieces placed correctly). */
export const healthBar = () => ({ joinAccuracy: num("HEALTH_MIN_JOIN_ACCURACY", 0.75), placed: num("HEALTH_MIN_PLACED", 7), maxMs: num("HEALTH_MAX_MS", 90_000) });

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a secret, only non-production may call. */
export function cronAllowed(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function runHealthCheck(store: Store, deps?: PipelineDeps): Promise<HealthRecord> {
  const sample = DEFAULT_SAMPLE;
  const runId = `health-${randomId(8)}`;
  const meter = { usd: 0 };
  const stages: Record<string, number> = {};
  const t0 = Date.now();
  let rec: HealthRecord;
  try {
    const { ipKey } = await admitRun(store, "health", runId);
    try {
      const { bytes, caption } = await readSample(sample);
      const keyFile = path.join(process.cwd(), "data", "samples", SAMPLES[sample].name, "key.json");
      const key = JSON.parse(await readFile(keyFile, "utf8")) as AnswerKey;
      const onEvent = (e: RunEvent) => {
        if (e.type === "stage" && e.status === "done" && e.ms !== undefined) stages[e.stage] = e.ms;
      };
      const result = await runPipeline(bytes, deps ?? liveDeps(async () => null), { runId, source: "health", sample, caption, meter }, onEvent);
      const score = scoreRun(result, key);
      const bar = healthBar();
      const problems = [
        score.joinAccuracy < bar.joinAccuracy && `join accuracy ${score.joinAccuracy.toFixed(2)} below ${bar.joinAccuracy}`,
        score.placedCorrectly < bar.placed && `placed ${score.placedCorrectly} below ${bar.placed}`,
        result.timings.total > bar.maxMs && `took ${result.timings.total} ms`,
        !result.transcripts.some((t) => t.ok && t.text.length > 100) && "no transcript",
      ].filter((p): p is string => !!p);
      rec = {
        at: new Date().toISOString(),
        ok: !problems.length,
        sample,
        ms: result.timings.total,
        stages,
        score,
        costUsd: result.cost.usd,
        ...(problems.length ? { problem: problems.join("; ") } : {}),
      };
    } finally {
      await settleRun(store, ipKey, runId, meter.usd).catch(() => {});
    }
  } catch (e) {
    const problem = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "failed";
    rec = { at: new Date().toISOString(), ok: false, sample, ms: Date.now() - t0, stages, score: null, costUsd: meter.usd, problem };
  }
  await store.put(`health/${rec.at.replace(/[:.]/g, "-")}.json`, JSON.stringify(rec), "application/json");
  lastCache = null;
  return rec;
}

let lastCache: { at: number; value: { last: HealthRecord | null; lastOk: HealthRecord | null } } | null = null;

/** The latest health run and the latest successful one (cached for a minute). */
export async function lastHealth(store: Store): Promise<{ last: HealthRecord | null; lastOk: HealthRecord | null }> {
  if (lastCache && Date.now() - lastCache.at < 60_000) return lastCache.value;
  const files = (await store.list("health/")).sort((a, b) => b.key.localeCompare(a.key));
  let last: HealthRecord | null = null;
  let lastOk: HealthRecord | null = null;
  for (const f of files.slice(0, 48)) {
    const r = await getJson<HealthRecord>(store, f.key);
    if (!r) continue;
    last ??= r;
    if (r.ok) {
      lastOk = r;
      break;
    }
  }
  lastCache = { at: Date.now(), value: { last, lastOk } };
  return lastCache.value;
}
