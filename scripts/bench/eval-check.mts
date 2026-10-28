// Check the TypeScript mask eval against the spike's Python eval (spikes/v3/t1/sam-torn/eval.json), no API calls.
import { readFileSync } from "node:fs";
import { evaluateMasks } from "../../src/lib/server/mask-eval";
import { SPIKES } from "../lib/env";
import { readLabelPgm } from "../lib/pgm";

const gt = JSON.parse(readFileSync(`${SPIKES}/t1/gt.json`, "utf8"));
const masks = readLabelPgm(`${SPIKES}/t1/sam-torn/labels.pgm`);
const py = JSON.parse(readFileSync(`${SPIKES}/t1/sam-torn/eval.json`, "utf8"));
console.log("python:", JSON.stringify(py.summary));
for (const c of [0, 0.5]) {
  const r = evaluateMasks(gt.pieces, masks, { fillOffset: c });
  console.log(`ts fillOffset=${c}:`, JSON.stringify(r.summary));
  console.log("  per-piece iou ts/py:", r.pieces.map((p, i) => `${p.iou}/${py.pieces[i].iou}`).join(" "));
  console.log("  per-piece median ts/py:", r.pieces.map((p, i) => `${p.boundary?.median}/${py.pieces[i].boundary_px_median}`).join(" "));
}
