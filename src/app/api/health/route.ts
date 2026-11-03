// GET /api/health: is the app up, can live runs start, and when did the fixed sample last run through the real
// pipeline successfully? GET /api/health?warm=1 is the first screen's warm-up ping: it answers at once (waking the
// function) and says whether live runs are paused, so the page can tell a visitor before they tear a page.

import { lastHealth } from "@/lib/server/health";
import { openWeightsReady } from "@/lib/server/live";
import { pauseAge, PAUSE_SHOW_MS, readPause, refusedWithin } from "@/lib/server/live-status";
import { getStore } from "@/lib/server/store";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const store = getStore();
  const pause = await readPause(store).catch(() => null);
  // Meta's API refused the key: runs go on with the paper finder, read by the open weights when their host answers
  // ("open-weights") or placed by their edges alone ("outlines-only"); the first screen says which. The open-weights
  // switch stays hidden while their host turns our key away: runs ask it again after a few minutes, and its first
  // answer lifts the record
  const openWeights = openWeightsReady() && !(await refusedWithin(store, "open", PAUSE_SHOW_MS).catch(() => false));
  const live = pause && pauseAge(pause) < PAUSE_SHOW_MS ? (openWeights ? "open-weights" : "outlines-only") : "ok";
  if (new URL(request.url).searchParams.has("warm")) return Response.json({ ok: true, live, openWeights }, { headers: HEADERS });
  const { last, lastOk } = await lastHealth(store).catch(() => ({ last: null, lastOk: null }));
  // the health cron runs every 12 hours (vercel.json): stale once a run and a half have been missed
  const stale = !lastOk || Date.now() - Date.parse(lastOk.at) > 18 * 3600_000;
  return Response.json(
    {
      ok: true,
      store: store.kind,
      modelKey: !!process.env.MODEL_API_KEY,
      live,
      openWeights,
      ...(live !== "ok" && pause ? { pausedSince: pause.at } : {}),
      pipeline: lastOk ? (stale ? "stale" : "healthy") : "unknown",
      lastSuccessfulRun: lastOk,
      lastRun: last,
    },
    { headers: HEADERS },
  );
}
