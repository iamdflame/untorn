// Fetch ShredBench's public samples (github.com/ythere-y/ShredBench, Apache-2.0) at a pinned commit and verify each
// file against its git blob hash. Everything that is public: data_8 (11 renders, all English news) and my_dataset
// (10 ground-truth markdown files, all English news). Only news_008, news_031 and news_041 have both.
//
//   pnpm tsx scripts/bench/shredbench/fetch.ts [--root DIR]      → DIR/official/{data_8,my_dataset}/…
//
// Requests carry a generic User-Agent and nothing else: no token, no account, no personal data.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { argValue, DEFAULT_ROOT } from "../../eval/shredbench/args";

export const SHREDBENCH_COMMIT = "41bca037b03a710c8117e2106003832d50c959b9";
export const SHREDBENCH_LICENSE = "Apache-2.0";
const UA = "research-script/1.0";

/** Path → git blob SHA-1 at SHREDBENCH_COMMIT (from the repository's tree). */
export const OFFICIAL_FILES: Record<string, string> = {
  "data_8/news_001.jpg": "dfc155a6dc",
  "data_8/news_008.jpg": "c6c25bf8a2",
  "data_8/news_011.jpg": "734433f924",
  "data_8/news_012.jpg": "5b89d6a856",
  "data_8/news_018.jpg": "711623c5e0",
  "data_8/news_021.jpg": "ccb1bc1cb3",
  "data_8/news_029.jpg": "3bc5a28f7e",
  "data_8/news_030.jpg": "a7c38f1832",
  "data_8/news_031.jpg": "075f629e03",
  "data_8/news_041.jpg": "d3b549b014",
  "data_8/news_046.jpg": "fd297941ba",
  "my_dataset/news_004.md": "6aae7c239e",
  "my_dataset/news_006.md": "72f2753209",
  "my_dataset/news_008.md": "eb1864c6a7",
  "my_dataset/news_010.md": "66c5566e5a",
  "my_dataset/news_013.md": "009357f8cf",
  "my_dataset/news_015.md": "db944cc9b5",
  "my_dataset/news_022.md": "26f0244a90",
  "my_dataset/news_031.md": "a5a958b721",
  "my_dataset/news_041.md": "e7b1406bf3",
  "my_dataset/news_044.md": "cf1bd20868",
  LICENSE: "261eeb9e9f",
  "README.md": "6681137019",
  // read for the metric's exact semantics (ned.ts); never run
  "metric.py": "8764d571f4",
};

/** git's blob hash: SHA-1 of "blob <size>\0" + bytes. */
export const gitBlobSha = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function main() {
  const root = path.join(argValue("--root") ?? DEFAULT_ROOT, "official");
  for (const [rel, want] of Object.entries(OFFICIAL_FILES)) {
    const out = path.join(root, rel);
    if (existsSync(out) && gitBlobSha(readFileSync(out)).startsWith(want)) continue;
    const url = `https://raw.githubusercontent.com/ythere-y/ShredBench/${SHREDBENCH_COMMIT}/${rel}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = gitBlobSha(bytes);
    if (!got.startsWith(want)) throw new Error(`${rel}: blob ${got.slice(0, 10)} is not ${want}`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    console.log(`${rel}  ${bytes.length} B  blob ${got.slice(0, 10)}`);
  }
  writeFileSync(path.join(root, "SOURCE.json"), JSON.stringify({ repo: "github.com/ythere-y/ShredBench", commit: SHREDBENCH_COMMIT, license: SHREDBENCH_LICENSE, files: Object.keys(OFFICIAL_FILES) }, null, 1));
  console.log(`official ShredBench samples in ${root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
