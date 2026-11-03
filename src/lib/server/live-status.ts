// Whether live runs can start. When Meta's model API turns our key itself away (no credit left, the key revoked),
// every live run would fail the same way and no retry helps. The first such refusal pauses live runs: the first
// screen says so before anyone tears a page, new runs fail at once for a few minutes and then try the API again, and
// the next run that gets through (a visitor's or the 12-hourly health run) lifts the pause.

import type { Store } from "./store";
import { getJson } from "./store";

export { isAccountRefusal } from "./refusal";

export const PAUSE_KEY = "live/paused.json";
/** After a refusal, new runs fail at once for this long before trying the API again. */
export const PAUSE_FAIL_FAST_MS = 10 * 60_000;
/** The first screen keeps saying "paused" this long after the last refusal; the 12-hourly health run tries again. */
export const PAUSE_SHOW_MS = 13 * 3600_000;

export type Pause = { at: string; reason: string };

let cache: { at: number; value: Pause | null } | null = null;

/** The current pause, if any (cached for 30 s per instance: the first screen asks on every visit). */
export async function readPause(store: Store, now = Date.now()): Promise<Pause | null> {
  if (cache && now - cache.at < 30_000) return cache.value;
  const value = await getJson<Pause>(store, PAUSE_KEY).catch(() => null);
  cache = { at: now, value };
  return value;
}

export async function setPause(store: Store, reason: string, now = Date.now()): Promise<void> {
  const value: Pause = { at: new Date(now).toISOString(), reason: reason.slice(0, 200) };
  cache = { at: now, value };
  await store.put(PAUSE_KEY, JSON.stringify(value), "application/json");
}

/** A run got through: lift the pause if one is recorded. */
export async function clearPause(store: Store, now = Date.now()): Promise<void> {
  const known = cache && now - cache.at < 30_000 ? cache.value : await getJson<Pause>(store, PAUSE_KEY).catch(() => null);
  cache = { at: now, value: null };
  if (known) await store.del([PAUSE_KEY]);
}

export const pauseAge = (p: Pause, now = Date.now()) => now - Date.parse(p.at);

/** For tests: forget the cached pause. */
export function resetPauseCache() {
  cache = null;
}
