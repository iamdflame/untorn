// GET /api/runs/<runId>: a stored run (RunResult JSON), for /r/<runId> replays and the JSON download.

import { ERRORS, errorBody } from "@/lib/run/errors";
import { isRunId } from "@/lib/server/ids";
import { getStore } from "@/lib/server/store";

export async function GET(request: Request, ctx: RouteContext<"/api/runs/[runId]">) {
  const { runId } = await ctx.params;
  if (!isRunId(runId)) return Response.json(errorBody("not-found"), { status: 404 });
  const f = await getStore().get(`runs/${runId}/result.json`);
  if (!f) return Response.json(errorBody("not-found"), { status: ERRORS["not-found"].status });
  const download = new URL(request.url).searchParams.has("download");
  return new Response(Buffer.from(f.bytes), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=300",
      ...(download ? { "Content-Disposition": `attachment; filename="untorn-${runId}.json"` } : {}),
    },
  });
}
