// The pipeline's real model calls: SAM 3.1 (two-pass segmentation), the readers (seams, pages, translation) and Muse
// Wonder (the archive record, after the page is shown).
// The readers are two of Meta's hosts: Muse Spark on Meta's API, and Muse Spark Open, Meta's open weights (served by
// Baseten here, or by an archive's own server: OPEN_API_BASE). A read goes to Muse Spark first and, when it is slow or
// refuses, to the open weights; the first good answer wins (muse.ts, museCall). READ_FIRST=open puts the open weights
// first, READ_FIRST=meta-only reads on Meta's API alone, and a visitor can send every read to the open weights ("open").
// The order was measured on real tears before choosing (docs/MODELS.md). Server-only: these read MODEL_API_KEY and BASETEN_API_KEY.

import { catalogPage, chooseContinuation, pageOrientation, readPage, translate, verifySeam, type MuseModel, type MuseOptions } from "./muse";
import type { PipelineDeps } from "./pipeline";
import { segmentFragments } from "./segment";

/** "both": the two hosts in the server's order; "open": every read on Meta's open weights. */
export type Reader = "both" | "open";

/** Is the open-weights host configured on this server? OPEN_WEIGHTS=off sets it aside without removing the key. */
export const openWeightsReady = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.BASETEN_API_KEY) && env.OPEN_WEIGHTS !== "off";

/** Which model a reading call asks first, and which one its hedge asks ({}: Muse Spark alone, hedged on Meta's API). */
export function readHosts(reader: Reader = "both", env: NodeJS.ProcessEnv = process.env): Pick<MuseOptions, "model" | "altModel"> {
  if (!openWeightsReady(env)) return {};
  if (reader === "open") return { model: "muse-spark-open" };
  if (env.READ_FIRST === "meta-only") return {};
  const [model, altModel]: MuseModel[] = env.READ_FIRST === "open" ? ["muse-spark-open", "muse-spark-1.3"] : ["muse-spark-1.3", "muse-spark-open"];
  return { model, altModel };
}

export function liveDeps(putAsset: PipelineDeps["putAsset"], { reader = "both" }: { reader?: Reader } = {}): PipelineDeps {
  const hosts = readHosts(reader);
  return {
    // a pass-1 SAM call normally answers in 2–4 s: start the duplicate request at 5 s (S2 default: 7 s)
    segment: (jpeg, { signal }) => segmentFragments(jpeg, { signal, hedgeAfterMs: 5000 }),
    verifySeam: (image, o) => verifySeam(image, { ...hosts, ...o }),
    chooseContinuation: (image, k, o) => chooseContinuation(image, k, { ...hosts, ...o }),
    readPage: (image, o) => readPage(image, { ...hosts, ...o }),
    translate: (text, to, o) => translate(text, to, { ...hosts, ...o }),
    pageOrientation: (image, o) => pageOrientation(image, { ...hosts, ...o }),
    // the record stays with Muse Wonder (measured for it), unless only the open weights may read
    catalogPage: reader === "open" && hosts.model ? (text, o) => catalogPage(text, { model: "muse-spark-open", ...o }) : catalogPage,
    putAsset,
  };
}
