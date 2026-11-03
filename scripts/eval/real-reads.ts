// Each seam read of recorded real-photo runs, scored against the photo's truth, per model: does "same place" match
// the pieces' true adjacency (scripts/eval/real.ts register)? A read shows one candidate alignment, and a true
// neighbour shown misaligned is rightly "not the same place", so this is a lower bound that treats both models alike.
//   pnpm exec tsx scripts/eval/real-reads.ts --case img5138 RESULT.json [RESULT.json ...]

import { readFileSync } from "node:fs";
import { polygonCentroid } from "../../src/lib/rejoin/geom";
import { loadConfig, loadGt, loadSegments } from "./real";

type Res = { pieces: { id: string; polygon: [number, number][] }[]; reads: { kind: string; same: boolean | null; confidence: number; pieces: string[]; ok: boolean; model?: string; ms: number }[] };

const argv = process.argv.slice(2);
const ci = argv.indexOf("--case");
const name = ci >= 0 ? argv[ci + 1] : "img5138";
const files = argv.filter((a, i) => a !== "--case" && i !== ci + 1);
const c = loadConfig().find((x) => x.name === name)!;
const gt = loadGt(c);
const segs = loadSegments(c);
const adjacent = new Set(gt.adjacency.flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]));
const labelAt = (x: number, y: number) => {
  for (const sg of segs) {
    const cx = Math.floor(x - sg.mask.x);
    const cy = Math.floor(y - sg.mask.y);
    if (cx >= 0 && cy >= 0 && cx < sg.mask.width && cy < sg.mask.height && sg.mask.data[cy * sg.mask.width + cx]) return sg.id;
  }
  return null;
};

type Tally = { n: number; right: number; wrong: number; unsure: number; falseSame: number; ms: number[]; conf: number[] };
const by = new Map<string, Tally>();
for (const f of files) {
  const r = JSON.parse(readFileSync(f, "utf8")) as Res;
  const ids = new Map(r.pieces.map((p) => [p.id, labelAt(...(polygonCentroid(Float64Array.from(p.polygon.flat())) as unknown as [number, number]))]));
  for (const rd of r.reads) {
    if (rd.kind !== "pair" || !rd.ok) continue;
    const [a, b] = rd.pieces.map((id) => ids.get(id));
    if (!a || !b) continue;
    const model = rd.model ?? "muse-spark-1.3";
    const t = by.get(model) ?? { n: 0, right: 0, wrong: 0, unsure: 0, falseSame: 0, ms: [], conf: [] };
    t.n++;
    t.ms.push(rd.ms);
    if (rd.same === null) t.unsure++;
    else {
      t.conf.push(rd.confidence);
      const truth = adjacent.has(`${a}|${b}`);
      if (rd.same === truth) t.right++;
      else {
        t.wrong++;
        if (rd.same) t.falseSame++;
      }
    }
    by.set(model, t);
  }
}
for (const [model, t] of by) {
  const ms = [...t.ms].sort((x, y) => x - y);
  const conf = [...t.conf].sort((x, y) => x - y);
  console.log(
    `${model}: ${t.n} pair reads; right ${t.right}, wrong ${t.wrong} (false "same" ${t.falseSame}), no clue ${t.unsure}; median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s; confidence median ${conf[Math.floor(conf.length / 2)]?.toFixed(2)}`,
  );
}
