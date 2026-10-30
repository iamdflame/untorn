// Public types of the Untorn solver. Pure data: no DOM, no Node APIs. Coordinates are image pixels, x right, y down.

import type { Pose } from "./geom";
import type { PageCorner, Segment } from "./edges";
import type { TextOrientation } from "./orientation";

export type { Pose, PageCorner, Segment, TextOrientation };

/** Row-major binary raster: non-zero = paper. */
export type Mask = { width: number; height: number; data: Uint8Array };

/** Row-major RGBA raster, 4 bytes per pixel. */
export type Rgba = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

/** One piece as segmented in the photo (SAM 3.1 in the app; simulated masks in Bench-S). */
export type FragmentInput = {
  id: string;
  /** The piece's mask, cropped to a box of the photo. */
  mask: Mask;
  /** Photo position of the crop: crop pixel (c, r) covers photo [x0 + c, x0 + c + 1) × [y0 + r, y0 + r + 1). */
  x0: number;
  y0: number;
  /** The photo under the crop, same size as the mask. Needed for text angle, seam appearance and rendering. */
  rgba?: Rgba;
};

/** A fragment after outline, edge and text analysis. Its frame is the photo's: poses map photo → page coordinates. */
export type Fragment = {
  id: string;
  /** Position in the input list. */
  index: number;
  input: FragmentInput;
  /** Closed outline at ~1 px spacing, photo coordinates, positive signed area. */
  outline: Float64Array;
  area: number;
  centroid: [number, number];
  segments: Segment[];
  /** Per outline point: 1 on a straight (page-edge) segment. */
  straight: Uint8Array;
  segmentOf: Int32Array;
  pageCorners: PageCorner[];
  /** Dominant text-line direction; null for blank pieces or without pixels. */
  text: TextOrientation | null;
  /** Depth inside the mask (px, chamfer), for overlap tests: same raster as the mask. */
  depth: Float32Array;
  /** Mean paper colour (RGB) away from the edge, when pixels are available. */
  paper: [number, number, number] | null;
};

/** Seam appearance: does the paper and the ink continue across the join? */
export type Appearance = {
  /** −1…1: correlation of the ink profiles along both sides of the seam (null when there is too little ink). */
  ink: number | null;
  /** Colour distance of the paper tone on both sides (RGB Euclidean, 0–441). */
  tone: number;
  /** Combined appearance evidence, −1…1 (0 = no information). */
  score: number;
};

/** A proposed join: fragment b placed against fragment a so that their torn edges are complementary. */
export type Candidate = {
  id: string;
  a: string;
  b: string;
  /** Maps b's photo coordinates into a's photo coordinates. */
  pose: Pose;
  /** Length of the shared seam (px). */
  overlap: number;
  /** RMS point-to-curve distance along the seam (px). */
  rms: number;
  /** Area of b that sinks deeper than the noise band into a (px²). */
  areaOverlap: number;
  /** How well the seam pins down all three degrees of freedom (0–1; a straight seam can slide). */
  conditioning: number;
  /** RMS of the seam residual's 18 px moving average (px): coarse misfit, which mask noise blobs also cause. */
  shapeRms: number;
  /** RMS of the residual minus that average (px): fine misfit. Mask noise only on a true seam; the sharp clue. */
  fineRms: number;
  /** Overlap of the two outlines at rest (px): the fibre rim of a hand tear (0 for clean cuts and simulations). */
  rim?: number;
  /** Geometry score (px of well-fitting, well-conditioned seam, minus penalties). */
  score: number;
  /** Geometry confidence, 0–1, from the score and the competition. */
  confidence: number;
  /** Score ratio to the best competing candidate on the same stretch of edge (∞ when unopposed). */
  margin: number;
  /** The same against rivals with another partner only (another alignment of the same two pieces is no alternative). */
  marginOther?: number;
  /** Segments of a and b touched by the seam. */
  segmentsA: number[];
  segmentsB: number[];
  /** Outline index ranges of the seam on each fragment: [first, count] (wrapping). */
  seamA: [number, number];
  seamB: [number, number];
  appearance: Appearance | null;
  /** Set when this candidate belongs to a twin group (geometrically indistinguishable alternatives). */
  twinGroup: string | null;
  /**
   * "torn": ragged edges fitted by shape. "cut": straight edges aligned end to end; geometry is weak there, so a cut
   * join is only ever accepted with the content clue.
   */
  edge: "torn" | "cut";
  /**
   * Do the two pieces' text lines continue into each other under this pose? Null when either piece has no trusted
   * line grid (blank, handwritten, too few lines).
   */
  text?: TextCheck | null;
};

