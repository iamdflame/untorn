# Untorn's model layer

Untorn puts torn documents back together from one photo. Five Meta models do the work in the live app: SAM 3.1 finds the pieces, Muse Spark reads across the tears and reads the page, Muse Spark Open (Meta's open weights) answers the reads Muse Spark is slow on and can take every read, Muse Wonder writes the page's archive record, and Muse Voice Transcribe writes down a spoken provenance note. The server modules live in `src/lib/server/`, and route handlers call them.

| Model | Job in Untorn | Module |
|---|---|---|
| **SAM 3.1** (`sam-3.1`) | Finds every fragment in the photo and cuts it out to the pixel | `segment.ts` → `segmentFragments` |
| **Muse Spark** (`muse-spark-1.3`) | Reads half-letters across a candidate seam, like a crossword, to decide which pieces belong together. When pages were torn as a stack, outlines repeat and the reading decides. It also transcribes and translates the finished page. | `muse.ts` → `verifySeam`, `chooseContinuation`, `readPage`, `translate` |
| **Muse Spark Open** (`meta-models/muse-spark-open`, Meta's open weights, on Baseten) | The same reads as Muse Spark, with the same prompts and schemas. By default it answers the reads Muse Spark hasn't answered within 9 s (the hedge goes to the other host) and any read Meta's API refuses; with "Read on open weights only" it takes every read, the transcript and the record. Measured against Muse Spark below | `muse.ts` → `museCall` (`altModel`), `chatBody`, `fromChat`; `live.ts` → `readHosts` |
| **Muse Wonder** (`muse-wonder-1.0`) | Writes the archive record of each rebuilt page from its transcript, after the page is shown: kind, date, place, sender, recipient, and the people, places and organisations named, every one quoting the page. (A second client sorts a mixed pile into pages; measured once, not in the live pipeline.) | `muse.ts` → `catalogPage`; `record.ts` → `verifyRecord`; `catalog.ts`; `sortFragments` |
| **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | Writes down the archivist's spoken note of where a page was found, into the record (`POST /api/notes`; the audio isn't kept) | `voice.ts` → `transcribeNote` |

The model measurements below were made on **simulated tears**: the spike's `tear.py` applied to a public-domain 1903 letter and to synthetic typed and handwritten pages, plus 5 ShredBench renders. Seam reads and the transcription prompt were also measured on real hand-torn photos (below). Results of the whole pipeline on real hand-torn paper are in the README and on [untorn.vercel.app/accuracy](https://untorn.vercel.app/accuracy).

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

## The archive record (`scripts/eval/catalog.ts`, through the client)

Each sample page's recorded transcript is catalogued, every answer goes through the same check the live app uses
(`record.ts`: each name and date must quote the transcript as whole words, a name must be the quote's own words, and a
date's ISO form must agree with the numbers written), and the checked record is scored against an answer key read off
the transcripts by hand. 7 pages: the letters of 1903, 1927 (twice: whole, and with gaps from the stack run), 1918 and
1922 (German), a page from the middle of a Vietnamese government letter, and a printed thesis page with no sender,
date or recipient. Field checks: kind, date (ISO), place, sender, recipient.

| Model, effort | Rounds | Field checks right | Quotes not on the page (left out) | Names found | Median time | Cost a page |
|---|---|---|---|---|---|---|
| Muse Wonder, minimal | 4 | **108 / 112** | **0** | 102 / 104 | 6–7 s | $0.015 |
| Muse Spark 1.3, minimal | 3 | 83 / 84 | 1 | 75 / 78 | 10–11 s | $0.005 |
| Muse Wonder, low | 1 | 27 / 28 | 0 | 18 / 26 | 17 s | $0.042 |
| Muse Spark 1.3, low | 1 | 28 / 28 | 1 | 25 / 26 | 25 s | $0.012 |

- **Chosen: Muse Wonder at minimal effort.** It was the fastest, found the most names, and never wrote a quote that
  isn't on the page. Its one repeated miss calls the Vietnamese mid-letter page (no date, no salutation) "other"
  rather than a letter. Spark was as accurate on the fields at a third of the price; Wonder's speed matters because the
  record arrives while the visitor reads the page.
- **What the check caught:** Spark twice quoted words that weren't in the transcript; the record left those fields out.
  The first prompt also turned "Gustav R e i m a n n" (letter-spaced, as typed in 1922) and "Dear Julian" into
  names; the check now closes up letter spacing, and the prompt asks for the name alone.
- All rows use the current field wording (`PROMPTS_VERSION` 2026-11-03.1); the summary was capped at 30 words before
  the last Wonder round. An earlier round on a first wording (names with greetings, nationalities as people) is not counted.
- **Voice notes:** a synthetic 11.4 s note ("Box twelve, folder three. Found in the attic of the house in Leipzig…")
  came back word for word in 6.3 s from the API; through the browser path (fake microphone, Opus, WAV at 16 kHz) on the
  live site in 2.3–5.2 s, with small slips on the synthetic voice. Cost: $0.18 per hour of audio.

## Meta's open weights: Muse Spark Open (`scripts/eval/open-weights.ts`, `scripts/eval/real-reads.ts`)

Muse Spark Open is Meta's open-weights Muse Spark. This site calls it on Baseten's Model APIs
(`meta-models/muse-spark-open`; the `-1026` id in the event guide answers 404) through chat completions, with the same
prompts and the same strict JSON schemas as Muse Spark (`muse.ts` → `chatBody`, `fromChat`). Any server that speaks
chat completions with these weights works the same: set `OPEN_API_BASE`. Baseten lists it at $1.25 in, $0.15 cached and
$4.25 out per 1M tokens (pricing page, 23 Oct 2026), the same as Muse Spark on Meta's API.

**The same tests as Muse Spark 1.3, one run each (3 Nov 2026):**

| Test | Muse Spark Open | Muse Spark 1.3 |
|---|---|---|
| Seam reads: 24 simulated seams, half of them true (cw1) | **23 of 24** | 22 of 24 |
| Stacks: 12 three-way choices between identical outlines (cw3) | 11 of 12 | **12 of 12** |
| Transcribing 5 rebuilt sample pages: character errors per page | 0.0, 2.1, 0.2, 4.6, 5.2% (mean 2.4%) | 1.6, 0.0, 0.2, 6.0, 5.4% (mean 2.6%) |
| Median time per call over these 41 calls | **10.4 s** | 15.5 s |
| The archive record, 7 pages × 3 rounds (minimal effort) | 80 of 84 field checks; 8 quotes not on the page, left out by the check; 71 of 78 names | Muse Wonder (in the app): 81 of 84 over the same 3 rounds; 0 quotes off the page |

- **On real paper:** every seam read from 10 runs of the whole pipeline on the real 10-piece hand tear, scored against
  the pieces' true neighbours (a lower bound: a true neighbour shown misaligned is rightly "not the same place"):
  Muse Spark 1.3 answered 120 (84 right, 20 wrong of which 2 a false "same", 16 no clue; median 15.7 s); Muse Spark Open
  answered 63 (37 right, 14 wrong of which 0 a false "same", 12 no clue; median 11.1 s). It never joined a wrong
  neighbour; it turned down true ones somewhat more often.
- The page transcriptions vary from run to run on both models (the first run of this eval had the German letter at
  0.7% for Spark Open and 14.7% for Spark 1.3); the pages are scored against the reference they match best, since a
  stack's pages come back in any order.

**The whole pipeline, run four ways on the same photos** (3 Nov 2026, `scripts/record-run.ts` on our machine, the
site's code; `scripts/eval/real.ts score` and `scripts/score-sample.ts`):

| Readers | The 6-piece real tear: whole page | The 10-piece real tear (pieces touching): placed correctly, misplaced | The 1927 letter (simulated): placed |
|---|---|---|---|
| Muse Spark alone (the site until now) | 2 of 3 runs (60–65 s) | 6, 7, 7, 9 of 10; 2 misplaced in 4 runs | 10/10 twice |
| **Muse Spark first, the open weights for its slow reads (the site's default now)** | **3 of 3 runs (53–59 s)** | 5, 8, 5, 6, 8 of 10; 6 misplaced in 5 runs | not run |
| The open weights first, Muse Spark for their slow reads | 1 of 3 runs (45–53 s) | 5, 6, 9 of 10; 2 misplaced in 3 runs | 10/10 twice |
| The open weights only (the site's switch "Read on open weights only") | 1 of 1 (63 s); a second run lost its reads to this machine's connection (below) | not run | 10/10, transcript 1.6% errors; the 1922 German letter 9 of 10, none misplaced, transcript 2.1%, translated |

- **Why this default:** on the page closest to what a visitor tears (about 6 pieces, laid apart), Muse Spark with the
  open weights answering its slow reads came back whole every time, and a little faster. Putting the open weights
  first was the fastest but left a piece out more often. The 10-piece photo is the hard case (its pieces touch, against
  the capture advice); there every setup varies from run to run. Most misplaced pieces are true neighbours set
  5–56 px or 1–3° off on curled paper, and both models confirmed such joins, in proportion to the reads each answered. Each cell
  is 1–5 runs: differences of one run are within the noise.
- **If the open-weights host fails** (no credit, down, slow), the hedge simply has nothing to add: a refusal from one
  host never settles a call the other is still answering (`muse.test.ts`, "two hosts").
- Two open-weights-only runs lost their seam reads to this machine's connection (two runs at once, about 30 seam
  images in flight over a slow uplink: requests failed to connect within 10 s, the limit noted for Meta's API under
  Reliability). The letter still came back 10 of 10 on its edges alone; the 6-piece page came back 5 of 6, one piece
  set aside. Neither is counted in the table. The site runs on a well-connected host.

## When Meta's API refuses the key (`paper.ts`, `segment.ts` paperFallback, `live-status.ts`)

The hackathon's model credit is "for development over a ten (10) day period". If Meta's API turns the key away, a run
still goes on, and says so:
- **SAM 3.1 is asked first, in every run.** If it refuses, the **paper finder** outlines the pieces: the table's colour
  from the frame's edge, each pixel's CIELAB distance from it split by Otsu's threshold, specks opened away, each blob
  closed on its own and taken as a piece. Our edge snapping then refines every outline at full resolution, as it does
  SAM's. Against SAM 3.1's outlines on the recorded runs (`scripts/eval/paper-finder.ts`): the 54 pieces of the four
  sample photos, 53 at IoU above 0.9 (medians 0.984 to 0.990); all 6 pieces of the real 6-piece tear above 0.95 (plus one
  stray blob). Pieces that touch come out as one blob (the real 10-piece photo: 6 blobs), and a table as light as the
  paper gives no split, so nothing is found.
- **The reads** go to Muse Spark Open when its host answers (a refusal from Meta's API hands each read to the other
  host at once), and the record too.
- **Measured with a refused key** (3 Nov 2026, `scripts/record-run.ts` with an invalid key; the open-weights host was
  refusing as well, so nothing was read): the 1927 letter and the 1922 German letter came back 10 of 10, none
  misplaced, on their edges alone, in 8–12 s; the 6-piece real tear came back in two groups of 3 and 2 pieces, with
  two blobs set aside (the finder had found one stray blob besides the 6 pieces).
- **Each host's refusal is recorded** (`live/paused.json`, `live/open-refused.json`): runs skip a refusing host for
  10 minutes, the first screen says how runs go meanwhile ("open-weights" or "outlines-only" in `/api/health`), and
  the next run SAM 3.1 answers lifts the record. The "Read on open weights only" switch hides while their host refuses.

## Reliability

| Function | Retries | Hedge after | Per-attempt timeout | Deadline |
|---|---|---|---|---|
| SAM pass 1 / tiles | 3 | 7 s | 30 s | (attempts) |
| SAM crop | 3 | 7 s | 30 s | (attempts) |
| verifySeam / chooseContinuation | 4 | 20 s | 45 s | 90 s |
| readPage | 4 | 45 s | 90 s | 150 s |
| translate | 4 | 30 s | 60 s | 120 s |
| sortFragments | 4 | 60 s | 90 s | 150 s |
| catalogPage | 4 | 12 s | 30 s | 60 s |
| transcribeNote (voice) | 1 | – | 30 s | 30 s |

- **Retried:** network errors, timeouts, 429 (with Retry-After), 5xx, empty output, unparseable output, and output cut off by the token budget.
- **In the live pipeline (S7):** seam reads run at low effort, hedged after 9 s, 16 at a time, and the read stage stops
  at 45 s. The hedge goes to the other host: a read Muse Spark hasn't answered in 9 s is also asked of Muse Spark Open,
  and the first good answer wins (`READ_FIRST=meta-only` keeps both lanes on Meta's API).
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
- Voice Transcribe: $0.18 per hour of audio.

Reasoning tokens bill as output.

| Call | Typical cost |
|---|---|
| segmentFragments, auto | **$0.0025** (1 SAM image); crops variant $0.03 for 12 pieces |
| verifySeam, Spark low, v2 | $0.009 (≈200 in, 2,000 out) |
| chooseContinuation, Spark low (k=3) | $0.007 |
| readPage, Spark low, full letter | $0.013 |
| translate, Spark minimal | $0.002 |
| sortFragments, Wonder low, 4 crops | $0.04 |
| catalogPage, Wonder minimal, one page | $0.015 |
| transcribeNote, a one-minute note | $0.003 |

**Example.** A 12-piece demo run is 1 SAM call, about 10 seam checks and one readPage: about $0.10.

## Rerun

```
pnpm tsx scripts/bench/segment-bench.mts t1,sim12,sim12b,stack30 auto,crops,fullres-boxes 1280 [reps]
pnpm tsx scripts/bench/reading-bench.mts cw1 binary muse-spark-1.3 low v2
pnpm tsx scripts/bench/reading-bench.mts cw3 kway muse-wonder-1.0 low
pnpm tsx scripts/bench/shred-bench.mts <dir with data_8/> auto        # RECORD=1 / REPLAY=1 to tune offline
pnpm tsx scripts/live/models-smoke.ts                                  # one real call per function, ~$0.08
pnpm tsx --env-file=.env scripts/eval/catalog.ts muse-spark-1.3,muse-wonder-1.0 1 minimal   # the record eval, ~$0.15
python scripts/gen/tear.py <page> <out> 12 11 [--canvas 4000x3000] [--stack p2 p3]
python scripts/gen/seams.py binary|kway <page> <out> [--win 640x220] [--seam flush]
```

Unit tests (`pnpm test`) make no network calls. They replay recorded SAM 3.1 and Muse answers from `src/lib/server/__fixtures__/`.
