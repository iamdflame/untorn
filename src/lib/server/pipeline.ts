// The live pipeline behind `POST /api/runs`, `scripts/record-run.ts` and the hourly health run:
//   photo → SAM 3.1 outlines (segment) → torn-edge matching (match) → Muse Spark reads across candidate seams (read)
//   → two-clue assembly (assemble) → Muse transcribes each rebuilt page (transcribe) → done.
// Every stage emits a RunEvent the moment it happens; the same events, with their timing, end up in the RunResult's
// timeline so any run can be replayed. Model calls are injected (tests mock them); S2's client does the retries.

import sharp from "sharp";
import { finish, prepare, contentRequests, askAll, type Prepared } from "@/lib/rejoin/solve";
import { fragmentsFromSegments } from "@/lib/rejoin/adapters";
import { renderPage } from "@/lib/rejoin/render";
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
import { simplifyClosed } from "./mask-geometry";
import type { chooseContinuation, MuseOutcome, readPage, translate, verifySeam } from "./muse";
import type { SegmentResult } from "./segment";
import { sharpness } from "./intake";

export type PipelineDeps = {
  segment: (jpeg: Uint8Array, opts: { signal?: AbortSignal }) => Promise<Pick<SegmentResult, "fragments" | "costUsd" | "samCalls">>;
  verifySeam: typeof verifySeam;
  chooseContinuation: typeof chooseContinuation;
  readPage: typeof readPage;
  translate: typeof translate;
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
  /** Start a duplicate Muse request when a seam read hasn't answered after this long (median 7–9 s, p90 ~13 s). */
  readHedgeMs?: number;
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
const PAGE_MARGIN = 8;

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
  const warn = (code: WarningCode) => {
    if (warnings.some((w) => w.code === code)) return;
    const w = { code, message: WARNINGS[code] };
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
  const prep: Prepared = prepare(inputs, { maxPairChecks: opts.maxPairChecks ?? Math.min(40, 3 * inputs.length) });
  const textOf = new Map(prep.fragments.map((f) => [f.id, !!f.text && f.text.confidence >= 0.3] as const));
  for (const p of pieces) p.text = textOf.get(p.id) ?? false;
  const blank = pieces.filter((p) => !p.text).length;
  if (blank === pieces.length) warn("no-text");
  else if (blank > 0) warn("some-blank");
  const reqs = contentRequests(prep);
  const asks: AskOut[] = reqs.map((r) => askOut(r, prep));
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
  const deadline = setTimeout(() => {
    deadlineHit = true;
    readAbort.abort(new Error("read deadline"));
  }, opts.readDeadlineMs ?? 70_000);
  const check = async (req: ContentRequest): Promise<ContentVerdict | null> => {
    if (readAbort.signal.aborted) return null;
    const started = now();
    const jpeg = await encodeJpeg(req.render(), SEAM_JPEG_QUALITY);
    const image = { data: jpeg, mime: "image/jpeg" as const };
    const rotated = req.uprightKnown ? undefined : { data: await rotate180Jpeg(jpeg), mime: "image/jpeg" as const };
    // the deadline may have passed while the image was encoded: don't start a call that is already cancelled
    if (readAbort.signal.aborted) return null;
    const callOpts = { rotated, signal: readAbort.signal, onLog: quietLog, hedgeAfterMs: opts.readHedgeMs ?? 12_000 };
    const base = { id: req.id, image: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` };
    let read: ReadOut;
    let verdict: ContentVerdict | null = null;
    if (req.kind === "pair") {
      const out = await deps.verifySeam(image, callOpts);
      museCost(out);
      read = { ...base, kind: "pair", pieces: [req.a, req.b], candidates: [req.candidate], ok: out.ok, same: null, choice: null, confidence: 0, words: [], reason: "", ms: now() - started };
      if (out.ok) {
        const v = out.value;
        Object.assign(read, { same: v.same_place, confidence: round3(v.confidence), words: v.words_across, reason: v.reason });
        verdict = { kind: "pair", id: req.id, same: v.same_place, confidence: v.confidence, reason: v.reason, wordsAcross: v.words_across };
      } else read.error = out.error.code;
    } else {
      const out = await deps.chooseContinuation(image, req.candidates.length, callOpts);
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
  let verdicts: (ContentVerdict | null)[];
  try {
    verdicts = await askAll(reqs, check, opts.concurrency ?? 16);
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
  const joins = res.joins.map((j) => joinOut(j, reqs, verdicts));
  const pages: PageOut[] = [];
  const pageJpegs = new Map<string, Uint8Array>();
  await Promise.all(
    res.pages.map(async (p, k) => {
      const img = renderPage(p, prep.byId, { margin: PAGE_MARGIN });
      const raw = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } });
      const [png, jpeg] = await Promise.all([
        raw.clone().png({ compressionLevel: 6 }).toBuffer(),
        raw.clone().flatten({ background: "#ffffff" }).resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(),
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
      const out = await deps.readPage({ data: jpeg, mime: "image/jpeg" }, { signal, onLog: quietLog, hedgeAfterMs: 25_000 });
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