/** The text-line test of a candidate join (textlines.ts). */
export type TextCheck = {
  /** Angle between the line directions once joined (rad, axial). */
  angle: number;
  /** Line-phase mismatch at the seam, as a fraction of the pitch (−0.5…0.5). */
  phase: number;
  pitchRatio: number;
  /** 0–1: how far both line grids can be trusted. */
  weight: number;
  /** Both text angles are clear (the direction test counts). */
  angleValid: boolean;
  /** Both line grids are regular and agree on the pitch (the phase test counts). */
  phaseValid: boolean;
  /** Both pieces clearly know which way is up, and the join turns one of them upside down. */
  flipped: boolean;
  /** Evidence for the join (log-likelihood ratio, true vs chance), already scaled by `weight`. */
  logLR: number;
};

/** Candidates from different fragments that fit the same stretch of edge equally well (stack tears). */
export type TwinGroup = {
  id: string;
  /** The fragment whose edge the twins compete for. */
  anchor: string;
  /** Outline range of the contested stretch on the anchor. */
  seam: [number, number];
  /** Candidate ids, best geometry first. */
  candidates: string[];
};

/** What the content (“crossword”) check is asked. `render()` draws the image the model reads. */
export type ContentRequest =
  | {
      kind: "pair";
      id: string;
      candidate: string;
      a: string;
      b: string;
      /** False when the solver could not tell which way is up: the model should also read the image turned 180°. */
      uprightKnown: boolean;
      render: () => Rgba;
    }
  | {
      kind: "choice";
      id: string;
      /** The left fragment: its seam is shown above the candidates. */
      anchor: string;
      twinGroup: string | null;
      /** Candidate ids in sheet order (labels A, B, C, …). */
      candidates: string[];
      uprightKnown: boolean;
      render: () => Rgba;
    };

/** The content check's answer. A null decision means the model could not tell (blank seam, failure). */
export type ContentVerdict =
  | { kind: "pair"; id: string; same: boolean | null; confidence: number; reason?: string; wordsAcross?: string[] }
  | { kind: "choice"; id: string; choice: number | null; confidence: number; reason?: string; wordsAcross?: string[] };

/** The injected model call (stream S2 implements it with Muse Spark). */
export type ContentCheck = (request: ContentRequest) => Promise<ContentVerdict | null>;

export type Clue = "geometry" | "geometry+content" | "content";

export type Join = {
  candidate: string;
  a: string;
  b: string;
  pose: Pose;
  geometry: { score: number; confidence: number; rms: number; overlap: number; margin: number };
  appearance: Appearance | null;
  /** Fused content evidence for this join (null when no verdict). */
  content: { same: boolean; confidence: number; votes: number } | null;
  /** The text-line test (null without trusted line grids on both pieces). */
  text?: TextCheck | null;
  /** Which clue decided: geometry alone, both, or content breaking a geometric tie (twins). */
  decidedBy: Clue;
  /** Combined confidence, 0–1. */
  confidence: number;
  /** True when the join closes a loop inside an already-connected page (and agreed with it). */
  loop: boolean;
  page: string;
};

export type PlacedFragment = { id: string; pose: Pose };

export type Page = {
  id: string;
  /** Fragment poses: photo coordinates → page coordinates (upright, origin at the top-left of the placed pieces). */
  fragments: PlacedFragment[];
  width: number;
  height: number;
  /** 0–1: join confidence × how much of the torn edge is accounted for. */
  confidence: number;
  /** Share of the page's torn edge length covered by accepted seams. */
  completeness: number;
  pageCorners: number;
  /** How the page was turned upright. */
  upright: { by: "text" | "edges" | "none"; flipKnown: boolean };
  /** RMS seam residual after joint refinement (px). */
  rms: number;
};

export type UnplacedReason = "no-match" | "twin-unresolved" | "rejected";

export type Unplaced = { id: string; reason: UnplacedReason };

export type SolveResult = {
  pages: Page[];
  joins: Join[];
  unplaced: Unplaced[];
  twinGroups: TwinGroup[];
  candidates: Candidate[];
  /** Content checks asked and answered. */
  content: { asked: number; answered: number };
  timings: Record<string, number>;
};
