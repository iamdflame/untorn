// What the model hosts are doing. When Meta's model API turns our key itself away (no credit left, the key revoked),
// no retry helps, but a run still goes on: the paper finder outlines the pieces (paper.ts) and the reads go to Meta's
// open weights when their host answers. A refusal is recorded per host: the first screen says how runs go meanwhile,
// runs skip a refusing host for a few minutes and then ask it again, and the next run that gets through (a visitor's
// or the 12-hourly health run) lifts the record.

import type { Store } from "./store";
import { getJson } from "./store";

export { isAccountRefusal } from "./refusal";

export const PAUSE_KEY = "live/paused.json";
/** The same record for the open-weights host (Baseten): it turned our key away too (no credit left there, say). */
export const OPEN_PAUSE_KEY = "live/open-refused.json";
/** After a refusal, new runs skip that host for this long before asking it again. */
export const PAUSE_FAIL_FAST_MS = 10 * 60_000;
/** The first screen keeps saying "paused" this long after the last refusal; the 12-hourly health run tries again. */
export const PAUSE_SHOW_MS = 13 * 3600_000;

export type Pause = { at: string; reason: string };
/** "meta": Meta's model API (SAM 3.1, Muse Spark, Muse Wonder); "open": the open-weights host. */
export type Host = "meta" | "open";

const KEY: Record<Host, string> = { meta: PAUSE_KEY, open: OPEN_PAUSE_KEY };
const cache: Record<Host, { at: number; value: Pause | null } | null> = { meta: null, open: null };

/** The current pause, if any (cached for 30 s per instance: the first screen asks on every visit). */
export async function readPause(store: Store, now = Date.now(), host: Host = "meta"): Promise<Pause | null> {
  const c = cache[host];
  if (c && now - c.at < 30_000) return c.value;
  const value = await getJson<Pause>(store, KEY[host]).catch(() => null);
  cache[host] = { at: now, value };
  return value;
}

export async function setPause(store: Store, reason: string, now = Date.now(), host: Host = "meta"): Promise<void> {
  const value: Pause = { at: new Date(now).toISOString(), reason: reason.slice(0, 200) };
  cache[host] = { at: now, value };
  await store.put(KEY[host], JSON.stringify(value), "application/json");
}

/** A run got through: lift the pause if one is recorded. */
export async function clearPause(store: Store, now = Date.now(), host: Host = "meta"): Promise<void> {
  const c = cache[host];
  const known = c && now - c.at < 30_000 ? c.value : await getJson<Pause>(store, KEY[host]).catch(() => null);
  cache[host] = { at: now, value: null };
  if (known) await store.del([KEY[host]]);
}

export const pauseAge = (p: Pause, now = Date.now()) => now - Date.parse(p.at);

/** Has this host refused within the last `ms`? */
export async function refusedWithin(store: Store, host: Host, ms: number, now = Date.now()): Promise<boolean> {
  const p = await readPause(store, now, host).catch(() => null);
  return !!p && pauseAge(p, now) < ms;
}

/**
 * What a finished run says about each host: SAM 3.1 is asked first in every run, so its answer (or refusal) speaks for
 * Meta's API; an open-weights read that answered, or that the host refused for its account, speaks for that host.
 */
export function hostsSeen(result: { warnings: { code: string }[]; reads: { ok: boolean; model?: string; error?: string }[]; transcripts: { ok: boolean; model?: string; error?: string }[] }) {
  const open = [...result.reads, ...result.transcripts].filter((r) => r.model === "muse-spark-open");
  return {
    metaRefused: result.warnings.some((w) => w.code === "sam-refused"),
    openAnswered: open.some((r) => r.ok),
    openRefused: open.some((r) => !r.ok && (r.error === "billing" || r.error === "auth")),
  };
}

/** Record what a finished run learnt about both hosts. */
export async function notePauses(store: Store, result: Parameters<typeof hostsSeen>[0], why: string): Promise<void> {
  const seen = hostsSeen(result);
  await (seen.metaRefused ? setPause(store, `${why}: SAM 3.1 refused the key`) : clearPause(store)).catch(() => {});
  if (seen.openAnswered) await clearPause(store, Date.now(), "open").catch(() => {});
  else if (seen.openRefused) await setPause(store, `${why}: the open-weights host refused the key`, Date.now(), "open").catch(() => {});
}

/** For tests: forget the cached pauses. */
export function resetPauseCache() {
  cache.meta = null;
  cache.open = null;
}
