# ShredBench

[ShredBench](https://github.com/ythere-y/ShredBench) (Findings of ACL 2026, Apache-2.0) is the published benchmark for
reading a document that has been cut into pieces. A page is cut into 8, 12 or 16 Voronoi cells. The cells are rendered
scattered in Blender, with curl and shadows, and a multimodal model must output the document's text. The score is the
normalised edit distance (NED) to the ground truth, so lower is better. Their best model, Gemini 3 Pro, scores
0.33 / 0.37 / 0.41 at 8 / 12 / 16 fragments, averaged over all domains.

Untorn does not ask a model to imagine the page. It rebuilds the page:
1. SAM 3.1 cuts out every piece.
2. A straight-edge solver proposes the joins.
3. Muse Spark reads across the seams that geometry cannot settle.
4. Muse reads the rebuilt page.

## Results (8 pieces, ShredBench's NED)

| set | n | **Untorn** | geometry only (no seam reads) | Muse Spark alone (scattered photo, ShredBench's prompt) |
|---|---|---|---|---|
| ShredBench official images with published ground truth (English news) | 3 | **0.002** | 0.063 | 0.528 |
| Our replica: English news | 16 | **0.005** | 0.001 | 0.406 |
| Our replica: Chinese news | 16 | **0.063** | 0.168 | 0.754 |
| Our replica: code | 16 | **0.007** | 0.019 | 0.147 |
| Our replica: tables | 16 | 0.126 | **0.107** | 0.309 |
| **Our replica: all four domains** | **64** | **0.050** | 0.074 | **0.404** |

ShredBench's published table, for reference. Its models were run on their full 756-document set, averaged over all
domains. These are not the same images as ours:

| model | 8 fragments | 12 fragments | 16 fragments |
|---|---|---|---|
| Gemini 3 Pro | 0.33 | 0.37 | 0.41 |
| Gemini 3 Flash | 0.34 | 0.40 | 0.44 |
| GPT-5 Mini | 0.58 | 0.65 | 0.73 |
| GPT-5.1 | 0.77 | 0.81 | 0.82 |

Other numbers (8 pieces, replica):
- **Pieces found by SAM 3.1:** 512/512, and 88/88 on the 11 official renders.
- **Pieces placed correctly against the true poses:** 87.5% (448/512). Geometry alone places 75.2%. Two pieces in two
  table samples were placed wrongly.
- **Complete pages:** 37/64.
- **Muse seam reads:** 3.1 per sample.
- **Cost:** $0.050 per sample.
- **Latency:** median 53 s per sample, from photo to transcription.

On the official images, news_041 is rebuilt completely. news_008 and news_031 are 7/8, with one loose piece that Muse
reads as a part. No piece is misplaced.

### 12 and 16 pieces (replica only; ShredBench has not published these sets)

At 12 pieces we ran every 2nd test document of each domain (32 documents).

| pieces | n | Untorn | Muse Spark alone | pieces placed correctly | complete pages | seam reads/sample | $/sample |
|---|---|---|---|---|---|---|---|
| 12 | 32 | **0.050** | 0.436 | 87.8% | 18/32 | 6.3 | 0.082 |

By domain at 12 pieces:

| domain | Untorn | Muse alone |
|---|---|---|
| English news | 0.003 | 0.483 |
| Chinese news | 0.012 | 0.766 |
| code | 0.082 | 0.207 |
| tables | 0.104 | 0.289 |

## What is public, and what we measured instead

ShredBench has published 11 renders, all English news and all with 8 pieces, and 10 ground-truth files. Only 3
documents have both (news_008, news_031, news_041). There are no code, table, Chinese or 12/16-piece samples; the full
release is still a TODO in their README. We checked all 21 commits and the authors' Hugging Face dataset, which is
empty.

The NED on official images therefore covers 3 documents. For a broader measurement we built **our re-implementation of
ShredBench's protocol, with 2D compositing and no Blender**:
- **Documents:** 18 per domain, in their markdown formats, with exact ground truth.
  - English news: ShredBench's own 7 unrendered ground-truth files, plus China Daily (their source).
  - Chinese news: People's Daily (their source).
  - Code: Python from CPython, C++ from googletest and fmt, Java from gson; whole files of 1,000–4,000 characters.
  - Tables: arXiv cs.CL tables, converted to plain HTML by our own parser.
- **Splits:** 2 documents per domain are a dev split, fixed in advance and excluded from every number above; 16 per
  domain are the test set.
- **Rendering:** at 1,600 px in Chrome, with their page style.
- **Cutting:** into Voronoi cells assigned at half resolution and upsampled nearest-neighbour, which gives their
  2-pixel steps.
- **Compositing:** the cells are turned at random, packed and composited at 4096 × 4096 on grey, with shadows,
  shading, blur and JPEG.

It has no 3D curl, so its cuts are straighter than Blender's and its page borders do not bulge. That makes geometry
easier on the replica than on the official renders. For a model reading the scattered photo it does not look easier:
Muse alone scores 0.404 on it.

## Method

**Segmentation.** `segmentFragments` (SAM 3.1) uses one concept call at 1,280 px and snaps each mask to the
full-resolution paper edge.

**Straight sides** (`src/lib/rejoin/polygon.ts`):
- The outline is classified by how much it turns over ±32 px, on a smoothed copy:
  - a side barely turns;
  - a corner turns sharply;
  - Blender's bulging page borders keep turning.
- Runs that no line fits are split where they stray furthest from their chord.
- Collinear runs merge across kinks.
- Line tolerances grow with length, because a long cut can bow by a few pixels.
- Corners are found where neighbouring lines cross. A blunted tip counts as a corner while it stays inside the wedge
  of the two lines.

**Side pairs** (`src/lib/rejoin/straight.ts`). Each pair of sides gives up to three hypotheses:
- both corners aligned, with equal lengths;
- one shared corner (a T-junction, or a corner close enough to straight that it reads as one side);
- a free slide along the side.

They are gated and scored as follows:
- **Corner angles:** A + B must be at least 180°, because a Voronoi vertex joins three cells, or two cells and the
  page edge.
- **Text lines:** they must run parallel (within 2°). The rotation is taken from the text lines, which are far more
  precise than a bowed side.
- **Ink across the cut:**
  - it is sampled along the text direction, because sampling across the cut puts slanted lines 2·d·cot φ apart;
  - it is withheld when the cut runs along the lines;
  - it is scored as the Fisher z of the correlation of the two profiles.

**Assembly** (`src/lib/rejoin/tiling.ts`). Joins are accepted best first and need two clues:
- a full match with ink continuity, or
- any geometric match with a confident Muse "same" (confidence ≥ 0.6).

Every accepted join must also pass the page's checks:
- no overlaps;
- loops that close;
- pooled ascender votes against groups turned upside down.

A blank seam is placed only by two agreeing seams that cross. Nothing is forced.

**Reading seams.** Muse `verifySeam` is asked only about the strongest unsettled pairs that would join two groups, in
rounds, at most 2N − 2 times per sample.

**Reading the page.** The rebuilt page is turned upright, by its text or its margins. A page that stays in parts
becomes a sheet of upright parts. Muse `readPage` transcribes it with ShredBench's own Markdown rules; the prompt is
adapted only to say the page is rebuilt and to mark missing text with `[…]`.

**Baseline.** Muse Spark gets the scattered photo, scaled to 2,048 px as their script does, with ShredBench's prompt
verbatim (`scripts/eval/shredbench/baseline.ts`).

**Metric.** Their `metric.py` score, re-implemented exactly (`scripts/eval/shredbench/ned.ts`):
Levenshtein(pred, gt) / max(len), on code points, after Python's universal newlines and `str.strip()`.

## Caveats
- **Three official images.** With ground truth for only 3 of them, the official number is a small sample.
- **Different image sets.** The paper's table averages its full set over domains. Our official subset is English news
  only, and our replica uses our documents and our 2D renderer.
- **A post-hoc fix.** Configuration v1 placed a piece above the page on official news_008. Muse said "same" with
  confidence 0.25 on a wrong join and "no" with 0.25 on the true one, and v1 counted both. In v2 a reading under 0.6
  confidence counts for nothing. Because the problem was found on a test page:
  - v2 was validated on the dev split only;
  - the replica test set was run only with v2;
  - v1's official NED is reported too: 0.012 / 0.001 / 0.001, mean 0.005.
- **"All pieces in one group" is not "correct".** On the official renders, correctness was judged by eye.
- **Reuse in the geometry-only column.** Where its rebuilt page is identical to v2's, v2's reading of that same image
  is reused.

## Failure cases
1. **Official news_008 under v1: a piece set above the page.** This came from a low-confidence "same", and is fixed in
   v2.
2. **Replica table arxiv_005, NED 0.677.** A short table page leaves most pieces blank, with no seam to read. Three
   pieces were assembled upside down, one of them misplaced, and the reading lost most of the table.
3. **Replica Chinese news pd_007, NED 0.275.** 7 of 8 pieces are correct, but the loose piece was shown upside down.
   The ascender vote that sets "up" means nothing for Chinese.

## What would raise the score
- **Orientation for any script:** decide which way up a loose piece or group goes by a Muse read or by the page
  margins.
- **Blank pieces:** fill them into the holes the tiling leaves.
- **Tables:** a seam-reading prompt that checks whether rules and columns continue.
- **Official renders:** piecewise matching of sides bowed by Blender's curl.

## Reproduce

```
pnpm tsx scripts/bench/shredbench/fetch.ts --root DIR          # the official samples, pinned and hash-checked
pnpm tsx scripts/bench/shredbench/docs.ts --root DIR           # replica documents (China Daily, People's Daily, code, arXiv)
pnpm tsx scripts/bench/shredbench/render.ts --root DIR         # pages in the installed Chrome
pnpm tsx scripts/bench/shredbench/shred.ts --root DIR          # 8/12/16 Voronoi cells, composited
pnpm tsx scripts/eval/shredbench.ts segment --root DIR         # SAM 3.1
pnpm tsx scripts/eval/shredbench.ts solve --root DIR --run v2  # straight edges + Muse seam reads
pnpm tsx scripts/eval/shredbench.ts read --root DIR --run v2   # Muse reads the page
pnpm tsx scripts/eval/shredbench.ts baseline --root DIR        # Muse alone
pnpm tsx scripts/eval/shredbench.ts score --root DIR --run v2  # NED, placement, cost, latency → report.md
```

- **Filters:** `--set official|replica`, `--pieces 8`, `--split test`, `--every 2`.
- **Geometry only:** `--max-reads 0` with `--reuse v2`.
- **Spending:** every live call is logged to `DIR/ledger.ndjson`, and `--budget` stops new work past a total.
