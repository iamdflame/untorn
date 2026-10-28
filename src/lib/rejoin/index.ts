// Rejoin solver: put torn documents back together from one photo. Pure TypeScript (browser and Node).
//
// Geometry (this module) proposes joins where torn edges fit; the content clue (an injected async check, Muse Spark
// in stream S2) reads across a seam and decides where geometry ties. See docs/SOLVER.md.

export { solve, prepare, contentRequests, askAll, finish, fuseVerdicts, type SolveOptions, type Prepared } from "./solve";
export { renderSeam, renderChoiceSheet, type SeamRenderOptions } from "./seam";
export { renderPage, encodePng, type PageRenderOptions } from "./render";
export { museContentCheck, fragmentsFromSegments, type MuseOutcome, type ImageInput, type SegmentedFragment } from "./adapters";
export { analyzeFragment } from "./fragment";
export { matchFragments, measureSeam, MATCH_DEFAULTS, type MatchOptions } from "./match";
export { assemble, ASSEMBLE_DEFAULTS, type AssembleOptions } from "./assemble";
export { traceOutline } from "./contour";
export { analyzeEdges } from "./edges";
export { textOrientation } from "./orientation";
export { poseApply, poseCompose, poseInvert, type Pose } from "./geom";
export type * from "./types";
