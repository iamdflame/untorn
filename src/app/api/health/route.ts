// GET /api/health: is the app up, can live runs start, and when did the fixed sample last run through the real
// pipeline successfully? GET /api/health?warm=1 is the first screen's warm-up ping: it answers at once (waking the
// function) and says whether live runs are paused, so the page can tell a visitor before they tear a page.

import { lastHealth } from "@/lib/server/health";
import { pauseAge, PAUSE_SHOW_MS, readPause } from "@/lib/server/live-status";
import { getStore } from "@/lib/server/store";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const store = getStore();
  const pause = await readPause(store).catch(() => null);
  const live = pause && pauseAge(pause) < PAUSE_SHOW_MS ? "paused" : "ok";
  if (new URL(request.url).searchParams.has("warm")) return Response.json({ ok: true, live }, { headers: HEADERS });
  const { last, lastOk } = await lastHealth(store).catch(() => ({ last: null, lastOk: null }));
  // the health cron runs every 12 hours (vercel.json): stale once a run and a half have been missed
  const stale = !lastOk || Date.now() - Date.parse(lastOk.at) > 18 * 3600_000;
  return Response.json(
    {
      ok: true,
      store: store.kind,
      modelKey: !!process.env.MODEL_API_KEY,
      live,
      ...(live === "paused" && pause ? { pausedSince: pause.at } : {}),
      pipeline: lastOk ? (stale ? "stale" : "healthy") : "unknown",
      lastSuccessfulRun: lastOk,
      lastRun: last,
    },
    { headers: HEADERS },
  );
}
