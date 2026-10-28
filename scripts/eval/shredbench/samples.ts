// ShredBench samples on disk: the official public set and our replica.
//
//   <root>/official/data_8/<name>.jpg            official render; ground truth at official/my_dataset/<name>.md
//   <root>/replica/data_<N>/<domain>/<name>.jpg   replica render; ground truth at replica/docs/<domain>/<name>.md,
//                                                 true piece poses at …/<name>.json; split in replica/split.json

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Domain = "news_en" | "news_zh" | "code" | "table";
export const DOMAINS: Domain[] = ["news_en", "news_zh", "code", "table"];

export type Sample = {
  /** Unique key, also the run sub-directory: official-8/news_008, replica-12/code/py_003. */
  key: string;
  set: "official" | "replica";
  pieces: number;
  domain: Domain;
  name: string;
  image: string;
  /** Ground-truth markdown, when published (official) or known (replica). */
  gt: string | null;
  /** Replica only: true poses of every piece (written by the generator). */
  truth: string | null;
  split: "dev" | "test";
};

/** Official samples without ground truth are the dev split: the solver was tuned on them, never on scored ones. */
export function officialSamples(root: string): Sample[] {
  const dir = path.join(root, "official", "data_8");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.jpg$/, "");
      const gt = path.join(root, "official", "my_dataset", `${name}.md`);
      const has = existsSync(gt);
      return { key: `official-8/${name}`, set: "official", pieces: 8, domain: "news_en", name, image: path.join(dir, f), gt: has ? gt : null, truth: null, split: has ? "test" : "dev" } satisfies Sample;
    });
}

export function replicaSamples(root: string): Sample[] {
  const base = path.join(root, "replica");
  if (!existsSync(base)) return [];
  const splitFile = path.join(base, "split.json");
  const split: Record<string, "dev" | "test"> = existsSync(splitFile) ? JSON.parse(readFileSync(splitFile, "utf8")) : {};
  const out: Sample[] = [];
  for (const d of readdirSync(base).filter((x) => /^data_\d+$/.test(x)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const pieces = Number(d.slice(5));
    for (const domain of DOMAINS) {
      const dir = path.join(base, d, domain);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jpg")).sort()) {
        const name = f.replace(/\.jpg$/, "");
        const gt = path.join(base, "docs", domain, `${name}.md`);
        const truth = path.join(dir, `${name}.json`);
        out.push({
          key: `replica-${pieces}/${domain}/${name}`,
          set: "replica",
          pieces,
          domain,
          name,
          image: path.join(dir, f),
          gt: existsSync(gt) ? gt : null,
          truth: existsSync(truth) ? truth : null,
          split: split[`${domain}/${name}`] ?? "test",
        });
      }
    }
  }
  return out;
}

export type SampleFilter = { set?: string; pieces?: number[]; domains?: string[]; split?: string; only?: string[]; limit?: number };

export function selectSamples(root: string, f: SampleFilter): Sample[] {
  let s = [...(f.set === "replica" ? [] : officialSamples(root)), ...(f.set === "official" ? [] : replicaSamples(root))];
  if (f.pieces?.length) s = s.filter((x) => f.pieces!.includes(x.pieces));
  if (f.domains?.length) s = s.filter((x) => f.domains!.includes(x.domain));
  if (f.split && f.split !== "all") s = s.filter((x) => x.split === f.split);
  if (f.only?.length) s = s.filter((x) => f.only!.some((o) => x.key.includes(o)));
  return f.limit ? s.slice(0, f.limit) : s;
}
