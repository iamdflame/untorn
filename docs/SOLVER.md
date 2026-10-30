# The Untorn solver

Untorn puts torn documents back together from one photo. SAM 3.1 outlines every piece; this solver works out where
each piece belongs. A join between two pieces needs two clues: the torn edges fit (geometry, this module), and the
content continues across the seam (Muse Spark reads the half-letters, injected as a callback). Geometry proposes,
ranks and assembles. Where it cannot decide (stack tears, whose pieces share identical outlines), reading decides.

- **Code:** `src/lib/rejoin/`, pure TypeScript with typed-array rasters and no DOM or Node APIs; it runs in the browser
  and in Node.
- **Benchmark:** `scripts/bench/` (Bench-S generator and pages). **Eval:** `scripts/eval/solver.ts`; real photos:
  `scripts/eval/real.ts` (ground truth registered on a photo of the intact page; the photos stay private).

## Pipeline

```
photo + masks ──► working scale ──► per piece: outline, edges, text angle ──► pairwise matching ──► content requests ──► assembly
                  (scale.ts)         (fragment.ts)                             (match.ts)            (solve.ts → S2)     (assemble.ts)
```

### 0 · Working scale (`scale.ts`)
The geometry works in pixels, and real tears have a physical scale: fibre rims and raggedness of a fraction of a
millimetre, shapes of centimetres. A 24 MP phone photo of a page is about 2.6 times the scale the parameters were
tuned at (Bench-S pages are 1000 px wide with lines ~35 px apart; a phone photo's lines are ~100 px apart).
- `prepare()` measures the median text-line pitch on small copies of the pieces and resamples every piece so lines
  are **32 px** apart: box-averaged colour, masks kept where at least half covered. It never enlarges.
- **Floor:** the median piece keeps at least ~60k px²; 30-piece tears would otherwise lose their shape.
- **Without text:** by piece size (median area over 400k px² is brought to 160k).
- **Results are in photo px:** `finish()` converts every pose, page size and length back. Page renders use the pieces
  as given (`prep.photo`).
- **Measured on the real photo** (lines 104 px apart, working scale 0.307): at full resolution none of the 122
  candidates was a true seam; at the working scale the true seams rank first.

### 1 · Outline (`contour.ts`)
- **Trace:** marching squares on the mask after one light binomial blur (σ ≈ 0.7 px), iso-level 0.5 between pixel
  centres, so the outline is subpixel. The largest loop is kept; holes and specks are dropped.
- **Clean up:** resample at 1 px, smooth with a Gaussian (σ 1 px), resample again.
- **Orientation:** positive signed area.

### 2 · Edges (`edges.ts`)
- **Straight page edges:**
  - a line is fitted over a 25 px window at every outline point;
  - runs of points whose local RMS is under 1 px are grown and trimmed against their own line, and merged when collinear;
  - a run is kept when it is at least 48 px long, with RMS ≤ 1 px and deviation ≤ 3 px. Short runs must be
    straighter, because a quiet stretch of tear can look straight over a few tens of px.
- **Torn edges:** everything else, split at strong turns (≥ 60° over ±14 px).
- **Page corners:** two straight edges meeting at 90° ± 14° and turning convex, allowing a rounded gap of up to 16 px.

### 3 · Text orientation (`orientation.ts`)
- **Angle:** ink pixels (darker than the paper tone, away from the edge) are projected across lines at every angle
  (1° steps, then 0.1°). Text lines make the projection peaky. Strength = the peak criterion ÷ its median over angles.
- **Line regularity decides between peaks:** a narrow strip projected along its length can be as peaky as along its
  short lines; only text lines are periodic at the line pitch. Among the projection peaks within 0.4× of the strongest,
  the one with the most regular line period wins (true angles: regularity 0.42–0.73 on the real photo; false peaks
  0.02–0.15).
- **Local paper level as a fallback:** shadows, curl and vignetting read as ink against one paper level per piece. When
  a reading is weak (confidence < 0.6), ink is measured against the local paper level (`raster.localPaperLevel`), and
  that reading is kept only when clearly stronger (+0.3) with regular lines (≥ 0.35).
- **Line pitch:** from the profile's autocorrelation. **Line grid:** the period and phase of the line centres at
  sub-pixel precision, from the strongest Fourier component of the profile near that pitch, with its regularity.
- **Which way is up:** Latin script has more ascenders than descenders, so the ink just above each x-height band
  outweighs the ink just below it.
- **Blank pieces** return `null`.
- **How matching uses it:** only to prune seeds, and only when both pieces are very confident (≥ 0.85). Monospaced
  typescript also lines up in columns, which can win on a narrow piece, so matching never depends on the angle.

### 4 · Matching (`match.ts`)
For every pair of fragments:
1. **Seed with turning functions.**
   - Tangent angles are taken every 2 px (8 px chords) along continuous torn chains, with one side reversed.
   - On every diagonal (relative offset), a sliding 88 px window measures the variance of the angle difference.
   - A window is a seed when the difference is nearly constant and explains most of the window's own shape variance.
     The constant is the rotation.
   - The best 8 seeds per pair go on.
2. **Fit** a rigid transform to the window's point pairs (2D Kabsch), and screen it in one pass.
3. **Refine with ICP.**
   - Point-to-line ICP over the whole outline, Huber-weighted, with a shrinking inlier band (7 → 4.5 → 3.5 px).
   - Only points whose normals face each other pair up, so page edges never match page edges.
   - The seam is the best contiguous run of inliers. A run bridges up to 30 px of "near" points (a mask-noise blob),
     but breaks after a few unmatched ones.
4. **Score** = seam length × fine-residual quality × conditioning gate − area overlap / 10.
   - **Fine residual:** the seam residual minus its 18 px moving average.
     - On a true seam it is mask noise only. Two different tears can be bent into coarse agreement by the fit, but their
       fine raggedness never agrees.
     - On the dev set it is 0.53–0.72 px (p10–p90) on true seams and 0.85–1.21 px on false ones. Raw RMS overlaps far
       more, and the coarse part does not separate them at all.
     - Quality = exp(−½ ((fine − 0.6) / 0.16)²) above the 0.6 px floor.
   - **Conditioning:** the ratio of the eigenvalues of Σ n nᵀ over the seam normals. A straight seam can slide, so its
     score is gated (full weight from 0.08).
   - **Area overlap:** the area of one piece sinking more than 3 px into the other.
5. **Rank.**
   - Candidates compete when their seams cover the same stretch of edge (≥ 30% overlap, same edge kind).
   - The margin is the score ratio to the best competitor.
   - Geometry confidence = (1 − e^(−score/60)) × (1 − 1/margin²).
6. **Twins (stack tears).** Two competing candidates for one anchor are twins when:
   - their partners are different fragments;
   - both score ≥ 40, within a factor of 2;
   - their placed footprints cover each other (≥ 80% both ways) with similar area.

   Pieces that cover each other almost exactly (≥ 92%, area ratio ≥ 0.93) form a **twin class** (same outline). Two
   pieces of one class come from different pages, so joins between them are dropped and the rest re-ranked; this
   removes chance fits between two edges of the same shape.
7. **Seam appearance** (`appearance.ts`), computed for every candidate scoring ≥ 25:
   - the paper-tone distance;
   - the correlation of ink profiles sampled 4–12 px inside each piece along the seam (text lines and rulings meeting).

   It is reported, not used to decide.
8. **Straight cuts** (`cuts.ts`, opt-in with `match.cuts`):
   - Douglas–Peucker polygon edges that fit a line are paired anti-parallel: end to end when the lengths match, at one
     end for a T-junction.
   - These joins are only ever accepted with the content clue.

### 4b · The text-line clue (`textlines.ts`, used by `match.ts` and `assemble.ts`)
On a printed page the lines of two pieces that belong together continue into each other: the same direction, the same
phase (a line on one side meets a line on the other, not the gap between two), the same way up. `textCheck` predicts
where b's lines land in a's frame under a candidate pose.
- **Trust:** a piece's grid counts only when its period is within 12% of the photo's consensus pitch (the median of the
  clear grids). Grids on typewriter columns or line harmonics are left out: on Bench-S this rejects 58 of 63 wrong text
  angles and keeps 64% of right ones.
- **Phase:** measured on the ink near the seam on each side (within 2.5 lines), so paragraph gaps and a period a few
  percent off do not drift it.
- **Pruning:** between two trusted pieces, a candidate is dropped when the directions differ by more than 6°, the lines
  are more than 0.3 of a pitch out of phase, or the join turns a piece upside down (both up votes ≥ 0.75). Contradicted
  chance fits then stop competing with true seams for margin.
- **Seeds from the lines:** for trusted pairs the lines fix the rotation (the up votes settle the half turn). Every pair
  of torn outline samples with facing normals then votes for the translation, weighted by line phase (`textSeeds`), and
  ICP starts from the best peaks. This finds seams the turning functions miss when fibre rims and curl blur an edge's
  fine shape. It is skipped for pieces with a twin class, so stack ambiguity stays for reading.
- **Assembly:**
  - a join on geometry alone between two pieces with line grids needs the lines to continue: direction within 6°
    whatever the angle confidence (the wrong p3–p8 join of the first real run was 20° off), in phase where measurable,
    not flipped;
  - the joint refinement keeps trusted pieces' lines parallel beyond a 0.6° dead zone (stiffness 3·10⁴). Stiffer
    helps real photos but moves Bench-S pieces beyond its 3 px / 1° tolerance.
- **Measured on the real photo:** all 7 true candidates within 2.7° and 0.18 of a pitch. Of 114 false candidates with
  text on both sides, 12 pass the direction test and 2 pass direction and phase; one of those 2 is a flip the up vote
  rejects.

### 5 · Content requests (`solve.ts`, `seam.ts`)
- **One k-way choice sheet per anchor and class of twins:**
  - the anchor's seam window on top, each candidate's partner alone in the same frame below, labelled A, B, C (the
    spike's validated format, 9/9 with Muse Spark);
  - asked from both classes of a slot by default (`twinSides: "both"`), so every pick is confirmed from the other side.
- **Pair checks** for the strongest plausible joins (score ≥ 30, margin ≥ 0.7; at most 48): both pieces joined, the
  tear drawn as a dark line (the spike's validated format).
- **Windows:** 420 × 150 px, centred on the stretch of seam with the most ink on both sides, rotated so the anchor's
  text reads left to right, and scaled to about 32 px per text line. `uprightKnown: false` tells the model to also read
  the image turned 180°.
- **Fusion:** verdicts become per-candidate log-odds. A pick adds evidence for it and against the others on its sheet.

### 6 · Assembly (`assemble.ts`)
- **Order:** combined confidence (geometry log-odds + content log-odds).
- **Acceptance (two clues):**
  - With a content verdict, a join needs geometry ≥ 30 and content "same".
  - A read confirms only what the outline does not contradict. Outside twin groups and straight cuts, a "same" needs:
    - the outline fit not to prefer another partner on that edge: score ≥ every rival's with another partner
      (`minContentMargin` 1 over `marginOther`; another alignment of the same two pieces is no rival);
    - the text lines to continue where both pieces carry them (direction within 6°, phase within 0.3 of a line where
      measurable, neither piece turned upside down);
    - the reads fused at confidence ≥ 0.7 (`minReadConfidence`): a hesitant "same" is no second clue.

    On the real photo Muse said "same" at 0.55–0.85 to chance fits whose edge other partners fitted better; one turned
    a piece 154° against its neighbours.
  - A twin needs two concordant reads (`minTwinVotes`), so one unconfirmed pick never places a piece.
  - Without content, geometry alone must be unambiguous (no twin, not a straight cut, margin ≥ 1.4) and ≥ 60, with
    the text lines continuing as above.
- **Consistency:** a join is refused when:
  - ≥ 35% of either seam is already used;
  - it closes a loop that disagrees with the page (> 6 px or > 2°);
  - it makes placed pieces overlap deeply (> 6 px deep, > 300 px² + 2% of the smaller piece).
- **Component alignment:** when two partial pages merge, the transform is refined by ICP over every seam between them,
  not just the joining one. One seam pins the rotation weakly, and the error grows with distance from it.
- **Relaxation:** after the greedy pass, margins are re-checked against the rivals that are still possible (seam free,
  pair not joined, consistent with the page). Joins whose rivals dropped out are accepted. This repeats until nothing
  changes.
- **Final page check:** no piece may lie on another (stricter than during the merges: 300 px² + 2% of the smaller), and
  no piece's text lines may contradict its page (`linesAstray`). The page's lines run where most of its trusted line
  weight agrees (grids on the photo's pitch). A trusted piece more than 6° off them is taken off only when its own ink
  shows no lines along the page's direction either (`linesAlong` < 0.15: its estimate was no 90° alias); a piece whose
  clear up vote reverses the page's reading direction is taken off too. Offending pieces go weakest first, and the rest
  of the page splits along its remaining joins. On Bench-S's true pages it flags none of 938 pieces; it catches 49 of 52
  trusted pieces turned 26° off their page, 50 of 52 at 154°.
- **Implied seams:** once pieces are placed, every pair whose outlines meet is measured. Those seams join the
  refinement and are reported as joins (loop closures).
- **Joint refinement:** Gauss–Newton on point-to-line residuals of every seam of the page, all poses at once (largest
  piece fixed), with correspondences re-found at each of 6 iterations.
- **Upright:** text lines horizontal, reading left to right by the up vote. Without text, the dominant page-edge
  direction, portrait.
- **Result:**
  - pages (poses photo → page);
  - joins (geometry, appearance, content, which clue decided);
  - unplaced pieces with a reason (`no-match`, `twin-unresolved`, `rejected`);
  - per page: confidence, completeness (share of torn edge covered by seams), page corners found.

  Nothing is forced: a piece that joins nothing stays unplaced. An optional `trace` callback reports every acceptance
  decision (accepted / pair-joined / seam-taken / loop-disagrees / overlap).

## Interfaces

```ts
import { solve, prepare, contentRequests, askAll, finish, renderSeam, renderChoiceSheet, renderPage, encodePng,
         museContentCheck, fragmentsFromSegments } from "@/lib/rejoin";

// from S2's segmentation to a solved page, Muse deciding where geometry ties
const inputs = fragmentsFromSegments(photoRgba, segmented.fragments);
const result = await solve(inputs, { content: museContentCheck({ verifySeam, chooseContinuation }) });
const png = encodePng(renderPage(result.pages[0], prepare(inputs).fragments));
```

- `FragmentInput = { id, mask: {width, height, data}, x0, y0, rgba? }` is a crop of the photo; `x0, y0` is its position.
- `ContentCheck = (req: ContentRequest) => Promise<ContentVerdict | null>`; `req.render()` draws the image.
- `museContentCheck` adapts S2's `verifySeam` / `chooseContinuation` (`MuseOutcome` = `{ok, value, meta}`):
  - images are sent as PNG;
  - a failed call is "can't tell";
  - `rotated: true` is passed when "up" is unknown.
- **Staged use for a UI:** `prepare` (sync) → `contentRequests` → run the checks your way → `finish` (sync).

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
| match | twinRatio, twinFootprint, twinMinScore | 0.5, 0.8, 40 | twin groups |
| match | cuts | false | straight-cut candidates (opt-in) |
| solve | twinSides, maxPairChecks | "both", 48 | content requests |
| assemble | minGeomScore, minMargin, minContentScore, minTwinVotes | 60, 1.4, 30, 2 | the two-clue acceptance rule |
| assemble | minContentMargin, minReadConfidence | 1, 0.7 | what a read may confirm |
| assemble | linesMaxAngle, linesMaxPhase | 6°, 0.3 line | text lines continuing across a join |
| assemble | pageLines, astrayAlong | on, 0.15 | final page check of the text lines |
| assemble | loopPx, loopDeg, overlapPx, seamReuse | 6 px, 2°, 300 px², 0.35 | consistency |

`fineFloor` is the one parameter tied to the segmentation. It sits at the fine residual of true seams under the mask
noise of SAM 3.1 as measured in the spike (median 0.65 px boundary error). Masks with more high-frequency noise need a
higher floor.

## Evaluation (Bench-S)

**Bench-S** (`scripts/bench/generate.py`):
- **Pages:** 14 real public-domain page images (`scripts/bench/PAGES.md`): typed (3 English, 3 German typescript),
  printed (2 English, 2 German Fraktur) and handwritten (2 English, 2 German).
- **Tears:** each page is torn recursively along ragged fractal paths. The roughness matches the spike's tear model at
  12–100 px and tapers below. Each tear has a white fibre rim on one side.
- **Scene:** pieces are scattered on a wood desk with shadows, vignette, noise and JPEG.
- **Masks:** the solver gets SAM-like noisy masks (median 0.65 px, worst p90 1.8 px boundary error, as SAM 3.1 measured
  in the spike).
- **Seeds:** fixed. Families are disjoint from the 12 dev cases used for tuning. Regenerate with:

```
python -I scripts/bench/fetch_pages.py          # pages (already committed)
python -I scripts/bench/generate.py              # all families into scripts/bench/out/ (about 110 MB, not committed)
pnpm tsx scripts/eval/solver.ts                  # geometry only
pnpm tsx scripts/eval/solver.ts --family stack --content oracle:0.1
```

Two cases are committed in `scripts/bench/sample/` (single-1001, stack-4001) so the harness runs without generating:
`pnpm tsx scripts/eval/solver.ts --root scripts/bench/sample`.

A fragment is **placed correctly** when its pose is within 3 px (at its centroid) and 1° of the truth, up to one rigid
transform per page.
- A predicted page counts toward the true page holding a strict majority of its pieces.
- **Split off:** assembled consistently with the truth, but in a separate group.
- **Mis-placed:** a wrong pose or a wrong page.
- **Joins:** correct when the pair is adjacent and the joined pose is within 4 px / 1.5° of the truth.
- **Runtime:** Node 24 on one core of the dev machine, excluding photo decoding.

### Geometry only

| Family | Cases | Pieces | Placed correctly | Split off | Mis-placed | Unplaced | Join precision | Join recall | Perfect pages | Twin seams detected | Runtime median (max) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| single page, 8–12 pieces | 24 | 218 | **97.2%** | 4 | 0 | 2 | 100.0% | 95.7% | 22/24 | – | 0.61 s (1.03 s) |
| single page, 6–7 pieces | 6 | 40 | 95.0% | 2 | 0 | 0 | 100.0% | 92.4% | 5/6 | – | 0.33 s (0.76 s) |
| single page, 26–38 pieces | 8 | 271 | **100.0%** | 0 | 0 | 0 | 100.0% | 91.8% | 8/8 | – | 2.79 s (3.40 s) |
| mixed bag, 2–3 pages | 8 | 160 | 99.4% | 0 | 0 | 1 | 100.0% | 98.4% | 19/20 | – | 2.12 s (2.91 s) |
| 35% straight cuts | 6 | 57 | 87.7% | 2 | 0 | 5 | 100.0% | 84.0% | 4/6 | – | 0.51 s (0.79 s) |
| stack, 3 pages × 6–10 | 8 | 192 | 0% (left for reading) | 0 | **0** | 192 | – | – | 0/24 | **84.4%** | 3.16 s (4.41 s) |

### Stack tears with a content check

An oracle answers each content request from the ground truth and errs at a set rate. This simulates Muse at its
measured accuracy: 82% on adversarial binary seams in the spike, 96–100% through S2's client.

| Oracle accuracy | Placed correctly | Split off | Mis-placed | Unplaced | Join precision | Join recall | Perfect pages | Choice sheets per case, median (range) |
|---|---|---|---|---|---|---|---|---|
| 100% | **99.0%** | 0 | 0 | 2 | 100.0% | 97.1% | 22/24 | 95 (53–140) |
| 90% | **92.2%** | 10 | **0** | 5 | 100.0% | 90.2% | 15/24 | 95 (53–140) |
| 82% | **85.9%** | 14 | 2 (1.0%) | 11 | 98.9% | 83.8% | 11/24 | 95 (53–140) |

8 cases, 192 pieces (3 pages × 6–10 pieces, torn by the same paths).

- **Pixel appearance alone** (ink continuing, paper tone) ranks the true twin first in 194 of 405 twin groups (48%;
  chance is about 33%). Reading is what decides stacks.
- **Asking from one side only** (`twinSides: "one"`) halves the calls but misplaced 6 of 39 pieces on two trial stacks
  at 90%, against 0 with both sides.

### The content clue on ordinary tears

With a 90% oracle on every plausible join (the two-clue rule), placement is a little lower and still has no
misplacements: single pages 96.3% (2 unplaced, 6 split off), mixed bags 97.5%. On unambiguous tears geometry is
already decisive. A wrong "no" removes a join that geometry alone would have taken, and the page graph's redundancy
absorbs most of it.

### Other checks
- **Exact masks instead of SAM-like noise:** single pages 97.2%, the same as with noise. The failures are not mask
  noise.
- **Straight cuts** (`cut` family, 35% of the divisions straight):
  - geometry alone places 87.7% with 0 misplaced; pieces across a straight cut stay apart unless torn edges link them;
  - with the experimental cut matcher and a 90% oracle: 82.5%, 4 misplaced. It stays opt-in.
- **ShredBench** (`data_8`, Voronoi cuts, Blender renders): the photo runner accepts a segmented photo
  (`scripts/eval/photo.ts`). Its pieces have only straight cuts, so the torn-edge matcher (correctly) joins almost
  nothing. The bounded cut matcher proposes 397 candidates in 2.2 s on `news_001`, which need the content clue. See the
  report for what an end-to-end ShredBench run needs.

## Real hand-torn paper (`scripts/eval/real.ts`)
- **Case:** one page torn by hand into 10 pieces, photographed with a phone on a dark wavy mat (4284×5712), plus a
  photo of the same page intact.
- **Ground truth:** each SAM piece is registered on the intact page by masked normalised cross-correlation over
  rotations and scales, then refined. Tolerance: 1.5% of the page width (39 px) and 2°.

| | Before (full resolution) | Now |
|---|---|---|
| True seams among the candidates | 0 of 122 | 8 within tolerance, ranks #1–#86 |
| Geometry only | 0/10 placed correctly, 4 misplaced | **8/10 placed correctly, 0 misplaced** |
| Live pipeline (SAM + Muse) | 0/10, 4 misplaced, transcript CER 77–88% | **8/10, 0 misplaced**, CER 11.6%, $0.22 |

What the real photo showed:
- the scale problem above;
- the camera's perspective: about 5% scale difference across the photo;
- fibre rims: outlines overlap by 5–18 photo px at the true pose;
- wrong text angles on 3 of 10 pieces;
- turning-function seeds missing seams whose fine shape the rim blurs.

`match.rimMax` lets a seam rest at its rim overlap. It is off by default: the overlap the outline fit recovers is
small and noisy, and enforcing it cost Bench-S large 3 px precision on 50 of 271 pieces.

## Known weaknesses
- **One real photo so far.** The real-paper numbers come from one hand-torn page (plus composites of its pieces); the
  thresholds of the text-line clue were checked against Bench-S, not tuned on that page.
- **Fibre rims** offset the content by a few px at a real seam; geometry cannot recover the offset (see above). The
  text lines could, for seams that cross them.
- **Gentle, featureless tears** can slide along themselves; their candidates rest up to a line off and compete at low
  margins (p4–p6 on the real photo).
- **Straight cuts:** geometry cannot confirm them, and the cut matcher does not yet help.
- **Stacks need many reads:** a median of about 95 choice sheets for a 3-page stack of 6–10 pieces per page, with both
  sides asked.
- **Text orientation** can lock onto monospace columns on narrow pieces. Up/down relies on an ascender/descender vote.
- **No curl, perspective or double-sided pieces.** Outlines are matched as rigid 2D shapes.
