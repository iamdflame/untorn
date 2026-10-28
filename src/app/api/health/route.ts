// GET /api/health: is the app up, and when did the fixed sample last run through the real pipeline successfully?
// GET /api/health?warm=1 is the first screen's warm-up ping (answers at once, wakes the function).

import { lastHealth } from "@/lib/server/health";
import { getStore } from "@/lib/server/store";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.has("warm")) return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  const store = getStore();
  const { last, lastOk } = await lastHealth(store).catch(() => ({ last: null, lastOk: null }));
  const stale = !lastOk || Date.now() - Date.parse(lastOk.at) > 2 * 3600_000;
  return Response.json(
    {
      ok: true,
      store: store.kind,
      modelKey: !!process.env.MODEL_API_KEY,
      pipeline: lastOk ? (stale ? "stale" : "healthy") : "unknown",
      lastSuccessfulRun: lastOk,
      lastRun: last,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
