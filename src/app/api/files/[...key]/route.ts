// GET /api/files/runs/<runId>/<file>: a run's photo, page images and result, from the private store.
// Only run files are served; uploaded photos waiting for a run are never readable.

import { errorBody } from "@/lib/run/errors";
import { getStore } from "@/lib/server/store";

const ALLOWED = /^runs\/[a-z0-9-]{8,48}\/(photo\.jpg|page-\d{1,2}\.png|result\.json)$/;

export async function GET(request: Request, ctx: RouteContext<"/api/files/[...key]">) {
  const key = (await ctx.params).key.join("/");
  if (!ALLOWED.test(key)) return Response.json(errorBody("not-found"), { status: 404 });
  const f = await getStore().get(key);
  if (!f) return Response.json(errorBody("not-found"), { status: 404 });
  const download = new URL(request.url).searchParams.has("download");
  const [, runId, name] = key.split("/");
  return new Response(Buffer.from(f.bytes), {
    headers: {
      "Content-Type": f.contentType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...(download ? { "Content-Disposition": `attachment; filename="untorn-${runId}-${name}"` } : {}),
    },
  });
}
