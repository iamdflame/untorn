# Untorn's model layer

Untorn puts torn documents back together from one photo. Three Meta models do the work. The server modules live in `src/lib/server/`, and route handlers call them.

| Model | Job in Untorn | Module |
|---|---|---|
| **SAM 3.1** (`sam-3.1`) | Finds every fragment in the photo and cuts it out to the pixel | `segment.ts` → `segmentFragments` |
| **Muse Spark** (`muse-spark-1.3`) | Reads half-letters across a candidate seam, like a crossword, to decide which pieces belong together. When pages were torn as a stack, outlines repeat and the reading decides. It also transcribes and translates the finished page. | `muse.ts` → `verifySeam`, `chooseContinuation`, `readPage`, `translate` |
| **Muse Wonder** (`muse-wonder-1.0`) | Sorts a mixed pile of fragments into pages | `muse.ts` → `sortFragments` |

Every number below was measured on **simulated tears**: the spike's `tear.py` applied to a public-domain 1903 letter and to synthetic typed and handwritten pages, plus 5 ShredBench renders. Nothing here has been tested on real hand-torn paper yet.

## Function signatures (for the UI and the solver)

```ts
// segment.ts
segmentFragments(photo: Uint8Array, opts?: SegmentOptions): Promise<SegmentResult>
type Fragment = {
  id: number;                       // reading order in the photo
  box: [x1, y1, x2, y2];            // inclusive, full-resolution photo px
  polygon: [number, number][];      // closed outline, clockwise, full-res px (pixel (x,y) covers [x,x+1))
  mask: { x, y, width, height, data: Uint8Array };  // 0/1 raster, top-left at (x, y)
  area: number;
  confidence: number | null;        // SAM's
  refined: boolean;                 // false: refinement failed, the snapped pass-1 mask stands in
  method: "snap" | "crop" | "fullres" | "snap-fallback";
  snap?: { separation: number | null; agreement: number };
};
type SegmentResult = { width, height, variant, fragments: Fragment[],
  pass1: { concept, count, longSide, medianPieceSide, tiled, tileCount, afterTiles },
  timings: { decodeMs, pass1Ms, tilesMs, pass2Ms, outlineMs, totalMs },
  sentToSam, samCalls, costUsd, warnings: string[], calls: SamCallLog[] };
// Throws only when pass 1 itself fails: a non-retryable SAM error, or retries and the hedge both exhausted.

// muse.ts: every function returns a MuseOutcome and never throws for an upstream problem
type MuseOutcome<T> = { ok: true; value: T; meta: CallMeta } | { ok: false; error: MuseFailure; meta: CallMeta };
type MuseFailure = { code: "network"|"timeout"|"aborted"|"rate_limited"|"upstream"|"billing"|"auth"|"bad_request"|"empty"|"unparseable"|"incomplete"|"config";
                     message: string; status: number | null; retryable: boolean };
type CallMeta = { fn, model, effort, promptVersion, attempts, ms, lastAttemptMs, usage, costUsd, responseId, lanes };

verifySeam(seamImage: ImageInput, opts?: ReadingOptions & { prompt?: "v1"|"v2"|"flush" })
  → MuseOutcome<{ same_place: boolean; confidence: number; words_across: string[]; reason: string }>
chooseContinuation(sheetImage: ImageInput, k: number, opts?: ReadingOptions & { prompt?: "v1"|"v2"|"joined" })
  → MuseOutcome<{ choice: "A".."P"; index: number; confidence: number; words_across: string[]; reason: string }>
readPage(pageImage: ImageInput, opts?) → MuseOutcome<{ text: string; language: string; uncertain: string[] }>   // gaps are "[…]"
translate(text: string, to: string, opts?) → MuseOutcome<{ text: string; source_language: string; to: string }>
sortFragments(crops: ImageInput[], opts?) → MuseOutcome<{ groups: { fragments: number[]; reason: string }[];
                                                          repaired: { missing: number[]; duplicated: number[] } }>
type ImageInput = { data: Uint8Array; mime: "image/jpeg"|"image/png"|"image/webp"; detail? } | { url: string; detail? };
type ReadingOptions = MuseOptions & { rotated?: ImageInput };   // also send the 180° copy when "up" is unknown
// MuseOptions: model, effort, maxOutputTokens, timeoutMs, deadlineMs, hedgeAfterMs, maxAttempts, signal, onLog, …
```

