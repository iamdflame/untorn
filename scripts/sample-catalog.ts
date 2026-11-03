// The recorded samples' archive records: each sample's recorded transcripts catalogued by the live record step
// (src/lib/server/catalog.ts: Muse Wonder, then every quote checked against the page), written into its result.json
// and result-lite.json, so a replay shows the record a live run would.
//   pnpm tsx --env-file=.env scripts/sample-catalog.ts [sample ...] [--force]
// Paid: one Muse Wonder call per transcribed page (about $0.015 each).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../src/lib/run/types";
import { catalogRun } from "../src/lib/server/catalog";
import { catalogPage } from "../src/lib/server/muse";
import { recordTitle } from "../src/lib/run/record-view";

const ROOT = path.join(process.cwd(), "public", "samples");

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const names = args.filter((a) => !a.startsWith("--"));
  const samples = (names.length ? names : readdirSync(ROOT)).filter((n) => existsSync(path.join(ROOT, n, "result.json")));
  let usd = 0;
  for (const name of samples) {
    const file = path.join(ROOT, name, "result.json");
    const result = JSON.parse(readFileSync(file, "utf8")) as RunResult;
    if (result.catalogs?.length && !force) {
      console.log(`${name}: has records (--force to redo)`);
      continue;
    }
    // a redo replaces the old records: their spend comes off the run's cost before the new one goes on
    const old = result.catalogs ?? [];
    const cost = { ...result.cost, usd: Math.round((result.cost.usd - old.reduce((s, c) => s + (c.costUsd ?? 0), 0)) * 10000) / 10000, museCalls: result.cost.museCalls - old.length };
    const before = cost.usd;
    const next = await catalogRun(
      { ...result, cost, catalogs: undefined },
      { catalogPage, putAsset: async (_n, bytes) => (writeFileSync(file, bytes), file) },
      { emit: () => {}, t: () => result.timings.total },
    );
    usd += next.cost.usd - before;
    const liteFile = path.join(ROOT, name, "result-lite.json");
    if (existsSync(liteFile)) {
      const lite = JSON.parse(readFileSync(liteFile, "utf8")) as RunResult;
      writeFileSync(liteFile, JSON.stringify({ ...lite, catalogs: next.catalogs, cost: next.cost }));
    }
    for (const c of next.catalogs ?? []) {
      console.log(`${name}/${c.page}: ${c.status}${c.record ? ` · ${recordTitle(c.record)} · dropped ${c.dropped}` : ""} · ${((c.ms ?? 0) / 1000).toFixed(1)} s $${(c.costUsd ?? 0).toFixed(4)}${c.error ? ` · ${c.error}` : ""}`);
    }
  }
  console.log(`spent $${usd.toFixed(3)}`);
}

main();
