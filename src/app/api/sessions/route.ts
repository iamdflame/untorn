// POST /api/sessions: a short code for the phone handoff. Returns { code, url, expiresAt }.

import { ERRORS, errorBody, RunError } from "@/lib/run/errors";
import { admitSession, clientIp } from "@/lib/server/limits";
import { createSession } from "@/lib/server/sessions";
import { getStore } from "@/lib/server/store";

export async function POST(request: Request) {
  try {
    admitSession(clientIp(request));
    const s = await createSession(getStore());
    const url = new URL(`/c/${s.code}`, request.url).toString();
    return Response.json({ ...s, url }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof RunError) return Response.json(errorBody(e.code), { status: ERRORS[e.code].status });
    console.error("[sessions] create failed", e);
    return Response.json(errorBody("internal"), { status: 500 });
  }
}
