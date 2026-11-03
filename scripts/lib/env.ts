// Shared helpers for the live and bench scripts (never imported by the app).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Load MODEL_API_KEY (and BASETEN_API_KEY, the open-weights host, when present) from the worktree's .env without printing them. */
export function loadEnv(): void {
  const p = join(process.cwd(), ".env");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  for (const key of ["MODEL_API_KEY", "BASETEN_API_KEY"]) {
    if (process.env[key]) continue;
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
    if (m) process.env[key] = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY missing (.env)");
}

/** Where bench output goes: outside the repo, next to the build report. */
export const OUT_ROOT = process.env.REJOIN_BENCH_OUT ?? "C:/Users/Dflame/Pictures/rr/.apex/build/S2-models";
export const SPIKES = "C:/Users/Dflame/Pictures/rr/.apex/spikes/v3";

export function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 1));
}

/** Append one line to the spend ledger (every live call's estimated cost). */
export function ledger(entry: Record<string, unknown>): void {
  mkdirSync(OUT_ROOT, { recursive: true });
  appendFileSync(join(OUT_ROOT, "ledger.ndjson"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/** A fetch that also saves each response body (for recorded test fixtures). Never saves request headers. */
export function recordingFetch(save: (url: string, reqBody: string, status: number, resBody: string) => void): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const text = await res.text();
    save(String(input), typeof init?.body === "string" ? init.body : "", res.status, text);
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

export const median = (xs: number[]) => quantile(xs, 0.5);
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
