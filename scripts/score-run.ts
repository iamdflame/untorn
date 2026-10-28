// Score a stored run (result.json) against a sample's answer key:
//   pnpm tsx scripts/score-run.ts <result.json> [key.json]
import { readFileSync } from "node:fs";
import { scoreRun, type AnswerKey } from "../src/lib/server/accuracy";
import type { RunResult } from "../src/lib/run/types";

const [resultFile, keyFile = "data/samples/chouteau-1903/key.json"] = process.argv.slice(2);
if (!resultFile) throw new Error("usage: score-run.ts <result.json> [key.json]");
const result = JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
const key = JSON.parse(readFileSync(keyFile, "utf8")) as AnswerKey;
console.log(JSON.stringify(scoreRun(result, key)));
