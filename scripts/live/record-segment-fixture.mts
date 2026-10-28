// Record real SAM 3.1 answers on the synthetic test scene, for the segmentation unit tests (which never call the API).
// Usage: pnpm tsx scripts/live/record-segment-fixture.mts   (about 6 SAM image calls, ~$0.015)
import { writeFileSync } from "node:fs";
import { renderScene } from "../../src/lib/server/__fixtures__/scene";
import { segmentFragments } from "../../src/lib/server/segment";
import { ledger, loadEnv, recordingFetch } from "../lib/env";

loadEnv();
const responses: { text: string; status: number; sse: string }[] = [];
const fetchImpl = recordingFetch((_url, body, status, sse) => {
  const text = JSON.parse(body).input[0].content[0].text as string;
  if (!responses.some((r) => r.text === text)) responses.push({ text, status, sse });
});
const photo = await renderScene();
let calls = 0;
for (const variant of ["crops", "fullres-boxes"] as const) {
  const r = await segmentFragments(photo, { variant, fetchImpl, hedgeAfterMs: 0 });
  calls += r.samCalls;
  console.log(variant, r.fragments.length, "fragments", r.timings.totalMs, "ms", r.warnings);
}
writeFileSync("src/lib/server/__fixtures__/segment-scene.sam.json", JSON.stringify({ model: "sam-3.1", note: "recorded on renderScene()", responses }, null, 1));
ledger({ what: "record segment fixture", sam: calls, cost: calls * 0.0025 });
console.log(`${responses.length} distinct requests recorded`);
