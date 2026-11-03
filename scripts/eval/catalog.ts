// The archive record, measured: each sample page's recorded transcript catalogued by the models compared, every
// record checked against the page (record.ts), and scored against an answer key read off the transcripts by hand.
//   pnpm tsx --env-file=.env scripts/eval/catalog.ts [models=muse-spark-1.3,muse-wonder-1.0] [repeats=1] [effort]
// Paid: one call per page, model and repeat (about $0.01 to $0.05 each). Writes .apex/build/catalog-eval.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PageRecord, RunResult } from "../../src/lib/run/types";
import { catalogPage, type MuseModel, type ReasoningEffort } from "../../src/lib/server/muse";
import { verifyRecord } from "../../src/lib/server/record";

type Key = {
  sample: string;
  page: number;
  kinds: string[];
  iso: string | null;
  /** Folded words, any one of which in the field's name makes it right; [] means the page doesn't say. */
  place: string[];
  from: string[];
  to: string[];
  /** Names the page states that any of the record's lists (or fields) should hold. */
  names: string[];
};

const KEYS: Key[] = [
  { sample: "chouteau-1903", page: 0, kinds: ["letter"], iso: "1903-09-05", place: ["louis"], from: ["chouteau"], to: ["dalton"], names: ["laclede", "de soto", "louisiana", "new orleans", "mississippi", "arkansas", "missouri historical"] },
  { sample: "fdr-1927", page: 0, kinds: ["letter"], iso: "1927-04-08", place: ["warm springs"], from: ["roosevelt"], to: ["julian"], names: ["fidelity and deposit", "new york", "meriwether"] },
  { sample: "stresemann-1922", page: 0, kinds: ["letter"], iso: "1922-05-11", place: ["berlin"], from: ["stresemann"], to: ["reimann"], names: ["reichstag", "deutschland", "elberfeld", "boeddinghaus"] },
  { sample: "stack-3-letters", page: 0, kinds: ["letter", "memo", "report"], iso: null, place: [], from: ["ngoai giao", "chinh phu", "viet-nam", "viet nam", "vietnam"], to: [], names: ["baodai", "san francisco", "france", "indonesia", "london", "consultative commission"] },
  { sample: "stack-3-letters", page: 1, kinds: ["letter"], iso: "1927-04-08", place: ["warm springs"], from: ["roosevelt"], to: ["julian"], names: ["fidelity and deposit", "new york", "meriwether"] },
  { sample: "stack-3-letters", page: 2, kinds: ["letter"], iso: "1918-05-18", place: ["washington"], from: ["ayars", "surgeon general", "war department"], to: ["leonard"], names: ["michigan avenue", "st. louis", "u. s. army"] },
  { sample: "hand-torn-6", page: 0, kinds: ["report", "other", "article"], iso: null, place: [], from: [], to: [], names: [] },
];

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

type Score = { field: string; verdict: "right" | "wrong" | "missing" | "spurious" | "empty" };

function score(rec: PageRecord, k: Key): { fields: Score[]; namesFound: number; names: number } {
  const fields: Score[] = [];
  const named = (field: string, f: { name: string } | null, want: string[]) => {
    if (!want.length) fields.push({ field, verdict: f ? "spurious" : "empty" });
    else if (!f) fields.push({ field, verdict: "missing" });
    else fields.push({ field, verdict: want.some((w) => fold(f.name).includes(w)) ? "right" : "wrong" });
  };
  fields.push({ field: "kind", verdict: k.kinds.includes(rec.kind) ? "right" : "wrong" });
  if (!k.iso) fields.push({ field: "date", verdict: rec.date ? "spurious" : "empty" });
  else if (!rec.date) fields.push({ field: "date", verdict: "missing" });
  else fields.push({ field: "date", verdict: rec.date.iso === k.iso ? "right" : rec.date.iso === null ? "missing" : "wrong" });
  named("place", rec.place, k.place);
  named("from", rec.from, k.from);
  named("to", rec.to, k.to);
  const all = [rec.place, rec.from, rec.to, ...rec.people, ...rec.places, ...rec.organisations].filter(Boolean).map((f) => fold(f!.name + " " + f!.quote));
  const namesFound = k.names.filter((n) => all.some((a) => a.includes(n))).length;
  return { fields, namesFound, names: k.names.length };
}

async function main() {
  const models = (process.argv[2] ?? "muse-spark-1.3,muse-wonder-1.0").split(",") as MuseModel[];
  const repeats = Number(process.argv[3] ?? 1);
  const effort = process.argv[4] as ReasoningEffort | undefined;
  const rows: unknown[] = [];
  const totals: Record<string, { right: number; wrong: number; missing: number; spurious: number; empty: number; dropped: number; namesFound: number; names: number; ms: number[]; usd: number; failed: number }> = {};
  for (const model of models) {
    totals[model] = { right: 0, wrong: 0, missing: 0, spurious: 0, empty: 0, dropped: 0, namesFound: 0, names: 0, ms: [], usd: 0, failed: 0 };
    for (let rep = 0; rep < repeats; rep++) {
      await Promise.all(
        KEYS.map(async (k) => {
          const r = JSON.parse(readFileSync(path.join("public/samples", k.sample, "result.json"), "utf8")) as RunResult;
          const tr = r.transcripts[k.page];
          const out = await catalogPage(tr.text, { model, onLog: () => {}, ...(effort ? { effort } : {}) });
          const t = totals[model];
          t.usd += out.meta.costUsd;
          t.ms.push(out.meta.ms);
          if (!out.ok) {
            t.failed++;
            rows.push({ model, rep, sample: k.sample, page: k.page, error: out.error });
            return;
          }
          const { record, dropped } = verifyRecord(out.value, tr.text);
          const s = score(record, k);
          for (const f of s.fields) t[f.verdict]++;
          t.dropped += dropped;
          t.namesFound += s.namesFound;
          t.names += s.names;
          rows.push({ model, rep, sample: k.sample, page: k.page, ms: out.meta.ms, usd: out.meta.costUsd, scores: s, dropped, raw: out.value, record });
        }),
      );
    }
  }
  mkdirSync(".apex/build", { recursive: true });
  writeFileSync(`.apex/build/catalog-eval${effort ? "-" + effort : ""}.json`, JSON.stringify({ at: new Date().toISOString(), models, repeats, totals, rows }, null, 1));
  for (const [m, t] of Object.entries(totals)) {
    const ms = [...t.ms].sort((a, b) => a - b);
    console.log(
      `${m}: fields right ${t.right}, wrong ${t.wrong}, missing ${t.missing}, spurious ${t.spurious}, rightly empty ${t.empty}; quotes not on the page (dropped) ${t.dropped}; key names found ${t.namesFound}/${t.names}; failed ${t.failed}; median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s, max ${(ms.at(-1)! / 1000).toFixed(1)} s; $${t.usd.toFixed(3)}`,
    );
  }
  for (const row of rows as { model: string; sample: string; page: number; scores?: { fields: Score[] }; record?: PageRecord }[]) {
    const bad = row.scores?.fields.filter((f) => f.verdict !== "right" && f.verdict !== "empty").map((f) => `${f.field}:${f.verdict}`) ?? ["FAILED"];
    if (bad.length) console.log(`  ${row.model} ${row.sample}/${row.page}: ${bad.join(" ")}`);
  }
}

main();
