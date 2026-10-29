// The first screen's recording without the seam images Muse read (330 KB of base64 the replay never shows).
// The full run stays in result.json for the download. Usage: node scripts/make-lite-recording.mjs <sample-dir>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "public/samples/chouteau-1903";
const r = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
r.reads = r.reads.map((x) => ({ ...x, image: null }));
fs.writeFileSync(path.join(dir, "result-lite.json"), JSON.stringify(r));
console.log(`${dir}/result-lite.json`, fs.statSync(path.join(dir, "result-lite.json")).size, "bytes");
