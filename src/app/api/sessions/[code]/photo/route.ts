// POST /api/sessions/<code>/photo: the phone's photo (multipart `photo`, or the raw image as the body).
// Type-checked by content, at most 15 MB. Returns { ok: true }.

import { ERRORS, errorBody, RunError } from "@/lib/run/errors";
import { MAX_UPLOAD_BYTES } from "@/lib/run/types";
import { isSessionCode } from "@/lib/server/ids";
import { attachPhoto } from "@/lib/server/sessions";
import { getStore } from "@/lib/server/store";

export const maxDuration = 60;

export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[code]/photo">) {
  const code = (await ctx.params).code.toUpperCase();
  try {
    if (!isSessionCode(code)) throw new RunError("not-found");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 256 * 1024) throw new RunError("too-large");
    let bytes: Uint8Array;
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const file = (await request.formData()).get("photo");
      if (!file || typeof file === "string") throw new RunError("bad-type", "No photo in the upload.");
      bytes = new Uint8Array(await file.arrayBuffer());
    } else bytes = new Uint8Array(await request.arrayBuffer());
    await attachPhoto(getStore(), code, bytes);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof RunError) return Response.json(errorBody(e.code, e.message), { status: ERRORS[e.code].status });
    console.error("[sessions] photo failed", e);
    return Response.json(errorBody("internal"), { status: 500 });
  }
}
