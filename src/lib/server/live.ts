// The pipeline's real model calls: SAM 3.1 (two-pass segmentation) and Muse Spark (seams, pages, translation).
// Server-only: these read MODEL_API_KEY.

import { chooseContinuation, readPage, translate, verifySeam } from "./muse";
import type { PipelineDeps } from "./pipeline";
import { segmentFragments } from "./segment";

export function liveDeps(putAsset: PipelineDeps["putAsset"]): PipelineDeps {
  return {
    segment: (jpeg, { signal }) => segmentFragments(jpeg, { signal }),
    verifySeam,
    chooseContinuation,
    readPage,
    translate,
    putAsset,
  };
}