- **Seam sheets.** The solver renders them.
  - `verifySeam` expects two pieces edge to edge with a dark tear line between them (`crossword.py` style, about 420×150 px at roughly 1500 px page width).
  - `chooseContinuation` expects the spike's sheet: the left fragment on top, then the k candidates on separate labelled rows (`crossword3.py` style). Pass `prompt: "joined"` for sheets where each candidate is already joined to the left piece.
- **Unknown orientation.** When a pair's "up" is unknown, pass `rotated` (the 180° copy; `images.ts` → `rotate180Jpeg`).
- **Prompts.** All prompts and schemas are in `src/lib/server/prompts.ts`, versioned by `PROMPTS_VERSION`, and the version rides on every call's meta.

## Segmentation

**Pipeline.**

**Pass 1: locate.**
- The photo is downscaled to a 1280 px long side and sent with the concept "torn piece of paper". If that finds nothing, it falls back to "piece of paper", then "paper".
- Unions and duplicates are merged by mask IoU.
- Busy scenes are also cut into 2×2 overlapping tiles. That happens when there are more than 16 pieces and the median piece is under 48 px in pass-1 pixels.

**Pass 2: bring each mask to full resolution.** Three variants:
- (a) `fullres-boxes`: the full-resolution photo with up to 16 box (+point) prompts per request.
- (b) `crops`: a full-resolution crop per piece with a box prompt, 3 positive points deep inside the pass-1 mask and a negative point in each neighbour, run 8 at a time.
- (c) `snap`: no second call. The pass-1 mask is upsampled and every pixel within ±(1.5 × scale) px of its outline is re-decided by colour, using Gaussian models of the paper ring just inside and the desk ring just outside. Inside the mask, ink stays paper.

**Default `auto`.** Every piece is snapped. A piece goes on to (b) only when the snap is unsure:
- its robust paper/desk colour separation is below 3, or
- the snap's IoU with its pass-1 mask is below 0.85.

**Requests.** Every SAM request retries network errors, 429 and 5xx with backoff. It is also **hedged**: if it hasn't answered after 7 s, an identical request starts beside it and the first answer wins.

### Measured: simulated photos with ground truth

Measured with `scripts/bench/segment-bench.mts`. The mask eval is a TypeScript port of `eval_masks.py` and reproduces the Python numbers on the spike's own masks.

| Photo | Variant | Found | Mean IoU | Median boundary error | Worst p90 | Latency (total) | SAM calls |
|---|---|---|---|---|---|---|---|
| sim12: 12 pieces, 2400×1800 | **auto (= snap)** | **12/12** | 0.987 | **0.46 px** | 1.20 | **1.9–3.7 s** (11 of 12 runs; one run before hedging took 50 s) | 1 |
| sim12 | (b) crops | 12/12 | 0.990 | 0.46 px | 5.09 | 5.6–8.9 s | 13 |
| sim12 | (a) full-res boxes | 12/12 | 0.983 | 0.76 px | 2.23 | 5.4–9.8 s | 2 |
| sim12b: 12 pieces, typed page | auto | 12/12 | 0.986 | 0.41 px | 1.26 | 2.3–2.5 s | 1 |
| sim12b | crops / full-res | 12/12 | 0.991 / 0.984 | 0.44 / 0.66 px | 1.70 / 1.93 | 6.2 / 5.4 s | 13 / 2 |
| t1: the spike photo, 10 pieces | auto | 10/10 | 0.989 | 0.36 px | 1.03 | 2.7–3.6 s | 1 |
| t1 | crops / full-res | 10/10 | 0.992 / 0.986 | 0.45 / 0.64 px | 1.66 / 2.04 | 7.7 / 6.4 s | 11 / 2 |
| stack30: 3 pages, same tears, 30 pieces, 4000×3000 | **auto** | **30/30** | 0.985 | **0.52 px** | 1.45 | **2.7–4.4 s** (9 of 10 runs; one run before hedging took 30 s) | 1 |
| stack30 | snap + forced tiles | 30/30 | 0.989 | 0.42 px | 1.26 | 11.2 s | 5 |
| stack30 | crops + tiles | 30/30 | 0.991 | 0.48 px | 1.46 | 17.5 s | 35 |
| stack30 | full-res boxes + tiles | 30/30 | 0.978 | 1.06 px | 3.24 | 28.6 s | 7 |

