# The Rejoin solver

Rejoin puts torn documents back together from one photo. SAM 3.1 outlines every piece; this solver works out where
each piece belongs. A join between two pieces needs two clues: the torn edges fit (geometry, this module), and the
content continues across the seam (Muse Spark reads the half-letters, injected as a callback). Geometry proposes,
ranks and assembles; where it cannot decide (stack tears, whose pieces share identical outlines), reading decides.

Code: `src/lib/rejoin/` (pure TypeScript, typed-array rasters, no DOM or Node APIs; runs in the browser and in Node).
Benchmark: `scripts/bench/` (Bench-S generator, pages). Eval: `scripts/eval/solver.ts`.

## Pipeline

```
photo + masks ──► per piece: outline, edges, text angle ──► pairwise matching ──► content requests ──► assembly
                  (fragment.ts)                             (match.ts)            (solve.ts → S2)     (assemble.ts)
```

### 1 · Outline (`contour.ts`)
Marching squares on the mask after one light binomial blur (σ ≈ 0.7 px), iso-level 0.5 between pixel centres, so the
outline is subpixel; the largest loop is kept (holes and specks dropped). It is resampled at 1 px, smoothed with a
Gaussian (σ 1 px) and resampled again. Orientation: positive signed area.

### 2 · Edges (`edges.ts`)
- **Straight page edges:** a line is fitted over a 25 px window at every outline point; runs of points whose local RMS
  is under 1 px are grown and trimmed against their own line, merged when collinear, and kept when at least 48 px long
  with RMS ≤ 1 px (stricter for short runs: a quiet stretch of tear can look straight over a few tens of px) and
  deviation ≤ 3 px.
- **Torn edges:** everything else, split at strong turns (≥ 60° over ±14 px).
- **Page corners:** two straight edges meeting (allowing a 16 px rounded gap) at 90° ± 14°, turning convex.

### 3 · Text orientation (`orientation.ts`)
Ink pixels (darker than the paper tone, away from the edge) are projected across lines at every angle (1°, then
0.1°); text lines make the projection peaky. Strength = peak criterion / median over angles. The line pitch comes
from the profile's autocorrelation. Which way is up: Latin script has more ascenders than descenders, so the ink just
above each x-height band outweighs the ink below it. Blank pieces return `null`. Matching only uses the angle to prune
seeds when both pieces are very confident (≥ 0.85; monospaced typescript also lines up in columns, which can win on a
narrow piece), and never depends on it.

### 4 · Matching (`match.ts`)
For every pair of fragments:
1. **Seed with turning functions.** Tangent angles every 2 px (8 px chords) along continuous torn chains, one side
   reversed. On every diagonal (relative offset), a sliding 88 px window measures the variance of the angle
   difference; a window where the difference is nearly constant, and explains most of the window's own shape
   variance, is a seed. The constant is the rotation. The best 8 seeds per pair go on.
2. **Fit** a rigid transform to the window's point pairs (2D Kabsch), and screen it in one pass.
3. **Refine with ICP**: point-to-line, over the whole outline, Huber-weighted, with a shrinking inlier band
   (7 → 4.5 → 3.5 px). Only points whose normals face each other pair up, so page edges never match page edges. The
   seam is the best contiguous run of inliers; a run bridges up to 30 px of "near" points (a mask-noise blob) but
   breaks after a few unmatched ones.
4. **Score** = seam length × fine-residual quality × conditioning gate − area overlap / 10:
   - **Fine residual**: the seam residual minus its 18 px moving average. On a true seam it is mask noise only; two
     different tears can be bent into coarse agreement by the fit but their fine raggedness never agrees. On the dev
     set it is 0.53–0.72 px (p10–p90) on true seams and 0.85–1.21 px on false ones; raw RMS overlaps far more, and the
     coarse part does not separate them at all. Quality = exp(−½ ((fine − 0.6) / 0.16)²) above the 0.6 px floor.
   - **Conditioning**: ratio of the eigenvalues of Σ n nᵀ over the seam normals; a straight seam can slide, so its
     score is gated (full weight from 0.08).
   - **Area overlap**: area of one piece sinking more than 3 px into the other.
5. **Rank.** Candidates compete when their seams cover the same stretch of edge (≥ 30% overlap); the margin is the
   score ratio to the best competitor. Geometry confidence = (1 − e^(−score/60)) × (1 − 1/margin²).
6. **Twin groups.** Competing candidates from different fragments whose scores are within 30% and whose placed
   footprints coincide (≥ 80% of one inside the other) are geometrically indistinguishable: stack tears produce them.

