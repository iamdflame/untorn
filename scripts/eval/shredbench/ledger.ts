// Spend ledger for the ShredBench runs: one line per live model call, so the total can be checked before every sample.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type LedgerEntry = { stage: string; sample: string; fn: string; cost: number; ms?: number; ok?: boolean; [k: string]: unknown };

export class Ledger {
  readonly file: string;
  private spent: number;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.file = path.join(root, "ledger.ndjson");
    this.spent = existsSync(this.file)
      ? readFileSync(this.file, "utf8")
          .split("\n")
          .filter(Boolean)
          .reduce((s, l) => s + (Number((JSON.parse(l) as LedgerEntry).cost) || 0), 0)
      : 0;
  }
  add(e: LedgerEntry): void {
    this.spent += e.cost || 0;
    appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
  }
  get total(): number {
    return this.spent;
  }
}