**Spike baseline.** One full-resolution concept call on t1: 10/10, IoU 0.987, 0.65 px, **59 s**.

**Pass-1 resolution.** On stack30, pass 1 alone found 30/30 at long sides of 1280, 1024, 768 and **512 px** (median piece 63 px). Snap error was 0.42–0.64 px. A pass-1 call takes about 2–4 s at every resolution.

**Latency tail.**
- Before hedging, 2 of 20 runs had a slow pass-1 call:
  - one hung for 45 s (its retry answered in 4.6 s);
  - one took 28.6 s.
- The 7 s hedge bounds that at about 7 s plus a normal call. In 12 runs since, it never needed to fire.

### Measured: ShredBench (Blender renders, curl, shadows, jagged Voronoi edges)

These are 5 images from the public repo's `data_8/` (4096×4096; only the 8-fragment samples are published so far). There is no mask ground truth, so this reports the count only:

| Image | Found / expected | Total latency | Pass 1 | Snap |
|---|---|---|---|---|
| news_001 | 8/8 | 7.1 s (4.3 s on an earlier run) | 3.9 s | 2.8 s |
| news_008 | 8/8 | 5.4 s | 3.7 s | 1.3 s |
| news_011 | 8/8 | 5.2 s | 3.1 s | 1.7 s |
| news_012 | 8/8 | 5.7 s | 3.3 s | 2.0 s |
| news_018 | 8/8 | 5.1 s | 3.7 s | 1.1 s |

**40/40 fragments.** With the robust separation, `auto` keeps every piece on the snap path (separation 5.9–24.7). The overlays (`.apex/build/S2-models/shredbench/results/*.jpg`) follow the jagged edges.

That run also turned up a problem with box-only SAM crops. On thin rotated shreds, the box holds mostly desk and neighbours, and SAM segmented the wrong thing in 4 of 8 crops. That is why crop refinement now adds the interior and neighbour points.

## Reading accuracy (`scripts/bench/reading-bench.mts`, through the client)

| Test | Model, effort, prompt | Correct | Empty or unparseable attempts | Failed calls | Median / p90 latency | Cost |
|---|---|---|---|---|---|---|
| **Binary**, spike cw1 (24: 12 true, 12 adversarial false) | Spark, low, v1 (spike wording) | 19/24 (79%); true 10/12, false 9/12 | 0/24 | 0 | 7.2 / 10.2 s | $0.17 |
| Binary, cw1 | **Spark, low, v2** (line-by-line crossword) | **23/24 (96%)**; true 12/12, false 11/12 | 0/24 | 0 | 9.3 / 13.5 s | $0.21 |
| **K-way** (k=3, stack tear), spike cw3 (12) | Spark, medium, v1 | 12/12 | 2/13 (one item reasoned for 18k tokens) | 0 | 10.6 / 31.4 s (max 77 s) | $0.21 |
| K-way, cw3 | **Spark, low, v1** | **12/12** | 0/12 | 0 | **6.9 / 9.8 s** (max 15 s) | $0.08 |
| K-way, cw3 | **Wonder, low, v1** | 11/11 answered (run 1 plus a rerun of its failures); trial 02 never answered within the 90 s deadline (3 tries) | 0 | 4 in run 1 (network connect timeouts and timeouts); trial 02 again on both reruns | median 20 s for answered items (6.8–39 s) | $0.41 |

**Spike, for comparison.**
- Binary: 14/17 answered, 7 network failures.
- K-way, medium: 9/9 answered, **3 of 12 empty**.

The new client answered every one of its 120 Spark bench calls. Its retries took care of the 2 empty attempts, both at medium effort.

