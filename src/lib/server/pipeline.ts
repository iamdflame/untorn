// The live pipeline behind `POST /api/runs`, `scripts/record-run.ts` and the hourly health run:
//   photo → SAM 3.1 outlines (segment) → torn-edge matching (match) → Muse Spark reads across candidate seams (read)
//   → two-clue assembly (assemble) → Muse transcribes each rebuilt page (transcribe) → done.
// Every stage emits a RunEvent the moment it happens; the same events, with their timing, end up in the RunResult's
// timeline so any run can be replayed. Model calls are injected (tests mock them); S2's client does the retries.

import sharp from "sharp";
import { finish, prepare, questionPlan, askAll, type Prepared } from "@/lib/rejoin/solve";
import type { TwinStrategy } from "@/lib/rejoin/plan";
import { fragmentsFromSegments } from "@/lib/rejoin/adapters";
import { renderPage } from "@/lib/rejoin/render";
import { poseCompose } from "@/lib/rejoin/geom";
import { renderedInk } from "@/lib/rejoin/seam";
import type { ContentRequest, ContentVerdict, Rgba, SolveResult } from "@/lib/rejoin/types";
import { RunError } from "@/lib/run/errors";
import { WARNINGS } from "@/lib/run/errors";
import {
  MAX_PIECES,
  type AskOut,
  type CandidateOut,
  type JoinOut,
  type PageOut,
  type PieceOut,
  type ReadOut,
  type RunEvent,
  type RunResult,
  type RunSource,
  type Stage,
  type TimelineEntry,
  type TranscriptOut,
  type Warning,
  type WarningCode,
} from "@/lib/run/types";
import { decodePhoto, resizeJpeg, rotate180Jpeg, type DecodedPhoto } from "./images";
import { simplifyClosed, touchingPairs } from "./mask-geometry";
import type { chooseContinuation, MuseOutcome, pageOrientation, readPage, translate, verifySeam } from "./muse";
import { DEFAULT_PROMPT, type SeamPromptVersion } from "./prompts";
import type { SegmentResult } from "./segment";
import { sharpness } from "./intake";

export type PipelineDeps = {
  segment: (jpeg: Uint8Array, opts: { signal?: AbortSignal }) => Promise<Pick<SegmentResult, "fragments" | "costUsd" | "samCalls">>;
  verifySeam: typeof verifySeam;
  chooseContinuation: typeof chooseContinuation;
  readPage: typeof readPage;
  translate: typeof translate;
  /** Is a rebuilt page upright? Asked only for pages whose up/down the solver could not settle (optional). */
  pageOrientation?: typeof pageOrientation;
  /** Store a run file and return the URL the browser loads it from. */
  putAsset: (name: string, bytes: Uint8Array, contentType: string) => Promise<string | null>;
  now?: () => number;
};

export type PipelineOptions = {
  runId: string;
  source: RunSource;
  sample?: string;
  caption?: string;
  signal?: AbortSignal;
  /** Parallel Muse seam reads. */
  concurrency?: number;
  /** Stop asking Muse after this long and assemble with the answers in hand (unread seams rest on shape). */
  readDeadlineMs?: number;
  /** Most pair checks to ask; default 3 per piece, at most 40. */
  maxPairChecks?: number;
  /** Stack tears: read every twin seam ("all") or along a spanning tree of slots ("tree", fewer reads). */
  twinStrategy?: TwinStrategy;
  /** k-way sheets: candidates on their own under the left piece ("stacked"), or each joined to it ("joined"). */
  choiceSheet?: "stacked" | "joined";
  /** k-way sheet strip size (px): 640 x 280 shows more lines across the tear than the pair image's 420 x 150. */
  sheetWindow?: [number, number];
  /**
   * Start a duplicate Muse request when a seam read hasn't answered after this long. At minimal effort a read takes
   * 7 s median, 10–12 s p90 on the real tear (S7); at low effort it took 14 s, p90 26 s.
   */
  readHedgeMs?: number;
  /** Reasoning effort of the pair reads (k-way sheets keep the model's default, low). */
  readEffort?: "minimal" | "low";
  /** Experiments: the pair reads' wording (default: prompts.ts DEFAULT_PROMPT) and the text-line evidence a join on
   *  its shape alone needs (default 0; -Infinity is the solver's own default). */
  seamPrompt?: SeamPromptVersion;
  minLinesLogLR?: number;
  /** Transcription: reasoning effort and the page image's long side (px). */
  transcribeEffort?: "minimal" | "low";
  transcribeLongSide?: number;
  /** Translate transcripts that are not in this language. */
  translateTo?: string;
  /** Most pages to transcribe. */
  maxPagesRead?: number;
  /** Below this sharpness (intake.ts), warn that the photo looks blurred. */
  blurThreshold?: number;
  /** Updated with the model spend as it happens (so a failed run's cost is still counted). */
  meter?: { usd: number };
};

