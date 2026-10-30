// Small shared helpers for the ShredBench scripts.

import path from "node:path";

/** Where data and runs live unless --root says otherwise (ignored by git: scripts/bench/.gitignore has out/). */
export const DEFAULT_ROOT = process.env.SHREDBENCH_ROOT ?? path.join("scripts", "bench", "shredbench", "out");

/** The value after a flag (`--root DIR`), or undefined. */
export function argValue(flag: string, argv = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const hasFlag = (flag: string, argv = process.argv.slice(2)) => argv.includes(flag);
