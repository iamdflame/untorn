import { describe, expect, it } from "vitest";
import { readHosts } from "./live";

describe("readHosts", () => {
  const key = { BASETEN_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;

  it("reads with Muse Spark alone when the open-weights host isn't set up, or is set aside", () => {
    expect(readHosts("both", {} as unknown as NodeJS.ProcessEnv)).toEqual({});
    expect(readHosts("open", {} as unknown as NodeJS.ProcessEnv)).toEqual({});
    expect(readHosts("both", { ...key, OPEN_WEIGHTS: "off" } as unknown as NodeJS.ProcessEnv)).toEqual({});
  });

  it("asks Muse Spark first and the open weights for its slow reads; READ_FIRST swaps them or keeps Meta's API alone", () => {
    expect(readHosts("both", key)).toEqual({ model: "muse-spark-1.3", altModel: "muse-spark-open" });
    expect(readHosts("both", { ...key, READ_FIRST: "open" } as unknown as NodeJS.ProcessEnv)).toEqual({ model: "muse-spark-open", altModel: "muse-spark-1.3" });
    expect(readHosts("both", { ...key, READ_FIRST: "meta-only" } as unknown as NodeJS.ProcessEnv)).toEqual({});
  });

  it("keeps every read on the open weights when the visitor asks for that", () => {
    expect(readHosts("open", key)).toEqual({ model: "muse-spark-open" });
  });
});
