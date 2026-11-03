// The pipeline's real model calls: SAM 3.1 (two-pass segmentation), Muse Spark (seams, pages, translation) and Muse
// Wonder (the archive record, after the page is shown).
// Server-only: these read MODEL_API_KEY.

import { catalogPage, chooseContinuation, pageOrientation, readPage, translate, verifySeam } from "./muse";
import type { PipelineDeps } from "./pipeline";
import { segmentFragments } from "./segment";

export function liveDeps(putAsset: PipelineDeps["putAsset"]): PipelineDeps {
  return {
    // a pass-1 SAM call normally answers in 2–4 s: start the duplicate request at 5 s (S2 default: 7 s)
    segment: (jpeg, { signal }) => segmentFragments(jpeg, { signal, hedgeAfterMs: 5000 }),
    verifySeam,
    chooseContinuation,
    readPage,
    translate,
    pageOrientation,
    catalogPage,
    putAsset,
  };
}
