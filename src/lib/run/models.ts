// The models as the page names them, and who read a run: Meta's open weights (Muse Spark Open) and Meta's API.

import type { ReadOut, TranscriptOut } from "./types";

export const OPEN_MODEL = "muse-spark-open";

const NAME: Record<string, string> = {
  "muse-spark-open": "Muse Spark Open",
  "muse-spark-1.3": "Muse Spark",
  "muse-wonder-1.0": "Muse Wonder",
};

/** A model's name; runs recorded before reads named their model were read by Muse Spark. */
export const modelName = (id?: string | null) => (id && NAME[id]) || "Muse Spark";

/** "Reads: 12 by Muse Spark Open (Meta’s open weights), 3 by Muse Spark." — "" when the run named no models. */
export function readersLine(run: { reads: ReadOut[]; transcripts: TranscriptOut[] }): string {
  const n = new Map<string, number>();
  for (const r of [...run.reads, ...run.transcripts]) if (r.ok && r.model) n.set(r.model, (n.get(r.model) ?? 0) + 1);
  if (!n.size) return "";
  const parts = [...n]
    .sort((a, b) => (a[0] === OPEN_MODEL ? -1 : b[0] === OPEN_MODEL ? 1 : b[1] - a[1]))
    .map(([m, k]) => `${k} by ${modelName(m)}${m === OPEN_MODEL ? " (Meta’s open weights)" : ""}`);
  return `Reads: ${parts.join(", ")}.`;
}