### 5 · Content requests (`solve.ts`, `seam.ts`)
- One **k-way choice sheet** per twin group: the anchor's seam window on top, each candidate's partner alone in the
  same frame below, labelled A, B, C (the spike's validated format, 9/9 with Muse Spark).
- **Pair checks** for the strongest plausible joins (score ≥ 30, margin ≥ 0.7; at most 48): both pieces joined, the
  tear drawn as a dark line (the spike's validated format).
- Windows are 420 × 150 px, centred on the stretch of seam with the most ink on both sides, rotated so the anchor's
  text reads left to right, scaled to about 32 px per text line. `uprightKnown: false` tells the model to also read the
  image turned 180°.
- Verdicts are fused into per-candidate log-odds: a pick adds evidence for it and against the others on its sheet.

### 6 · Assembly (`assemble.ts`)
- **Order:** combined confidence (geometry log-odds + content log-odds).
- **Acceptance (two clues):** with a content verdict, a join needs geometry ≥ 30 AND content "same"; without one,
  geometry alone must be unambiguous (no twin, margin ≥ 1.4) and ≥ 60. Twins always need content.
- **Consistency:** a join is refused when ≥ 35% of either seam is already used, when it closes a loop that disagrees
  with the page (> 6 px or > 2°), or when it makes placed pieces overlap (> 300 px² + 2% of the smaller piece).
- **Implied seams:** once pieces are placed, every pair whose outlines meet is measured; those seams join the refinement
  and are reported as joins (loop closures).
- **Joint refinement:** Gauss–Newton on point-to-line residuals of every seam of the page, all poses at once
  (largest piece fixed), correspondences re-found each iteration (6 iterations).
- **Upright:** text lines horizontal, reading left to right by the up vote; without text, the dominant page-edge
  direction, portrait.
- **Result:** pages (poses photo → page), joins (geometry, content, which clue decided), unplaced pieces with a reason
  (`no-match`, `twin-unresolved`, `rejected`), per-page confidence, completeness (share of torn edge covered by seams)
  and page corners found. Nothing is forced: a piece that joins nothing stays unplaced.

## Interfaces

```ts
import { solve, prepare, contentRequests, askAll, finish, renderSeam, renderChoiceSheet, renderPage, encodePng,
         museContentCheck, fragmentsFromSegments } from "@/lib/rejoin";

// from S2's segmentation to a solved page, Muse deciding where geometry ties
const inputs = fragmentsFromSegments(photoRgba, segmented.fragments);
const result = await solve(inputs, { content: museContentCheck({ verifySeam, chooseContinuation }) });
const png = encodePng(renderPage(result.pages[0], prepare(inputs).fragments));
```

- `FragmentInput = { id, mask: {width, height, data}, x0, y0, rgba? }` (a crop of the photo).
- `ContentCheck = (req: ContentRequest) => Promise<ContentVerdict | null>`; `req.render()` draws the image.
- Staged use for a UI: `prepare` (sync) → `contentRequests` → run the checks your way → `finish` (sync).

## Parameters

| Where | Parameter | Default | Meaning |
|---|---|---|---|
| contour | blur, smooth, spacing | 1 pass, 1 px, 1 px | pre-blur, outline smoothing, resampling |
| edges | halfWindow, localRms, minStraight, maxRms, maxDev | 12 px, 1.0, 48 px, 1.0, 3.0 px | straight page-edge detection |
| edges | cornerTurn, cornerScale, minSegment | 60°, 14 px, 24 px | torn-edge splitting |
| match | step, chord, window | 2 px, 8 px, 44 samples (88 px) | turning-function seeds |
| match | seedStd, seedRatio, minShapeStd, seedsPerPair | 0.2 rad, 0.25, 0.12 rad, 8 | seed acceptance |
| match | inlier, minOverlap, maxRms | 3 px, 30 px, 2.2 px | seam definition |
| match | fineFloor, fineScale | 0.6 px, 0.16 px | fine-residual quality (tied to the mask noise level) |
| match | twinRatio, twinFootprint | 0.7, 0.8 | twin groups |
| assemble | minGeomScore, minMargin, minContentScore | 60, 1.4, 30 | the two-clue acceptance rule |
| assemble | loopPx, loopDeg, overlapPx, seamReuse | 6 px, 2°, 300 px², 0.35 | consistency |

`fineFloor` is the one parameter tied to the segmentation: it sits at the fine residual of true seams under the mask
noise of SAM 3.1 as measured in the spike (median 0.65 px boundary error). Masks with more high-frequency noise need a
higher floor.

## Evaluation (Bench-S)

See the tables below; regenerate with:

```
python -I scripts/bench/fetch_pages.py          # pages (public domain, Commons)
python -I scripts/bench/generate.py              # cases into scripts/bench/out/ (fixed seeds)
pnpm tsx scripts/eval/solver.ts                  # geometry only
pnpm tsx scripts/eval/solver.ts --family stack --content oracle:0.1
```

RESULTS_PLACEHOLDER