const SEAM_JPEG_QUALITY = 90;
/** Text lines closer than this (photo px) mean a small or distant photo: its torn edges are coarse. */
const SMALL_PITCH = 60;
/** Fewest type pixels a question needs to be worth a read: a pair image, each candidate of a k-way sheet, and the
 *  sheet's left piece (a few words). Measured on the stack sample: these keep 45 of 65 sheets and lift Muse's picks
 *  from 46/60 to 34/40 right. */
const MIN_INK = 300;
const MIN_ANCHOR_INK = 800;
/** The read strategy for live runs: on the real stack sample "tree" placed the same 18 of 24 with 0 misplaced as "all",
 *  with 22 reads instead of 46 ($0.32 against $0.60), so a stack fits the read deadline (S6b). */
export const DEFAULT_TWIN_STRATEGY: TwinStrategy = "tree";
/** The k-way sheet layout for live runs (S6b measured both on the real stack sample). */
export const DEFAULT_CHOICE_SHEET: "stacked" | "joined" = "stacked";
export const DEFAULT_SHEET_WINDOW: [number, number] = [640, 280];
/**
 * Read stage speed (S7, the real tear). Minimal effort was as right as low on a test of 15 seams (10, 11, 11 against
 * 11, 9) at half the latency, but live it said "same" to the chance fit p5–p8 in two runs of three (low effort reads
 * it "not the same"): the reads stay at low effort. Hedged after 9 s; up to 16 questions at once (at 24, with hedges
 * about 40 connections, most requests failed to connect within 10 s). A read still out after the deadline is dropped
 * and its seam rests on shape.
 */
export const DEFAULT_READ_EFFORT = "low" as const;
export const DEFAULT_READ_HEDGE_MS = 9_000;
export const DEFAULT_READ_CONCURRENCY = 16;
export const DEFAULT_READ_DEADLINE_MS = 30_000;
/**
 * Transcription (S7, two rebuilt pages of the real tear): minimal effort on a 1600 px page read with 6.7–8.0% character
 * errors in 7–11 s, against 7.5% in 18–21 s at low effort on 2200 px.
 */
export const DEFAULT_TRANSCRIBE_EFFORT = "minimal" as const;
export const DEFAULT_TRANSCRIBE_LONG_SIDE = 1600;
const PAGE_MARGIN = 8;
/** Long side of the rebuilt page's image (px): the download and the transcription's source. */
const PAGE_LONG_SIDE = 3000;

