// Cron GET /api/cleanup: delete uploaded photos, runs and sessions older than 24 h (the privacy promise on the
// capture page), ledger records older than 3 days and health records older than 14 days. Sample runs are static
// files, not in the store.

import { cronAllowed } from "@/lib/server/health";
import { getStore } from "@/lib/server/store";

export const maxDuration = 120;

const H = 3600_000;
const RULES: [prefix: string, maxAgeMs: number][] = [
  ["photos/", 23 * H],
  ["runs/", 23 * H],
  ["sessions/", 23 * H],
  ["ledger/", 72 * H],
  ["health/", 14 * 24 * H],
];

export async function GET(request: Request) {
  if (!cronAllowed(request)) return Response.json({ error: { code: "forbidden" } }, { status: 401 });
  const store = getStore();
  const now = Date.now();
  const deleted: Record<string, number> = {};
  for (const [prefix, maxAge] of RULES) {
    const old = (await store.list(prefix)).filter((f) => now - f.uploadedAt.getTime() > maxAge).map((f) => f.key);
    if (old.length) await store.del(old);
    deleted[prefix] = old.length;
  }
  return Response.json({ ok: true, deleted }, { headers: { "Cache-Control": "no-store" } });
}
