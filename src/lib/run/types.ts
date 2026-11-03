// The run contract between the server pipeline (`POST /api/runs`), the stored result (`/r/<runId>`, recorded runs)
// and the screens. Pure types and constants: imported by both the browser and the server.
//
// A live run streams NDJSON, one RunEvent per line, in pipeline order. A finished run is one RunResult (stored as
// result.json); its `timeline` replays the same events with their real timing (see replay.ts).

import type { Pose } from "@/lib/rejoin/geom";

export type { Pose };

/** The true pipeline stages, in order. */
export const STAGES = ["segment", "match", "read", "assemble", "transcribe"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  segment: "Finding pieces",
  match: "Matching edges",
  read: "Reading across tears",
  assemble: "Assembling",
  transcribe: "Reading the page",
};

export type Pt = [number, number];

/** One fragment as SAM 3.1 outlined it, in full-resolution photo pixels. */
export type PieceOut = {
  id: string;
  /** Closed outline (simplified to about 1 px), photo pixels. */
  polygon: Pt[];
  box: [number, number, number, number];
  area: number;
  confidence: number | null;
  /** Text lines found on the piece (false: blank, or the back side). */
  text: boolean;
};

/** A candidate join from torn-edge matching (shape only). */
export type CandidateOut = {
  id: string;
  a: string;
  b: string;
  /** Geometry score (px of well-fitting seam). */
  score: number;
  confidence: number;
  margin: number;
  rms: number;
  /** Set when other pieces fit the same edge equally well (stack-torn twins). */
  twinGroup: string | null;
};

/** One question put to Muse Spark: a seam image (pair) or a sheet of k candidates for one edge (choice). */
export type AskOut =
  | { id: string; kind: "pair"; candidate: string; a: string; b: string }
  | { id: string; kind: "choice"; anchor: string; candidates: string[]; pieces: string[] };

/** What Muse read across a seam. */
export type ReadOut = {
  id: string;
  kind: "pair" | "choice";
  /** The pieces shown: [a, b] for a pair; [anchor, ...candidate pieces] for a choice. */
  pieces: string[];
  /** Candidate ids in the question, in sheet order. */
  candidates: string[];
  ok: boolean;
  /** Pair: is it the same place? null = could not tell. */
  same: boolean | null;
  /** Choice: index into `candidates`; null = could not tell. */
  choice: number | null;
  confidence: number;
  /** The words Muse read across the tear. */
  words: string[];
  reason: string;
  /** The image Muse read (JPEG data URL). */
  image: string | null;
  ms: number;
  /** The model whose answer this is ("muse-spark-open": Meta's open weights); absent in runs recorded before it. */
  model?: string;
  error?: string;
};

export type JoinOut = {
  candidate: string;
  a: string;
  b: string;
  page: string;
  decidedBy: "geometry" | "geometry+content" | "content";
  confidence: number;
  loop: boolean;
  /** The shape clue: how well the torn edges fit. */
  shape: { score: number; confidence: number; rms: number; overlap: number };
  /**
   * The content clue: what Muse read across this join (null when not asked or no answer). `agrees` is null when Muse
   * answered with confidence 0.5 or less: too little text to tell, so the read carried no weight.
   */
  read: { id: string; agrees: boolean | null; confidence: number; words: string[]; reason: string } | null;
};

export type PageOut = {
  id: string;
  width: number;
  height: number;
  /** Margin (page px) around the page in the rendered image. */
  margin: number;
  confidence: number;
  completeness: number;
  pieces: { id: string; pose: Pose }[];
  /** The rebuilt page, transparent PNG. */
  image: string | null;
};

export type UnplacedOut = { id: string; reason: "no-match" | "twin-unresolved" | "rejected" };

export type TranscriptOut = {
  page: string;
  ok: boolean;
  text: string;
  language: string;
  uncertain: string[];
  translation: { to: string; text: string } | null;
  /** The model that read the page (as on ReadOut). */
  model?: string;
  error?: string;
};

/** What an archive record says the page is (the catalogue's "kind of document"). */
export type RecordKind = "letter" | "telegram" | "memo" | "report" | "form" | "list" | "receipt" | "minutes" | "notes" | "article" | "other";

/** A name the record gives, with the words on the page it rests on (checked: they are in the transcript). */
export type RecordField = { name: string; quote: string };

