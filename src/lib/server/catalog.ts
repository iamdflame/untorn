// The archive record step. After a run's done event, Muse Wonder writes a record for each transcribed page from its
// transcript, and record.ts keeps only the fields that quote the page. It runs after the page is on screen, so the
// run takes no longer; each record streams as it lands, and the stored result is rewritten with them.
// A failed record is a note on the result, never an error: the run itself has already succeeded.

import type { CatalogOut, RunEvent, RunResult } from "@/lib/run/types";
import type { catalogPage } from "./muse";
import { verifyRecord } from "./record";

/** Fewest letters a transcript needs before a record is worth asking for. */
export const MIN_RECORD_LETTERS = 20;

type CatalogDeps = {
  catalogPage: typeof catalogPage;
  putAsset: (name: string, bytes: Uint8Array, contentType: string) => Promise<string | null>;
};

type CatalogCtx = {
  signal?: AbortSignal;
  /** Updated with the model spend as it happens (the run's ledger settles from it). */
  meter?: { usd: number };
  emit: (e: RunEvent) => void;
  /** Run time now (ms from the run's start). */
  t: () => number;
};

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

const quietLog = (entry: { outcome: string; fn: string; attempt: number; error?: string; status: number | null; ms: number }) => {
  if (entry.outcome !== "ok") console.warn(`[muse] ${entry.fn} attempt ${entry.attempt} ${entry.outcome} ${entry.error ?? ""} ${entry.status ?? ""} ${entry.ms}ms`);
};

/** Write, check and stream the archive records of a finished run; returns the result with them (stored too). */
export async function catalogRun(result: RunResult, deps: CatalogDeps, ctx: CatalogCtx): Promise<RunResult> {
  const pages = result.transcripts.filter((t) => t.ok && letters(t.text) >= MIN_RECORD_LETTERS);
  if (!pages.length) return result;
  for (const t of pages) ctx.emit({ type: "catalog", t: ctx.t(), catalog: { page: t.page, status: "pending", record: null, dropped: 0, model: null } });
  let usd = 0;
  const catalogs = await Promise.all(
    pages.map(async (t): Promise<CatalogOut> => {
      const out = await deps.catalogPage(t.text, { signal: ctx.signal, onLog: quietLog });
      usd += out.meta.costUsd;
      if (ctx.meter) ctx.meter.usd += out.meta.costUsd;
      const base = { page: t.page, model: out.meta.model, ms: out.meta.ms, costUsd: Math.round(out.meta.costUsd * 1e5) / 1e5 };
      const c: CatalogOut = out.ok ? { ...base, status: "done", ...verifyRecord(out.value, t.text) } : { ...base, status: "failed", record: null, dropped: 0, error: out.error.code };
      ctx.emit({ type: "catalog", t: ctx.t(), catalog: c });
      return c;
    }),
  );
  const next: RunResult = {
    ...result,
    catalogs,
    cost: { ...result.cost, usd: Math.round((result.cost.usd + usd) * 10000) / 10000, museCalls: result.cost.museCalls + catalogs.length },
  };
  await deps.putAsset("result.json", new TextEncoder().encode(JSON.stringify(next)), "application/json").catch(() => null);
  return next;
}