/** Run the whole pipeline on one photo. Emits events as it goes; returns the stored result. Throws RunError. */
export async function runPipeline(photoBytes: Uint8Array, deps: PipelineDeps, opts: PipelineOptions, emit: (e: RunEvent) => void): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const timeline: TimelineEntry[] = [];
  const warnings: Warning[] = [];
  const timings: RunResult["timings"] = { total: 0 };
  const cost = { usd: 0, samCalls: 0, museCalls: 0 };
  const signal = opts.signal;

  const send = (e: DistributiveOmit<RunEvent, "t">) => {
    const ev = { ...e, t: now() - t0 } as RunEvent;
    timeline.push({ t: ev.t, type: ev.type, id: timelineId(ev) });
    emit(ev);
  };
  const warn = (code: WarningCode, message?: string) => {
    if (warnings.some((w) => w.code === code)) return;
    const w = { code, message: message ?? WARNINGS[code] };
    warnings.push(w);
    send({ type: "warning", warning: w });
  };
  const stageStart = new Map<Stage, number>();
  const stage = (s: Stage, status: "active" | "done") => {
    if (status === "active") {
      stageStart.set(s, now());
      send({ type: "stage", stage: s, status });
    } else {
      const ms = now() - (stageStart.get(s) ?? now());
      timings[s] = ms;
      send({ type: "stage", stage: s, status, ms });
    }
  };
  const spend = (usd: number) => {
    cost.usd += usd;
    if (opts.meter) opts.meter.usd += usd;
  };
  const museCost = (o: MuseOutcome<unknown>) => {
    spend(o.meta.costUsd);
    cost.museCalls += 1;
  };
  const checkAbort = () => {
    if (signal?.aborted) throw new RunError("timeout", "The run was stopped.");
  };

  send({ type: "start", runId: opts.runId, source: opts.source, caption: opts.caption });

  // ── decode, keep a display copy, check sharpness ─────────────────────────────────────────────────────────
  let photo: DecodedPhoto;
  try {
    photo = await decodePhoto(photoBytes);
  } catch {
    throw new RunError("unreadable");
  }
  const photoInfo: RunResult["photo"] = { url: null, width: photo.width, height: photo.height };
  const displayPhoto = resizeJpeg(photo.rgb, 2000, 84)
    .then((d) => deps.putAsset("photo.jpg", d.jpeg, "image/jpeg"))
    .then((url) => {
      photoInfo.url = url;
      send({ type: "photo", url, width: photo.width, height: photo.height });
    })
    .catch(() => send({ type: "photo", url: null, width: photo.width, height: photo.height }));
  if (Math.max(photo.width, photo.height) < 1600) warn("small-photo");
  const blur = sharpness(photo.rgb)
    .then((v) => {
      if (v < (opts.blurThreshold ?? 30)) warn("blurry");
    })
    .catch(() => {});

  // ── segment: SAM 3.1 outlines every piece ─────────────────────────────────────────────────────────────────
  stage("segment", "active");
  let seg: Awaited<ReturnType<PipelineDeps["segment"]>>;
  try {
    seg = await deps.segment(photo.jpeg, { signal });
  } catch (e) {
    checkAbort();
    throw new RunError("model-error", `SAM 3.1 didn't answer: ${short(e)}`);
  }
  spend(seg.costUsd);
  cost.samCalls += seg.samCalls;
  if (!seg.fragments.length) throw new RunError("no-pieces");
  if (seg.fragments.length > MAX_PIECES) throw new RunError("too-many");
  if (seg.fragments.length > 60) warn("many-pieces");
  // pieces laid against or on one another: where they meet, SAM has to guess the boundary and the torn edges are lost
  // (on the real torn page the pieces touching the middle one were the ones left out)
  const touching = new Set(touchingPairs(seg.fragments.map((f) => f.mask)).flat());
  if (touching.size)
    warn("overlap", `${touching.size} pieces touch or lie on one another; where they meet, their torn edges can't be seen whole. Spread them apart and take another photo: more pieces will join.`);
  const pieces: PieceOut[] = seg.fragments.map((f) => ({
    id: pieceId(f.id),
    polygon: simplifyClosed(f.polygon, 1.2).map(([x, y]) => [round1(x), round1(y)] as [number, number]),
    box: f.box,
    area: Math.round(f.area),
    confidence: f.confidence === null ? null : round3(f.confidence),
    text: true,
  }));
  send({ type: "segment", pieces });
  stage("segment", "done");
  await blur;
  checkAbort();

  // ── match: geometry proposes joins where torn edges fit ───────────────────────────────────────────────────
  stage("match", "active");
  const rgba = rgbToRgba(photo.rgb);
  const inputs = fragmentsFromSegments(rgba, seg.fragments.map((f) => ({ id: pieceId(f.id), mask: f.mask })));
  const strategy = opts.twinStrategy ?? DEFAULT_TWIN_STRATEGY;
  const sheet = opts.choiceSheet ?? DEFAULT_CHOICE_SHEET;
  const win = opts.sheetWindow ?? DEFAULT_SHEET_WINDOW;
  const sheetArea = (win[0] * win[1]) / (420 * 150);
  // reads are always asked here, so a join on its shape alone also needs the pieces' text lines not to disagree
  // (minLinesLogLR 0): on the real photo a chance fit with lines 5° apart took a page apart; a read still confirms such
  // a join. The tear line is drawn thin, so the letters it cuts stay readable (seam v3).
  const prep: Prepared = prepare(inputs, {
    maxPairChecks: opts.maxPairChecks ?? Math.min(40, 3 * inputs.length),
    twinStrategy: strategy,
    assemble: { minLinesLogLR: opts.minLinesLogLR ?? 0 },
    render: { joined: sheet === "joined", sheetWidth: win[0], sheetHeight: win[1], seamLine: (opts.seamPrompt ?? DEFAULT_PROMPT.seam) === "v3" ? "thin" : true },
  });
  // the writing's size says how much edge detail the photo holds: on the real torn page, text lines 98 px apart placed
  // 9 of 10 pieces, the same photo at 44 px placed 5 (2 of them wrongly)
  if (prep.pitch && prep.pitch < SMALL_PITCH)
    warn("small-photo", `The writing is small in this photo (text lines ${Math.round(prep.pitch)} px apart), so the torn edges are coarse. Move closer, or send the full-size original: more pieces will join.`);
  const textOf = new Map(prep.fragments.map((f) => [f.id, !!f.text && f.text.confidence >= 0.3] as const));
  for (const p of pieces) p.text = textOf.get(p.id) ?? false;
  const blank = pieces.filter((p) => !p.text).length;
  if (blank === pieces.length) warn("no-text");
  else if (blank > 0) warn("some-blank");
  const plan = questionPlan(prep);
  const asks: AskOut[] = plan.first.map((r) => askOut(r, prep));
  const candidates: CandidateOut[] = [...prep.match.candidates]
    .sort((x, y) => y.score - x.score)
    .slice(0, 150)
    .map((c) => ({ id: c.id, a: c.a, b: c.b, score: round1(c.score), confidence: round3(c.confidence), margin: round3(Number.isFinite(c.margin) ? c.margin : 99), rms: round3(c.rms), twinGroup: c.twinGroup }));
  send({ type: "match", candidates, asks });
  stage("match", "done");
  checkAbort();

  // ── read: Muse Spark reads across each seam that matters ─────────────────────────────────────────────────
  stage("read", "active");
  const reads: ReadOut[] = [];
  const readAbort = new AbortController();
  const onOuterAbort = () => readAbort.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  let deadlineHit = false;
  let skipped = 0;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    readAbort.abort(new Error("read deadline"));
  }, opts.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS);
  const check = async (req: ContentRequest): Promise<ContentVerdict | null> => {
    if (readAbort.signal.aborted) return null;
    const started = now();
    const img = req.render();
    // a question with almost no type is a guess, not a read: skip it (the seam then rests on shape, or on other reads)
    const ink = req.kind === "choice" ? renderedInk(img, req.candidates.length + 1, win[1]) : renderedInk(img, 1);
    // a k-way sheet needs type on the left piece and on every candidate: shown one scrap with words and two blank ones,
    // Muse picks the one with words, even when the true continuation is the blank margin
    const blankQuestion = req.kind === "choice" ? ink[0] < MIN_ANCHOR_INK * sheetArea || Math.min(...ink.slice(1)) < MIN_INK * sheetArea : ink[0] < MIN_INK;
    if (blankQuestion) {
      skipped++;
      return null;
    }
    const jpeg = await encodeJpeg(img, SEAM_JPEG_QUALITY);
    const image = { data: jpeg, mime: "image/jpeg" as const };
    const rotated = req.uprightKnown ? undefined : { data: await rotate180Jpeg(jpeg), mime: "image/jpeg" as const };
    // the deadline may have passed while the image was encoded: don't start a call that is already cancelled
    if (readAbort.signal.aborted) return null;
    const callOpts = { rotated, signal: readAbort.signal, onLog: quietLog, hedgeAfterMs: opts.readHedgeMs ?? DEFAULT_READ_HEDGE_MS };
    const base = { id: req.id, image: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` };
    let read: ReadOut;
    let verdict: ContentVerdict | null = null;
    if (req.kind === "pair") {
      const out = await deps.verifySeam(image, { ...callOpts, effort: opts.readEffort ?? DEFAULT_READ_EFFORT, prompt: opts.seamPrompt });
      museCost(out);
      read = { ...base, kind: "pair", pieces: [req.a, req.b], candidates: [req.candidate], ok: out.ok, same: null, choice: null, confidence: 0, words: [], reason: "", ms: now() - started };
      if (out.ok) {
        const v = out.value;
        // no letter crosses the tear (seam v3): the read is no clue either way, and the join rests on its shape and lines
        const same = v.text_crosses === false ? null : v.same_place;
        const confidence = v.text_crosses === false ? Math.min(0.5, v.confidence) : v.confidence;
        Object.assign(read, { same, confidence: round3(confidence), words: v.words_across, reason: v.reason });
        verdict = { kind: "pair", id: req.id, same, confidence, reason: v.reason, wordsAcross: v.words_across };
      } else read.error = out.error.code;
    } else {
      const out = await deps.chooseContinuation(image, req.candidates.length, sheet === "joined" ? { ...callOpts, prompt: "joined" } : callOpts);
      museCost(out);
      const partners = req.candidates.map((id) => partnerOf(prep, id, req.anchor));
      read = { ...base, kind: "choice", pieces: [req.anchor, ...partners], candidates: req.candidates, ok: out.ok, same: null, choice: null, confidence: 0, words: [], reason: "", ms: now() - started };
      if (out.ok) {
        const v = out.value;
        const index = Number.isInteger(v.index) ? v.index : v.choice ? v.choice.toUpperCase().charCodeAt(0) - 65 : -1;
        const choice = index >= 0 && index < req.candidates.length ? index : null;
        Object.assign(read, { choice, confidence: round3(v.confidence), words: v.words_across, reason: v.reason });
        verdict = { kind: "choice", id: req.id, choice, confidence: v.confidence, reason: v.reason, wordsAcross: v.words_across };
      } else read.error = out.error.code;
    }
    if (readAbort.signal.aborted && !read.ok) return null; // stopped by the deadline: not a model failure
    reads.push(read);
    send({ type: "read", read });
    return verdict;
  };
  // ask round by round: "all" has one round; "tree" re-reads only where reads disagree (rejoin/plan.ts)
  const reqs: ContentRequest[] = [];
  const verdicts: (ContentVerdict | null)[] = [];
  const answers = new Map<string, ContentVerdict | null>();
  let rounds = 0;
  try {
    let round = plan.first;
    while (round.length && !readAbort.signal.aborted && rounds < 12) {
      if (rounds > 0) {
        asks.push(...round.map((r) => askOut(r, prep)));
        send({ type: "match", candidates, asks: [...asks] });
      }
      const vs = await askAll(round, check, opts.concurrency ?? DEFAULT_READ_CONCURRENCY);
      round.forEach((r, i) => {
        reqs.push(r);
        verdicts.push(vs[i]);
        answers.set(r.id, vs[i]);
      });
      rounds++;
      round = plan.next(answers);
    }
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onOuterAbort);
  }
  checkAbort();
  if (deadlineHit) warn("slow-reading");
  if (reads.some((r) => !r.ok)) warn("reading-failed");
  stage("read", "done");

  // ── assemble: two-clue joins, pages, renders ─────────────────────────────────────────────────────────────
  stage("assemble", "active");
  const res: SolveResult = finish(prep, reqs, verdicts);
  // Up or down: the solver's ascender vote settles most pages; where it could not (flipKnown false), a quick look by
  // Muse at a small render decides, and the page is turned a half turn before it is drawn and transcribed.
  if (deps.pageOrientation) {
    await Promise.all(
      res.pages.map(async (p, k) => {
        if (p.upright.flipKnown || p.upright.by === "none") return;
        const small = renderPage(p, prep.photo, { margin: PAGE_MARGIN, scale: Math.min(1, 1200 / Math.max(p.width, p.height)) });
        const jpeg = await encodeJpeg(small, 85);
        const out = await deps.pageOrientation!({ data: jpeg, mime: "image/jpeg" }, { signal, onLog: quietLog });
        museCost(out);
        if (!out.ok || out.value.upright || out.value.confidence < 0.7) return;
        // a half turn about the page centre: (x, y) → (W − x, H − y)
        const turn = { theta: Math.PI, tx: p.width, ty: p.height };
        res.pages[k] = { ...p, upright: { by: p.upright.by, flipKnown: true }, fragments: p.fragments.map((f) => ({ ...f, pose: poseCompose(turn, f.pose) })) };
      }),
    );
  }
  const joins = res.joins.map((j) => joinOut(j, reqs, verdicts));
  const transcribeSide = opts.transcribeLongSide ?? DEFAULT_TRANSCRIBE_LONG_SIDE;
  const pages: PageOut[] = [];
  const pageJpegs = new Map<string, Uint8Array>();
  await Promise.all(
    res.pages.map(async (p, k) => {
      // the download needs no more than 3000 px a side, and half the pixels render in half the time (S7: 2.2 s → 1 s)
      const img = renderPage(p, prep.photo, { margin: PAGE_MARGIN, scale: Math.min(1, PAGE_LONG_SIDE / (Math.max(p.width, p.height) + 2 * PAGE_MARGIN)) });
      const raw = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } });
      const [png, jpeg] = await Promise.all([
        raw.clone().png({ compressionLevel: 3 }).toBuffer(),
        raw
          .clone()
          .flatten({ background: "#ffffff" })
          .resize({ width: transcribeSide, height: transcribeSide, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer(),
      ]);
      pageJpegs.set(p.id, new Uint8Array(jpeg));
      const url = await deps.putAsset(`page-${k}.png`, new Uint8Array(png), "image/png").catch(() => null);
      pages[k] = {
        id: p.id,
        width: round1(p.width),
        height: round1(p.height),
        margin: PAGE_MARGIN,
        confidence: round3(p.confidence),
        completeness: round3(p.completeness),
        pieces: p.fragments.map((f) => ({ id: f.id, pose: { theta: round6(f.pose.theta), tx: round1(f.pose.tx), ty: round1(f.pose.ty) } })),
        image: url,
      };
    }),
  );
  const unplaced = res.unplaced.map((u) => ({ id: u.id, reason: u.reason }));
  send({ type: "assemble", pages, joins, unplaced });
  if (unplaced.length) warn("partial");
  stage("assemble", "done");
  checkAbort();

  // ── transcribe: Muse reads each rebuilt page; gaps stay gaps ─────────────────────────────────────────────
  stage("transcribe", "active");
  const transcripts: TranscriptOut[] = [];
  const toRead = [...pages].sort((x, y) => y.pieces.length - x.pieces.length).slice(0, opts.maxPagesRead ?? 4);
  const to = opts.translateTo ?? "en";
  await Promise.all(
    toRead.map(async (p) => {
      const jpeg = pageJpegs.get(p.id)!;
      const out = await deps.readPage({ data: jpeg, mime: "image/jpeg" }, { signal, onLog: quietLog, effort: opts.transcribeEffort ?? DEFAULT_TRANSCRIBE_EFFORT, hedgeAfterMs: 15_000 });
      museCost(out);
      let tr: TranscriptOut;
      if (!out.ok) tr = { page: p.id, ok: false, text: "", language: "und", uncertain: [], translation: null, error: out.error.code };
      else {
        const v = out.value;
        tr = { page: p.id, ok: true, text: v.text, language: v.language, uncertain: v.uncertain, translation: null };
        if (v.text.trim() && !sameLanguage(v.language, to)) {
          const t = await deps.translate(v.text, to, { signal, onLog: quietLog });
          museCost(t);
          if (t.ok) tr.translation = { to, text: t.value.text };
        }
      }
      transcripts.push(tr);
      send({ type: "transcribe", transcript: tr });
    }),
  );
  stage("transcribe", "done");
  await displayPhoto;

  timings.total = now() - t0;
  const result: RunResult = {
    version: 1,
    runId: opts.runId,
    createdAt: new Date(t0).toISOString(),
    source: opts.source,
    sample: opts.sample,
    caption: opts.caption,
    photo: photoInfo,
    pieces,
    candidates,
    asks,
    reads,
    joins,
    pages,
    unplaced,
    transcripts: pages.map((p) => transcripts.find((t) => t.page === p.id)).filter((t): t is TranscriptOut => !!t),
    warnings,
    timings,
    cost: { ...cost, usd: Math.round(cost.usd * 10000) / 10000 },
    stats: {
      twinStrategy: strategy,
      choiceSheet: sheet,
      sheetWindow: win,
      readRounds: rounds,
      twinGroups: prep.match.twinGroups.length,
      twinClasses: new Set([...prep.match.twinClass.values()]).size,
      pairReads: reads.filter((r) => r.kind === "pair").length,
      choiceReads: reads.filter((r) => r.kind === "choice").length,
      skippedBlank: skipped,
    },
    timeline,
  };
  // the done event is the last timeline entry; the result is stored with it
  timeline.push({ t: now() - t0, type: "done" });
  await deps.putAsset("result.json", new TextEncoder().encode(JSON.stringify(result)), "application/json").catch(() => null);
  emit({ type: "done", t: now() - t0, result });
  return result;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

const pieceId = (n: number) => `p${n}`;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
const sameLanguage = (lang: string, to: string) => lang.toLowerCase().startsWith(to.toLowerCase()) || lang === "und";

/** Only failed attempts are worth a log line in production. */
const quietLog = (entry: { outcome: string; fn: string; attempt: number; error?: string; status: number | null; ms: number }) => {
  if (entry.outcome !== "ok") console.warn(`[muse] ${entry.fn} attempt ${entry.attempt} ${entry.outcome} ${entry.error ?? ""} ${entry.status ?? ""} ${entry.ms}ms`);
};

function timelineId(e: RunEvent): string | undefined {
  switch (e.type) {
    case "stage":
      return `${e.stage}:${e.status}`;
    case "read":
      return e.read.id;
    case "transcribe":
      return e.transcript.page;
    case "warning":
      return e.warning.code;
    default:
      return undefined;
  }
}

function rgbToRgba(rgb: { width: number; height: number; data: Uint8Array }): Rgba {
  const n = rgb.width * rgb.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
    out[k] = rgb.data[j];
    out[k + 1] = rgb.data[j + 1];
    out[k + 2] = rgb.data[j + 2];
    out[k + 3] = 255;
  }
  return { width: rgb.width, height: rgb.height, data: out };
}

async function encodeJpeg(img: Rgba, quality: number): Promise<Uint8Array> {
  const buf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(buf);
}

function partnerOf(prep: Prepared, candidateId: string, anchor: string): string {
  const c = prep.match.candidates.find((x) => x.id === candidateId);
  if (!c) return "";
  return c.a === anchor ? c.b : c.a;
}

function askOut(r: ContentRequest, prep: Prepared): AskOut {
  if (r.kind === "pair") return { id: r.id, kind: "pair", candidate: r.candidate, a: r.a, b: r.b };
  return { id: r.id, kind: "choice", anchor: r.anchor, candidates: r.candidates, pieces: r.candidates.map((id) => partnerOf(prep, id, r.anchor)) };
}

/** A join with both clues: the shape fit, and what Muse read across it (the most confident question that covered it). */
function joinOut(j: SolveResult["joins"][number], reqs: ContentRequest[], verdicts: (ContentVerdict | null)[]): JoinOut {
  let read: JoinOut["read"] = null;
  reqs.forEach((r, i) => {
    const v = verdicts[i];
    if (!v) return;
    let agrees: boolean | null = null;
    if (r.kind === "pair" && v.kind === "pair" && r.candidate === j.candidate && v.same !== null) agrees = v.same;
    if (r.kind === "choice" && v.kind === "choice" && r.candidates.includes(j.candidate) && v.choice !== null) agrees = r.candidates[v.choice] === j.candidate;
    if (agrees === null) return;
    // the solver weighs a verdict by logit(max(0.5, confidence)): at 0.5 or below it carries nothing
    const decisive = v.confidence > 0.5;
    if (!read || v.confidence > read.confidence) read = { id: r.id, agrees: decisive ? agrees : null, confidence: round3(v.confidence), words: v.wordsAcross ?? [], reason: v.reason ?? "" };
  });
  return {
    candidate: j.candidate,
    a: j.a,
    b: j.b,
    page: j.page,
    decidedBy: j.decidedBy,
    confidence: round3(j.confidence),
    loop: j.loop,
    shape: { score: round1(j.geometry.score), confidence: round3(j.geometry.confidence), rms: round3(j.geometry.rms), overlap: round1(j.geometry.overlap) },
    read,
  };
}
