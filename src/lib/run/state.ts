// The screens' view of a run, built by folding RunEvents (live or replayed) through one reducer. Pure.

import { STAGES, type AskOut, type CandidateOut, type ErrorCode, type JoinOut, type PageOut, type PieceOut, type ReadOut, type RunEvent, type RunResult, type RunSource, type Stage, type TranscriptOut, type UnplacedOut, type Warning } from "./types";

export type StageStatus = "pending" | "active" | "done";

export type RunState = {
  status: "idle" | "queued" | "running" | "done" | "error";
  /** Where the events come from: a live stream, or a replay of a stored run. */
  mode: "live" | "replay" | null;
  runId: string | null;
  source: RunSource | null;
  caption: string | null;
  queuePosition: number | null;
  stages: Record<Stage, { status: StageStatus; ms?: number }>;
  photo: { url: string | null; width: number; height: number } | null;
  pieces: PieceOut[];
  candidates: CandidateOut[];
  asks: AskOut[];
  /** Reads in the order they landed. */
  reads: ReadOut[];
  pages: PageOut[];
  joins: JoinOut[];
  unplaced: UnplacedOut[];
  transcripts: TranscriptOut[];
  warnings: Warning[];
  result: RunResult | null;
  error: { code: ErrorCode; message: string } | null;
  /** Run time of the last event (ms from the run's start). */
  t: number;
};

export const initialRunState = (mode: RunState["mode"] = null): RunState => ({
  status: "idle",
  mode,
  runId: null,
  source: null,
  caption: null,
  queuePosition: null,
  stages: Object.fromEntries(STAGES.map((s) => [s, { status: "pending" }])) as RunState["stages"],
  photo: null,
  pieces: [],
  candidates: [],
  asks: [],
  reads: [],
  pages: [],
  joins: [],
  unplaced: [],
  transcripts: [],
  warnings: [],
  result: null,
  error: null,
  t: 0,
});

export type RunAction = RunEvent | { type: "reset"; mode: RunState["mode"] } | { type: "client-error"; code: ErrorCode; message: string };

export function reduceRun(s: RunState, e: RunAction): RunState {
  if (e.type === "reset") return initialRunState(e.mode);
  if (e.type === "client-error") return { ...s, status: "error", error: { code: e.code, message: e.message } };
  const t = Math.max(s.t, e.t);
  switch (e.type) {
    case "queued":
      return { ...s, status: "queued", queuePosition: e.position, t };
    case "start":
      return { ...s, status: "running", queuePosition: null, runId: e.runId, source: e.source, caption: e.caption ?? null, t };
    case "photo":
      return { ...s, photo: { url: e.url, width: e.width, height: e.height }, t };
    case "stage":
      return { ...s, stages: { ...s.stages, [e.stage]: { status: e.status, ms: e.ms } }, t };
    case "segment":
      return { ...s, pieces: e.pieces, t };
    case "match":
      return { ...s, candidates: e.candidates, asks: e.asks, t };
    case "read":
      return { ...s, reads: [...s.reads.filter((r) => r.id !== e.read.id), e.read], t };
    case "assemble":
      return { ...s, pages: e.pages, joins: e.joins, unplaced: e.unplaced, t };
    case "transcribe":
      return { ...s, transcripts: [...s.transcripts.filter((x) => x.page !== e.transcript.page), e.transcript], t };
    case "warning":
      return s.warnings.some((w) => w.code === e.warning.code) ? s : { ...s, warnings: [...s.warnings, e.warning], t };
    case "tick":
      return { ...s, t };
    case "done": {
      const r = e.result;
      return {
        ...s,
        status: "done",
        runId: r.runId,
        source: r.source,
        caption: r.caption ?? s.caption,
        photo: r.photo.url || !s.photo ? r.photo : s.photo,
        pieces: r.pieces,
        candidates: r.candidates,
        asks: r.asks,
        reads: s.reads.length === r.reads.length ? s.reads : r.reads,
        pages: r.pages,
        joins: r.joins,
        unplaced: r.unplaced,
        transcripts: r.transcripts,
        warnings: r.warnings,
        stages: Object.fromEntries(STAGES.map((st) => [st, { status: "done", ms: r.timings[st] }])) as RunState["stages"],
        result: r,
        t,
      };
    }
    case "error":
      return { ...s, status: "error", error: { code: e.code, message: e.message }, t };
  }
}

/** The stage in progress (or the last one done). */
export function currentStage(s: RunState): Stage | null {
  const active = STAGES.find((st) => s.stages[st].status === "active");
  if (active) return active;
  const done = STAGES.filter((st) => s.stages[st].status === "done");
  return done.at(-1) ?? null;
}

/** A placed piece's pose by id. */
export function placedPoses(s: RunState): Map<string, { page: number; pose: PageOut["pieces"][number]["pose"] }> {
  const m = new Map<string, { page: number; pose: PageOut["pieces"][number]["pose"] }>();
  s.pages.forEach((p, k) => p.pieces.forEach((f) => m.set(f.id, { page: k, pose: f.pose })));
  return m;
}