**Trying to raise accuracy honestly.** Spark, low effort, 12-item subsets of freshly generated items (same generator, letter page at 1500 px):
- **Prompt wording:** v2 (read each crossing line, one broken line rejects) took binary from 79% to **96%** on the same 24 items. It was the default until seam v3 (below).
- **Seam v3, on the real hand-torn photo (2026-10-31).** These are the pair questions the live pipeline asks of IMG_5138 and of the same photo at 1920 px. Each is labelled from the registered truth: 13 correct seams (the true neighbours near their true pose) and 12 wrong ones. Each was asked twice per variant, at Spark low effort. Counts are confirm / veto / no clue:

  | Variant | Correct seams (26) | Wrong seams (24) |
  |---|---|---|
  | v2, working px, 3 px tear line (the old default) | 18 / **6** / 2 | 2 / 20 / 2 |
  | v2, photo px (2× detail) | 19 / 5 / 2 | 0 / 23 / 1 |
  | v3 first wording, photo px, thin line | 14 / 3 / 9 | 0 / 10 / 14 |
  | v3 first wording, working px, thin line | 17 / 1 / 8 | 1 / 17 / 6 |
  | **v3 as shipped, working px, thin line (the default)** | 16 / **2** / 8 | 2 / 19 / 3 |

  v2 vetoed true joins for two reasons:
  - a tear running along the lines (through a paragraph gap) left nothing to read across, and Muse answered "not the same" at 0.85, four times out of four;
  - the 3 px tear line hid the half-letters.

  v3 first asks whether the words can judge the join (`text_crosses`); where they can't, the read is no clue, and the join rests on its shape and lines. It draws the tear 1 px at 55%.

  Two fixes came from live runs of the first wording:
  - a partner whose text is upside down now counts as a broken line (the first wording answered "no clue" there);
  - a tear that crosses the lines between two words still has a sentence to read. The first wording let Muse call such a false join (p5–p8) blank, geometry took it, and a page split.

  As shipped, v3 vetoes a third as many true joins as v2, at the same number of false confirmations. Photo-pixel renders helped v2 a little, but they made v3 answer "no clue" more often, so the working-scale render stays.

  In live runs on IMG_5138, four each (v2 against the first v3 wording with the lines floor), the old setup placed 7, 7, 7 and 8 of 10, and the new one 4, 8, 7 and 8. Both misplaced a piece in some runs: true neighbours set 40–50 px off, past the scorer's 1.5% tolerance. Four runs cannot separate the two, so the change rests on the paired read measurement above.
- **Crop window:** 640×220 instead of 420×150 scored 11/12 against 10/12 for the 420×150 baseline. These were different items, so read it as a direction, not a result.
- **Seam with a gap vs flush:** on the same 12 items, flush (no dark tear line) scored 9/12 against 10/12 with the line. It didn't help, so the dark line stays.
- **Both orientations:** each image was sent upside down together with its upright copy. That scored 10/12, against 8/12 for the upright-only v1 baseline on the same items, so the extra copy does no harm. Use `rotated` when "up" is unknown.
- **Effort:** k-way at low effort matched medium's 12/12, cut latency by a third, and removed the runaway answers. The default is low. When an answer runs out of tokens, the client now retries one effort level lower with 1.5× the budget, instead of doubling the budget and the wait.

**sortFragments (Muse Wonder), 1 live call.** It got 2 typed and 2 handwritten crops and grouped the typed pair correctly. It split the handwritten pair into two groups ("red margin" vs "no red margin": one crop missed the margin). That is 1 trial: a known weak spot, not yet measured.

**readPage.** On the letter with a piece cut away, it marked 8+ gaps at the cut (`Lacle[…]`, `17[…]`) and invented nothing under the hole. The model wrote `[...]`, and the client normalises that to `[…]`.

**readPage on real tears: prompt v2 (live default since 1 Nov 2026).** A hand tear cuts letters and leaves a hairline between the pieces, and the first prompt took those for missing paper: on a real 6-piece page that came back whole it wrote 31–35 gaps (`two[…]-core`, `tim[…]es`). v2 says thin lines are tears to read across and keeps `[…]` for text that breaks off at a missing piece, never for blank paper. Three reads each, on the images the pipeline sends:

