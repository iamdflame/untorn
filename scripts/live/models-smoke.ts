// Live smoke test: one real call per model-layer function, against the real Meta Model API (~$0.06 in total).
// Usage: pnpm tsx scripts/live/models-smoke.ts
// Prints each result with its latency and estimated cost, saves the raw answers under <OUT_ROOT>/smoke/ (response
// bodies only, never request headers), and exits non-zero if any call failed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { chooseContinuation, readPage, sortFragments, translate, verifySeam, type MuseOutcome } from "../../src/lib/server/muse";
import { segmentFragments } from "../../src/lib/server/segment";
import { ledger, loadEnv, OUT_ROOT, recordingFetch, SPIKES, writeJson } from "../lib/env";

async function main() {
  loadEnv();
  const saved: Record<string, unknown[]> = {};
  const tape = (fn: string) =>
    recordingFetch((_u, _b, status, res) => {
      (saved[fn] ??= []).push({ status, body: res.startsWith("{") ? JSON.parse(res) : res.slice(0, 20000) });
    });
  const jpeg = (path: string) => ({ data: new Uint8Array(readFileSync(path)), mime: "image/jpeg" as const });
  const pages = join(OUT_ROOT, "photos", "pages");
  let failed = 0;
  let total = 0;
  const report = <T,>(fn: string, r: MuseOutcome<T>) => {
    total += r.meta.costUsd;
    ledger({ what: `smoke ${fn}`, cost: r.meta.costUsd });
    if (!r.ok) failed++;
    console.log(`\n${fn}: ${r.ok ? "ok" : `FAILED ${r.error.code}: ${r.error.message}`} in ${r.meta.ms} ms, ${r.meta.attempts} attempt(s), $${r.meta.costUsd.toFixed(4)}`);
    if (r.ok) console.log(JSON.stringify(r.value, null, 1).slice(0, 1200));
  };

  // 1. segmentFragments: the 12-piece simulated photo
  const seg = await segmentFragments(readFileSync(join(OUT_ROOT, "photos", "sim12", "photo.jpg")), { fetchImpl: tape("segmentFragments") });
  total += seg.costUsd;
  ledger({ what: "smoke segmentFragments", sam: seg.samCalls, cost: seg.costUsd });
  console.log(`segmentFragments: ${seg.fragments.length} fragments (pass 1 found ${seg.pass1.count}) in ${seg.timings.totalMs} ms, ${seg.samCalls} SAM call(s), $${seg.costUsd.toFixed(4)}; methods ${[...new Set(seg.fragments.map((f) => f.method))].join(",")}`);
  if (seg.fragments.length !== 12) failed++;

  // 2. verifySeam: a true join from the spike set
  report("verifySeam", await verifySeam(jpeg(join(SPIKES, "cw1", "00-true.jpg")), { fetchImpl: tape("verifySeam") }));

  // 3. chooseContinuation: a stack-tear trial (truth B)
  report("chooseContinuation", await chooseContinuation(jpeg(join(SPIKES, "cw3", "trial-00-truth-B.jpg")), 3, { fetchImpl: tape("chooseContinuation") }));

  // 4. readPage: the letter with a piece missing (a desk-coloured hole over part of the body text)
  const page = readFileSync(join(pages, "chouteau.png"));
  const hole = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="1071"><polygon points="430,330 820,300 820,520 610,560 470,470" fill="#7d5a3c"/></svg>`,
  );
  const holed = await sharp(page).composite([{ input: hole }]).jpeg({ quality: 90 }).toBuffer();
  const read = await readPage({ data: new Uint8Array(holed), mime: "image/jpeg" }, { fetchImpl: tape("readPage") });
  report("readPage", read);

  // 5. translate the reading (gap markers must survive)
  const text = read.ok ? read.value.text.split("\n").slice(0, 14).join("\n") : "Dear Miss Dalton, I think the following will fully […] your inquiries.";
  report("translate", await translate(text, "de", { fetchImpl: tape("translate") }));

  // 6. sortFragments (Muse Wonder): 2 crops of the typed page, 2 of the handwritten one, shuffled
  const crop = async (file: string, left: number, top: number) =>
    ({ data: new Uint8Array(await sharp(join(pages, file)).extract({ left, top, width: 300, height: 220 }).jpeg({ quality: 88 }).toBuffer()), mime: "image/jpeg" as const });
  const crops = [await crop("typed.png", 60, 100), await crop("hand.png", 60, 120), await crop("hand.png", 380, 300), await crop("typed.png", 420, 330)];
  const sorted = await sortFragments(crops, { fetchImpl: tape("sortFragments") });
  report("sortFragments", sorted);
  if (sorted.ok) {
    const truth = ["typed", "hand", "hand", "typed"];
    const pure = sorted.value.groups.every((g) => new Set(g.fragments.map((i) => truth[i])).size === 1);
    console.log(`sortFragments groups ${JSON.stringify(sorted.value.groups.map((g) => g.fragments))}: ${pure && sorted.value.groups.length === 2 ? "correct" : "NOT the true split"} (truth [[0,3],[1,2]])`);
  }

  writeJson(join(OUT_ROOT, "smoke", "responses.json"), saved);
  console.log(`\nsmoke total ≈ $${total.toFixed(4)}; ${failed ? `${failed} FAILED` : "all ok"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
