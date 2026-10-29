// The pipeline's real model calls: SAM 3.1 (two-pass segmentation) and Muse Spark (seams, pages, translation).
// Server-only: these read MODEL_API_KEY.

import { chooseContinuation, readPage, translate, verifySeam } from "./muse";
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
    putAsset,
  };
}