| Page | v1 | v2 |
|---|---|---|
| Real 6-piece page, whole | 35, 35, 31 gaps | 0, 0, 0 gaps |
| German letter (simulated tear), CER | 1.4%, 0.0%, 3.7% | 0.1%, 0.0%, 0.0% |
| 1927 letter (simulated tear), CER | 0.0%, 1.6%, 0.0% | 0.0%, 1.6%, 1.6% (the same single line) |
| Real page with 3 pieces missing | 46, 56, 33 gaps | 17, 17, 17 gaps, still at the missing pieces |

ShredBench keeps its own prompts (`markdown`, `parts`), so its numbers stand.

## Reliability

| Function | Retries | Hedge after | Per-attempt timeout | Deadline |
|---|---|---|---|---|
| SAM pass 1 / tiles | 3 | 7 s | 30 s | (attempts) |
| SAM crop | 3 | 7 s | 30 s | (attempts) |
| verifySeam / chooseContinuation | 4 | 20 s | 45 s | 90 s |
| readPage | 4 | 45 s | 90 s | 150 s |
| translate | 4 | 30 s | 60 s | 120 s |
| sortFragments | 4 | 60 s | 90 s | 150 s |

- **Retried:** network errors, timeouts, 429 (with Retry-After), 5xx, empty output, unparseable output, and output cut off by the token budget.
- **In the live pipeline (S7):** seam reads run at low effort, hedged after 9 s, 16 at a time, and the read stage stops
  at 30 s.
  - **Effort:** on the real tear's 15 seams, minimal effort was right 10, 11 and 11 times in three trials, against 11
    and 9 at low effort, in half the time. Live, though, it said "same" to a chance fit (p5–p8) in two runs of three,
    and the piece was misplaced; low effort reads that seam "not the same".
  - **Concurrency:** at 24 at a time (about 40 connections with hedges), most requests failed to connect within 10 s. Transcription runs at minimal effort on a 1600 px page: 6.7–8.0% character errors in 7–11 s,
  against 7.5% in 18–21 s at low effort on 2200 px.
- **Not retried:** 400/401/402/403/404/413.
- **Logging:** every attempt logs its latency, tokens and estimated cost. Requests use a generic `User-Agent: rejoin/0.1` and `store: false`.
- **Network from this machine:** `UND_ERR_CONNECT_TIMEOUT`/`fetch failed` errors came in bursts during the Wonder runs. The retry and hedge recovered most of them. For a live demo, run the server on a well-connected host.

## Costs

**Prices** (standard mode, docs 2026-10):
- SAM: $2.50 per 1,000 images.
- Spark: $1.25 in / $4.25 out per 1M tokens.
- Wonder: $4 in / $20 out per 1M tokens.

Reasoning tokens bill as output.

| Call | Typical cost |
|---|---|
| segmentFragments, auto | **$0.0025** (1 SAM image); crops variant $0.03 for 12 pieces |
| verifySeam, Spark low, v2 | $0.009 (≈200 in, 2,000 out) |
| chooseContinuation, Spark low (k=3) | $0.007 |
| readPage, Spark low, full letter | $0.013 |
| translate, Spark minimal | $0.002 |
| sortFragments, Wonder low, 4 crops | $0.04 |

**Example.** A 12-piece demo run is 1 SAM call, about 10 seam checks and one readPage: about $0.10.

## Rerun

```
pnpm tsx scripts/bench/segment-bench.mts t1,sim12,sim12b,stack30 auto,crops,fullres-boxes 1280 [reps]
pnpm tsx scripts/bench/reading-bench.mts cw1 binary muse-spark-1.3 low v2
pnpm tsx scripts/bench/reading-bench.mts cw3 kway muse-wonder-1.0 low
pnpm tsx scripts/bench/shred-bench.mts <dir with data_8/> auto        # RECORD=1 / REPLAY=1 to tune offline
pnpm tsx scripts/live/models-smoke.ts                                  # one real call per function, ~$0.08
python scripts/gen/tear.py <page> <out> 12 11 [--canvas 4000x3000] [--stack p2 p3]
python scripts/gen/seams.py binary|kway <page> <out> [--win 640x220] [--seam flush]
```

Unit tests (`pnpm test`) make no network calls. They replay recorded SAM 3.1 and Muse answers from `src/lib/server/__fixtures__/`.
