// Muse Spark Open (Meta's open weights, on Baseten) against Muse Spark 1.3, on the jobs Untorn gives a reading model:
// the seam reads (the spike's 24 binary seams and 12 three-way stacks, with answers) and the page transcription (the
// samples' recorded page renders, against their reference texts, as character error rate).
//   pnpm tsx --env-file=.env scripts/eval/open-weights.ts [probe | pages]
// Needs BASETEN_API_KEY (and MODEL_API_KEY for the comparison). Paid: 41 calls per model. Writes
// .apex/build/open-weights.json (`pages` reruns only the transcriptions and keeps the stored seam and stack rows).
// `probe` makes one small call per candidate model id and stops.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cer } from "../../src/lib/server/accuracy";
import { chooseContinuation, OPEN_API_BASE, readPage, verifySeam, type MuseModel, type MuseOutcome } from "../../src/lib/server/muse";
import { mapLimit } from "../../src/lib/server/segment";

const SPIKES = "C:/Users/Dflame/Pictures/rr/.apex/spikes/v3";
const MODELS: MuseModel[] = ["muse-spark-open", "muse-spark-1.3"];
const PAGES = [
  ["fdr-1927", 0],
  ["stresemann-1922", 0],
  ["stack-3-letters", 0],
  ["stack-3-letters", 1],
  ["stack-3-letters", 2],
] as const;
const OUT = ".apex/build/open-weights.json";

/** A rebuilt page's reference: the sample's reference text it matches best (a stack's pages come back in any order). */
function refFor(name: string, text: string): { ref: string; cer: number } {
  const dir = path.join("data/samples", name);
  const refs = readdirSync(dir).filter((f) => /^ref-page\d+\.txt$/.test(f));
  const scored = refs.map((f) => ({ ref: f, cer: cer(text, readFileSync(path.join(dir, f), "utf8")) }));
  return scored.sort((a, b) => a.cer - b.cer)[0];
}

async function probe() {
  const key = process.env.BASETEN_API_KEY;
  if (!key) throw new Error("BASETEN_API_KEY missing (.env)");
  for (const id of [process.env.OPEN_MODEL_ID, "meta-models/muse-spark-open-1026", "muse-spark-open-1026", "meta-models/muse-spark-open", "muse-spark-open"].filter(Boolean) as string[]) {
    const t0 = Date.now();
    const res = await fetch(`${OPEN_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "untorn-check/1.0" },
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 400 }),
    });
    const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
    console.log(`${id}: HTTP ${res.status} in ${Date.now() - t0} ms: ${JSON.stringify(j?.choices?.[0]?.message?.content ?? j?.error?.message ?? j).slice(0, 120)}`);
    if (res.ok) {
      console.log(`works: set OPEN_MODEL_ID=${id} if it isn't the default`);
      return;
    }
  }
}

type Row = { model: MuseModel; task: string; item: string; ok: boolean; right: boolean | null; cer?: number; ref?: string; text?: string; ms: number; usd: number; error?: string };

async function main() {
  if (process.argv[2] === "probe") return probe();
  const pagesOnly = process.argv[2] === "pages";
  const rows: Row[] = pagesOnly ? (JSON.parse(readFileSync(OUT, "utf8")).rows as Row[]).filter((r) => r.task !== "page") : [];
  const note = (model: MuseModel, task: string, item: string, o: MuseOutcome<unknown>, right: boolean | null, extra: Partial<Row> = {}) =>
    rows.push({ model, task, item, ok: o.ok, right, ms: o.meta.ms, usd: o.meta.costUsd, ...(o.ok ? {} : { error: o.error.code }), ...extra });
  for (const model of MODELS) {
    if (!pagesOnly) await seamsAndStacks(model, note);
    // pages: transcribe the recorded rebuilt page, scored against the reference text it matches
    await mapLimit([...PAGES], 3, async ([name, k]) => {
      const png = new Uint8Array(readFileSync(path.join("public/samples", name, `page-${k}.png`)));
      const o = await readPage({ data: png, mime: "image/png" }, { model, effort: "minimal", onLog: () => {} });
      const m = o.ok ? refFor(name, o.value.text) : null;
      note(model, "page", `${name}/${k}`, o, null, m && o.ok ? { cer: Math.round(m.cer * 1000) / 1000, ref: m.ref, text: o.value.text } : {});
    });
  }
  mkdirSync(".apex/build", { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
  for (const model of MODELS) {
    const of = (task: string) => rows.filter((r) => r.model === model && r.task === task);
    const right = (task: string) => `${of(task).filter((r) => r.right).length}/${of(task).length} right, ${of(task).filter((r) => !r.ok).length} failed`;
    const ms = rows.filter((r) => r.model === model).map((r) => r.ms).sort((a, b) => a - b);
    const cers = of("page").filter((r) => r.cer !== undefined).map((r) => `${r.item} ${(100 * r.cer!).toFixed(1)}%`);
    console.log(
      `${model}: seams ${right("seam")}; stacks ${right("stack")}; pages CER ${cers.join(", ")}; median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s; $${rows.filter((r) => r.model === model).reduce((s, r) => s + r.usd, 0).toFixed(3)}`,
    );
  }
  if (!existsSync(OUT)) throw new Error("not written");
}

type Note = (model: MuseModel, task: string, item: string, o: MuseOutcome<unknown>, right: boolean | null, extra?: Partial<Row>) => void;

async function seamsAndStacks(model: MuseModel, note: Note) {
  {
    // seams: is this a true join? (cw1: 24 items named NN-true.jpg / NN-false.jpg)
    const cw1 = path.join(SPIKES, "cw1");
    const binary = readdirSync(cw1).filter((f) => /^\d+-(true|false)\.jpg$/.test(f));
    await mapLimit(binary, 6, async (f) => {
      const o = await verifySeam({ data: new Uint8Array(readFileSync(path.join(cw1, f))), mime: "image/jpeg" }, { model, onLog: () => {} });
      note(model, "seam", f, o, o.ok ? o.value.same_place === f.includes("true") : null);
    });
    // stacks: which of three identical outlines continues the words? (cw3: trial-NN-truth-X.jpg)
    const cw3 = path.join(SPIKES, "cw3");
    const kway = readdirSync(cw3).filter((f) => /truth-[A-Z]\.jpg$/.test(f));
    await mapLimit(kway, 6, async (f) => {
      const o = await chooseContinuation({ data: new Uint8Array(readFileSync(path.join(cw3, f))), mime: "image/jpeg" }, 3, { model, onLog: () => {} });
      note(model, "stack", f, o, o.ok ? o.value.choice === /truth-([A-Z])/.exec(f)![1] : null);
    });
  }
}

main();
