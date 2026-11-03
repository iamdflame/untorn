import { describe, expect, it } from "vitest";
import { modelName, readersLine } from "./models";
import type { ReadOut, TranscriptOut } from "./types";

const read = (model?: string, ok = true) => ({ ok, model }) as ReadOut;
const page = (model?: string) => ({ ok: true, model }) as TranscriptOut;

describe("readersLine", () => {
  it("counts the answers per model, open weights first", () => {
    expect(readersLine({ reads: [read("muse-spark-1.3"), read("muse-spark-open"), read("muse-spark-open"), read("muse-spark-open", false)], transcripts: [page("muse-spark-open")] })).toBe(
      "Reads: 3 by Muse Spark Open (Meta’s open weights), 1 by Muse Spark.",
    );
  });

  it("says nothing for runs recorded before reads named their model", () => {
    expect(readersLine({ reads: [read()], transcripts: [page()] })).toBe("");
    expect(modelName(undefined)).toBe("Muse Spark");
  });
});
