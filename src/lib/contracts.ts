// The contract between the browser loop and the server. Both sides import these types.
// Change it only additively (new optional fields); a breaking change needs both sides updated in one commit.

/** What a prompt asks SAM 3.1 to track. */
export type Role = "head" | "hands" | "torso" | "cushion" | "other";

/** A prompt for one object, in the chunk's pixel space (origin top-left). */
export type Prompt =
  | { kind: "point"; role: Role; x: number; y: number }
  | { kind: "box"; role: Role; box: Box }
  | { kind: "concept"; role: Role; text: string };

export type Box = [x1: number, y1: number, x2: number, y2: number];

/** SAM's mask for one object in one frame, kept in SAM's own encoding; decode on the client for drawing. */
export type EncodedMask = { x: number; y: number; w: number; h: number; data: string };

export type SamObject = {
  /** SAM's object id within the chunk. */
  id: number;
  /** The role of the prompt this object answers. */
  role: Role;
  box: Box;
  confidence: number | null;
  mask?: EncodedMask;
};

export type FrameResult = {
  chunk: number;
  /** Frame index within the chunk. */
  frame: number;
  /** Capture time of this frame, ms since the session started (chunk t0 + frame / fps). */
  t: number;
  objects: SamObject[];
};

/** Sent with each chunk (as JSON in the `x-push-meta` header; the body is the MP4 bytes). */
export type MeasureRequestMeta = {
  session: string;
  chunk: number;
  /** ms since the session started, for frame 0 of this chunk. */
  t0: number;
  fps: number;
  width: number;
  height: number;
  prompts: Prompt[];
};

/** `/api/measure` streams NDJSON: one MeasureEvent per line. */
export type MeasureEvent =
  | { type: "frame"; data: FrameResult }
  | { type: "done"; chunk: number; frames: number; latencyMs: number; firstFrameMs: number }
  | {
      type: "error";
      chunk: number;
      code: "billing" | "rate_limited" | "upstream" | "timeout" | "bad_request" | "session_cap";
      message: string;
      retryable: boolean;
    };

/** `/api/session` (POST) returns this; the token rides on every chunk. */
export type SessionGrant = {
  session: string;
  maxChunks: number;
  fps: number;
  chunkMs: number;
  width: number;
  height: number;
};

/** The signal engine's input: one sample per frame for the learner's head. */
export type Sample = {
  t: number;
  /** Top edge of the head box (px; larger = lower in the frame). */
  y: number;
  /** Head box height (px), for scale-free amplitudes. */
  h: number;
  /** Head box centre x (px). */
  x: number;
  /** False when SAM lost the learner in this frame. */
  ok: boolean;
};

/** What the live panel shows, recomputed as samples arrive. */
export type LiveMetrics = {
  /** t of the newest sample used (ms since session start). */
  measuredAt: number;
  /** The periodicity gate: compressions are happening. */
  active: boolean;
  /** Compressions per minute over the latest window; null when not active. */
  rate: number | null;
  /** Autocorrelation strength of the latest window, 0..1. */
  strength: number;
  compressions: number;
  /** Coefficient of variation of the last 10 intervals. */
  rhythmCv: number | null;
  /** The current pause, if compressions stopped. */
  pause: { since: number } | null;
  /** Recent compression amplitude ÷ the learner's first 10 (1 = unchanged). A trend, not centimetres. */
  depthTrend: number | null;
  /** How fully the learner comes back up between compressions (1 = full return). */
  recoil: number | null;
};

export type CueKind = "faster" | "slower" | "keep_going" | "let_it_up" | "push_harder" | "lock_elbows" | "good";

export type Cue = { kind: CueKind; text: string; at: number };

export type PauseEvent = { start: number; end: number };

export type SessionSummary = {
  durationMs: number;
  compressions: number;
  averageRate: number | null;
  /** Share of active time with the rate in 100–120/min. */
  inRangeShare: number | null;
  longestPauseMs: number;
  pauses: PauseEvent[];
  rhythmCv: number | null;
  depthTrend: number | null;
  recoil: number | null;
  /** Per-second series for the results card and the debrief. */
  timeline: { t: number; rate: number | null; active: boolean }[];
  cues: Cue[];
};