/** An archive record for one rebuilt page, written by Muse from its transcript; only fields that quote the page. */
export type PageRecord = {
  kind: RecordKind;
  /** The date the page gives for itself, as written, and as ISO 8601 when its numbers bear that out. */
  date: { quote: string; iso: string | null } | null;
  /** Where it was written or sent from. */
  place: RecordField | null;
  from: RecordField | null;
  to: RecordField | null;
  /** Everyone and everything else the page names, once each. */
  people: RecordField[];
  places: RecordField[];
  organisations: RecordField[];
  /** Muse's own one-sentence description, in English: the one field no quote can check, and labelled so. */
  summary: string;
};

export type CatalogOut = {
  page: string;
  status: "pending" | "done" | "failed";
  record: PageRecord | null;
  /** Fields Muse gave whose words are not on the page: left out of the record. */
  dropped: number;
  model: string | null;
  ms?: number;
  costUsd?: number;
  error?: string;
};

/** A spoken provenance note, transcribed by Muse Voice Transcribe (POST /api/notes); kept in the visitor's browser. */
export type SpokenNote = { text: string; audioMs: number; ms: number; costUsd: number; model: string };

export type Warning = { code: WarningCode; message: string };

export type WarningCode = "blurry" | "small-photo" | "no-text" | "some-blank" | "slow-reading" | "reading-failed" | "partial" | "many-pieces" | "overlap" | "tilted" | "sam-refused";

export type ErrorCode =
  | "bad-type"
  | "too-large"
  | "too-small"
  | "unreadable"
  | "no-pieces"
  | "too-many"
  | "rate-limited"
  | "daily-cap"
  | "busy"
  | "model-error"
  | "paused"
  | "timeout"
  | "not-found"
  | "expired"
  | "network"
  | "internal";

export type RunSource = "upload" | "phone" | "sample" | "health";

export type TimelineEntry = { t: number; type: RunEvent["type"]; id?: string };

export type RunResult = {
  version: 1;
  runId: string;
  createdAt: string;
  source: RunSource;
  /** The sample photo's name, for sample runs. */
  sample?: string;
  /** A caption shown with the photo (e.g. that a tear is simulated). */
  caption?: string;
  photo: { url: string | null; width: number; height: number };
  pieces: PieceOut[];
  candidates: CandidateOut[];
  asks: AskOut[];
  reads: ReadOut[];
  joins: JoinOut[];
  pages: PageOut[];
  unplaced: UnplacedOut[];
  transcripts: TranscriptOut[];
  warnings: Warning[];
  /** ms per stage. */
  timings: Partial<Record<Stage, number>> & { total: number };
  cost: { usd: number; samCalls: number; museCalls: number };
  /** How the seams were read (optional: recordings made before S6b lack it). */
  stats?: {
    twinStrategy: "all" | "tree";
    choiceSheet?: "stacked" | "joined";
    sheetWindow?: [number, number];
    readRounds: number;
    twinGroups: number;
    twinClasses: number;
    pairReads: number;
    choiceReads: number;
    skippedBlank?: number;
    /**
     * The tilt judged from the text lines, on photos without the phone's reading: degrees, the line-spacing spread as
     * photographed and once straightened (%), pieces agreeing of those measured, and whether it straightened.
     */
    lineTilt?: { deg: number; before: number; after: number; agree: number; measured: number; straightened: boolean };
  };
  /** The event order and timing (ms from the start), for replay. */
  timeline: TimelineEntry[];
  /** Archive records, written after the page is shown (absent on runs made before them). */
  catalogs?: CatalogOut[];
};

export type RunEvent =
  | { type: "queued"; t: number; position: number }
  | { type: "start"; t: number; runId: string; source: RunSource; caption?: string }
  | { type: "photo"; t: number; url: string | null; width: number; height: number }
  | { type: "stage"; t: number; stage: Stage; status: "active" | "done"; ms?: number }
  | { type: "segment"; t: number; pieces: PieceOut[] }
  | { type: "match"; t: number; candidates: CandidateOut[]; asks: AskOut[] }
  | { type: "read"; t: number; read: ReadOut }
  | { type: "assemble"; t: number; pages: PageOut[]; joins: JoinOut[]; unplaced: UnplacedOut[] }
  | { type: "transcribe"; t: number; transcript: TranscriptOut }
  | { type: "warning"; t: number; warning: Warning }
  | { type: "tick"; t: number }
  | { type: "done"; t: number; result: RunResult }
  /** After done: each page's archive record, first pending, then done or failed. */
  | { type: "catalog"; t: number; catalog: CatalogOut }
  | { type: "error"; t: number; code: ErrorCode; message: string };

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Vercel functions accept request bodies up to 4.5 MB: the browser downsizes photos before sending. */
export const MAX_REQUEST_BYTES = 4_400_000;
export const MAX_PIECES = 120;
