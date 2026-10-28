// ShredBench check (ACL Findings 2026, Apache-2.0, github.com/ythere-y/ShredBench): Blender-rendered Voronoi shreds
// with curl, shadows and jagged edges. No mask ground truth is published, so this reports fragments found against the
// expected count, latency, and how many pieces the auto path sent to SAM; it also writes an outline overlay to look at.
// Usage: pnpm tsx scripts/bench/shred-bench.mts <dir with data_N/*.jpg> <variant[,variant]> [files...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";
import { segmentFragments, type SegmentVariant } from "../../src/lib/server/segment";
import { ledger, loadEnv, recordingFetch, writeJson } from "../lib/env";

loadEnv();
const [root, variantsArg, ...only] = process.argv.slice(2);
const variants = (variantsArg ?? "auto").split(",") as SegmentVariant[];
const sets = readdirSync(root).filter((d) => /^data_\d+$/.test(d));
for (const set of sets) {
  const expected = Number(set.split("_")[1]);
  const files = readdirSync(join(root, set)).filter((f) => f.endsWith(".jpg") && (!only.length || only.includes(f)));
  for (const file of files) {
    const photo = readFileSync(join(root, set, file));
    for (const variant of variants) {
      // RECORD=1 saves every SAM answer next to the results; REPLAY=1 serves them back (no API calls, for tuning)
      const name0 = `${set}-${basename(file, ".jpg")}`;
      const tape = join(root, "results", `${name0}.sam.json`);
      const saved: Record<string, string> = existsSync(tape) ? JSON.parse(readFileSync(tape, "utf8")) : {};
      const keyOf = (body: string) => JSON.parse(body).input[0].content[0].text as string;
      const fetchImpl = process.env.REPLAY
        ? ((async (_u: string | URL | Request, init?: RequestInit) => {
            const hit = saved[keyOf(String(init!.body))];
            return hit ? new Response(hit, { status: 200 }) : new Response(JSON.stringify({ error: { message: "not on tape" } }), { status: 400 });
          }) as typeof fetch)
        : process.env.RECORD
          ? recordingFetch((_u, body, status, sse) => {
              if (status === 200) saved[keyOf(body)] = sse;
            })
          : undefined;
      const r = await segmentFragments(photo, { variant, fetchImpl, ...(process.env.REPLAY ? { apiKey: "replay" } : {}) });
      if (process.env.RECORD) writeJson(tape, saved);
      const sep = r.fragments.map((f) => f.method);
      const row = {
        set, file, variant, expected, found: r.fragments.length, size: [r.width, r.height], pass1: r.pass1,
        sentToSam: r.sentToSam, methods: sep, timings: r.timings, samCalls: r.samCalls, costUsd: r.costUsd, warnings: r.warnings,
        calls: r.calls.map((c) => `${c.stage}:${c.ok ? "ok" : "fail"}:${c.ms}`),
        areas: r.fragments.map((f) => f.area), confidences: r.fragments.map((f) => f.confidence), snap: r.fragments.map((f) => f.snap ?? null),
      };
      const name = `${set}-${basename(file, ".jpg")}-${variant}`;
      writeJson(join(root, "results", `${name}.json`), row);
      if (!process.env.REPLAY) ledger({ what: `shredbench ${name}`, sam: r.samCalls, cost: r.costUsd });
      // overlay: outlines on a 1200 px preview
      const s = 1200 / Math.max(r.width, r.height);
      const paths = r.fragments
        .map((f) => `<polygon points="${f.polygon.map(([x, y]) => `${(x * s).toFixed(1)},${(y * s).toFixed(1)}`).join(" ")}" fill="none" stroke="${f.method === "snap" ? "#e6194b" : "#3cb44b"}" stroke-width="1.5"/>`)
        .join("");
      const W = Math.round(r.width * s), H = Math.round(r.height * s);
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${paths}</svg>`);
      await sharp(photo).resize(W, H).composite([{ input: svg }]).jpeg({ quality: 85 }).toFile(join(root, "results", `${name}.jpg`));
      console.log(`${set}/${file} ${variant}: ${r.fragments.length}/${expected} fragments (pass1 ${r.pass1.count}), ${r.sentToSam} sent to SAM, ${r.timings.totalMs} ms (pass1 ${r.timings.pass1Ms}, pass2 ${r.timings.pass2Ms}), ${r.samCalls} SAM calls${r.warnings.length ? `; ${r.warnings.join(" | ")}` : ""}`);
    }
  }
}
