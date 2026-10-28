// GET /api/sessions/<code>: { status: "waiting" | "photo" | "expired", photoId? }. The laptop polls it every 1.5 s.

import { ERRORS, errorBody, RunError } from "@/lib/run/errors";
import { getSession } from "@/lib/server/sessions";
import { getStore } from "@/lib/server/store";

export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[code]">) {
  const { code } = await ctx.params;
  try {
    const s = await getSession(getStore(), code.toUpperCase());
    return Response.json(s, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof RunError) return Response.json(errorBody(e.code), { status: ERRORS[e.code].status });
    console.error("[sessions] read failed", e);
    return Response.json(errorBody("internal"), { status: 500 });
  }
}
