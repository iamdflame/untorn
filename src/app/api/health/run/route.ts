// POST (or cron GET) /api/health/run: run the fixed sample through the real pipeline and assert the join accuracy.
// Every 12 hours by Vercel Cron (vercel.json). Needs `Authorization: Bearer $CRON_SECRET`. 200 when healthy, 503 when not.

import { cronAllowed, runHealthCheck } from "@/lib/server/health";
import { getStore } from "@/lib/server/store";

export const maxDuration = 300;

async function handle(request: Request) {
  if (!cronAllowed(request)) return Response.json({ error: { code: "forbidden" } }, { status: 401 });
  const rec = await runHealthCheck(getStore());
  if (!rec.ok) console.error("[health] sample run failed:", rec.problem);
  return Response.json(rec, { status: rec.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
