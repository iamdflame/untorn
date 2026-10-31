// Muse client for Untorn: structured JSON calls to muse-spark-1.3 and muse-wonder-1.0 over the Responses API.
// Server-only: it reads MODEL_API_KEY. (No `server-only` import, so bench scripts and tests can load it under tsx.)
//
// Every public function returns a MuseOutcome and never throws for an upstream problem: a failed reading is evidence
// the solver goes without, not a crash. Policy, per attempt:
// - network errors, 5xx and 429 retry with jittered exponential backoff (Retry-After honoured, within the deadline);
// - empty or unparseable output retries at once; when the reasoning used up max_output_tokens (the spike's empty k-way
//   answers), the retry reasons one level lower with 1.5x the budget, so a runaway item cannot double the latency;
// - 400/401/402/403/404/413 fail at once: the same request would fail again;
// - each attempt has its own timeout and the call has an overall deadline; the caller's AbortSignal cancels both;
// - a call slower than its hedge delay gets a second identical request beside it; the first good answer wins.
// Every attempt is logged with its latency, tokens and estimated cost; the totals ride on the outcome's meta.

import { hedge } from "./hedge";
import {
  choiceSchema,
  DEFAULT_PROMPT,
  GAP,
  LETTERS,
  PROMPTS,
  PROMPTS_VERSION,
  READ_SCHEMA,
  SEAM_SCHEMA,
  SEAM_SCHEMA_V3,
  SORT_SCHEMA,
  TRANSLATE_SCHEMA,
  type ChoicePromptVersion,
  type ReadPromptVersion,
  type SeamPromptVersion,
  ORIENTATION_SCHEMA,
} from "./prompts";

export const META_API_BASE = "https://api.meta.ai/v1";
export const USER_AGENT = "rejoin/0.1";

export type MuseModel = "muse-spark-1.3" | "muse-wonder-1.0";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ImageDetail = "low" | "high" | "auto" | "original";

/** An image for a Muse call: encoded bytes, or a URL (https or data:). */
export type ImageInput =
  | { data: Uint8Array; mime: "image/jpeg" | "image/png" | "image/webp"; detail?: ImageDetail }
  | { url: string; detail?: ImageDetail };

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: ImageDetail };

export type Usage = { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number };

/** USD per 1M tokens, standard mode (docs: pricing-rate-limits, 2026-10). */
export const PRICES: Record<MuseModel, { input: number; cached: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4.0, cached: 0.2, output: 20.0 },
};

export function costUsd(model: MuseModel, u: Usage): number {
  const p = PRICES[model];
  const fresh = Math.max(0, u.inputTokens - u.cachedTokens);
  return (fresh * p.input + u.cachedTokens * p.cached + u.outputTokens * p.output) / 1e6;
}

export type MuseErrorCode =
  | "network"
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "upstream"
  | "billing"
  | "auth"
  | "bad_request"
  | "empty"
  | "unparseable"
  | "incomplete"
  | "config";

export type MuseFailure = { code: MuseErrorCode; message: string; status: number | null; retryable: boolean };

export type CallMeta = {
  fn: string;
  model: MuseModel;
  effort: ReasoningEffort;
  promptVersion: string;
  attempts: number;
  /** Wall time of the whole call, retries and backoff included. */
  ms: number;
  /** Wall time of the attempt that produced the answer (or the last one). */
  lastAttemptMs: number;
  usage: Usage;
  /** Estimated over every attempt, failed ones included (they still bill their tokens). */
  costUsd: number;
  responseId: string | null;
  /** Requests run side by side: 2 when a hedge fired because the first was slow. */
  lanes: number;
};

export type MuseOutcome<T> = { ok: true; value: T; meta: CallMeta } | { ok: false; error: MuseFailure; meta: CallMeta };

export type AttemptLog = {
  fn: string;
  model: MuseModel;
  attempt: number;
  ms: number;
  status: number | null;
  outcome: "ok" | "retry" | "fail";
  error?: MuseErrorCode;
  message?: string;
  usage?: Usage;
  costUsd: number;
  maxOutputTokens: number;
};

export type MuseOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: MuseModel;
  effort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Overall budget for the call, retries included. */
  deadlineMs?: number;
  /** Start a second identical request when the first has not answered after this long (0: never). */
  hedgeAfterMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Called after every attempt. Defaults to one compact console line; pass () => {} to silence. */
  onLog?: (entry: AttemptLog) => void;
  /** Injection points for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

/** One structured call: what to send and how to check what comes back. */
export type StructuredRequest<T> = {
  fn: string;
  schemaName: string;
  schema: Record<string, unknown>;
  content: ContentPart[];
  /** Validate and normalise the parsed JSON; return null to treat it as unparseable (and retry). */
  check: (json: unknown) => T | null;
  promptVersion?: string;
  defaults: { model: MuseModel; effort: ReasoningEffort; maxOutputTokens: number; timeoutMs: number; deadlineMs: number; hedgeAfterMs: number };
};

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** One reasoning level lower (minimal stays minimal). */
export const stepDown = (e: ReasoningEffort): ReasoningEffort => EFFORTS[Math.max(0, EFFORTS.indexOf(e) - 1)];

const BACKOFF_BASE_MS = 600;
const BACKOFF_CAP_MS = 8000;
const MAX_OUTPUT_CAP = 32000;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const defaultLog = (e: AttemptLog) => {
  const u = e.usage ? ` in=${e.usage.inputTokens} out=${e.usage.outputTokens} (reasoning ${e.usage.reasoningTokens})` : "";
  const err = e.error ? ` ${e.error}${e.message ? `: ${e.message.slice(0, 120)}` : ""}` : "";
  console.info(`[muse] ${e.fn} ${e.model} #${e.attempt} ${e.outcome} ${e.ms}ms${e.status ? ` http ${e.status}` : ""}${u} $${e.costUsd.toFixed(5)}${err}`);
};

export function imagePart(img: ImageInput): ContentPart {
  const url = "url" in img ? img.url : `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}`;
  return img.detail ? { type: "input_image", image_url: url, detail: img.detail } : { type: "input_image", image_url: url };
}

const textPart = (text: string): ContentPart => ({ type: "input_text", text });

type ResponseJson = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
  output_text?: string;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

/** The model's visible text: every output_text part of every message item, joined. */
export function extractOutputText(j: ResponseJson): string {
  const parts: string[] = [];
  for (const item of j.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  if (!parts.length && typeof j.output_text === "string") return j.output_text;
  return parts.join("");
}

function readUsage(j: ResponseJson): Usage {
  const u = j.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Parse model JSON, tolerating a code fence or prose around one object (constrained decoding should not need it). */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

function classifyStatus(status: number): { code: MuseErrorCode; retryable: boolean } {
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "upstream", retryable: true };
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 402) return { code: "billing", retryable: false };
  return { code: "bad_request", retryable: false };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

const ZERO: Usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };

/**
 * Run one structured call with the retry policy above, hedged: when the first request is slower than hedgeAfterMs a
 * second identical one starts beside it and the first good answer wins. Exported for the bench's prompt variants.
 */
export async function museCall<T>(req: StructuredRequest<T>, opts: MuseOptions = {}): Promise<MuseOutcome<T>> {
  const hedgeAfterMs = opts.hedgeAfterMs ?? req.defaults.hedgeAfterMs;
  if (!hedgeAfterMs) return museCallOnce(req, opts);
  const t0 = Date.now();
  const deadlineMs = opts.deadlineMs ?? req.defaults.deadlineMs;
  try {
    const h = await hedge(
      (signal, lane) => museCallOnce(req, { ...opts, signal, deadlineMs: Math.max(1, deadlineMs - (Date.now() - t0)), ...(lane ? { onLog: opts.onLog ?? defaultLog } : {}) }),
      {
        afterMs: hedgeAfterMs,
        lanes: 2,
        signal: opts.signal,
        ok: (r) => r.ok,
        final: (r) => !r.ok && !r.error.retryable,
      },
    );
    const costUsd = h.results.reduce((s, r) => s + r.meta.costUsd, 0);
    const usage = h.results.reduce((u, r) => addUsage(u, r.meta.usage), ZERO);
    return { ...h.result, meta: { ...h.result.meta, ms: Date.now() - t0, costUsd, usage, lanes: h.lanesStarted } } as MuseOutcome<T>;
  } catch {
    const meta: CallMeta = {
      fn: req.fn,
      model: opts.model ?? req.defaults.model,
      effort: opts.effort ?? req.defaults.effort,
      promptVersion: req.promptVersion ?? PROMPTS_VERSION,
      attempts: 0,
      ms: Date.now() - t0,
      lastAttemptMs: 0,
      usage: ZERO,
      costUsd: 0,
      responseId: null,
      lanes: 1,
    };
    return { ok: false, error: { code: "aborted", message: "aborted by the caller", status: null, retryable: false }, meta };
  }
}

async function museCallOnce<T>(req: StructuredRequest<T>, opts: MuseOptions): Promise<MuseOutcome<T>> {
  const model = opts.model ?? req.defaults.model;
  let effort = opts.effort ?? req.defaults.effort;
  let maxOutputTokens = opts.maxOutputTokens ?? req.defaults.maxOutputTokens;
  const timeoutMs = opts.timeoutMs ?? req.defaults.timeoutMs;
  const deadlineMs = opts.deadlineMs ?? req.defaults.deadlineMs;
  const maxAttempts = opts.maxAttempts ?? 4;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const log = opts.onLog ?? defaultLog;
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY;

  const t0 = Date.now();
  let usage = ZERO;
  let cost = 0;
  let attempts = 0;
  let lastAttemptMs = 0;
  let responseId: string | null = null;
  const meta = (): CallMeta => ({
    fn: req.fn,
    model,
    effort,
    promptVersion: req.promptVersion ?? PROMPTS_VERSION,
    attempts,
    ms: Date.now() - t0,
    lastAttemptMs,
    usage,
    costUsd: cost,
    responseId,
    lanes: 1,
  });
  const fail = (error: MuseFailure): MuseOutcome<T> => ({ ok: false, error, meta: meta() });

  if (!apiKey) return fail({ code: "config", message: "MODEL_API_KEY is not set", status: null, retryable: false });

  let last: MuseFailure = { code: "timeout", message: "deadline reached before the first attempt", status: null, retryable: true };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadlineMs - (Date.now() - t0);
    if (remaining <= 0) break;
    if (opts.signal?.aborted) return fail({ code: "aborted", message: "aborted by the caller", status: null, retryable: false });
    attempts = attempt;

    const timer = AbortSignal.timeout(Math.min(timeoutMs, remaining));
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
    const body = {
      model,
      input: [{ type: "message", role: "user", content: req.content }],
      text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      store: false,
    };
    const ta = Date.now();
    let status: number | null = null;
    let waitMs: number | null = null;
    let attemptUsage: Usage | undefined;
    let attemptCost = 0;
    let outcome: { value: T } | null = null;
    try {
      const res = await fetchImpl(`${opts.baseUrl ?? META_API_BASE}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal,
      });
      status = res.status;
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as ResponseJson;
          if (j.error?.message) message = j.error.message;
        } catch {
          // empty or non-JSON body
        }
        const c = classifyStatus(res.status);
        last = { code: c.code, message, status: res.status, retryable: c.retryable };
        if (c.code === "rate_limited" || res.status === 503) waitMs = retryAfterMs(res);
      } else {
        const j = (await res.json()) as ResponseJson;
        responseId = j.id ?? responseId;
        attemptUsage = readUsage(j);
        attemptCost = costUsd(model, attemptUsage);
        usage = addUsage(usage, attemptUsage);
        cost += attemptCost;
        const text = extractOutputText(j);
        const cutOff = j.status === "incomplete";
        if (j.status === "failed") {
          last = { code: "upstream", message: j.error?.message ?? "response failed", status, retryable: true };
        } else if (!text.trim()) {
          last = cutOff
            ? { code: "incomplete", message: `no answer within ${maxOutputTokens} output tokens (${j.incomplete_details?.reason ?? "incomplete"})`, status, retryable: true }
            : { code: "empty", message: "empty output", status, retryable: true };
          waitMs = 0;
          if (cutOff || attemptUsage.reasoningTokens > 0.8 * maxOutputTokens) {
            // the reasoning ran away: think less and allow a little more, rather than wait twice as long
            effort = stepDown(effort);
            maxOutputTokens = Math.min(MAX_OUTPUT_CAP, Math.round(maxOutputTokens * 1.5));
          }
        } else {
          const parsed = parseJsonLoose(text);
          const value = parsed === undefined ? null : req.check(parsed);
          if (value === null) {
            last = cutOff
              ? { code: "incomplete", message: `output cut off at ${maxOutputTokens} tokens`, status, retryable: true }
              : { code: "unparseable", message: `output did not match the schema: ${text.slice(0, 160)}`, status, retryable: true };
            waitMs = 0;
            if (cutOff) maxOutputTokens = Math.min(MAX_OUTPUT_CAP, maxOutputTokens * 2);
          } else {
            outcome = { value };
          }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) {
        lastAttemptMs = Date.now() - ta;
        log({ fn: req.fn, model, attempt, ms: lastAttemptMs, status, outcome: "fail", error: "aborted", costUsd: 0, maxOutputTokens });
        return fail({ code: "aborted", message: "aborted by the caller", status: null, retryable: false });
      }
      const timedOut = timer.aborted;
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      last = timedOut
        ? { code: "timeout", message: `no answer within ${Math.min(timeoutMs, remaining)} ms`, status, retryable: true }
        : { code: "network", message: `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? e}${cause ? ` (${cause})` : ""}`, status, retryable: true };
    }
    lastAttemptMs = Date.now() - ta;

    if (outcome) {
      log({ fn: req.fn, model, attempt, ms: lastAttemptMs, status, outcome: "ok", usage: attemptUsage, costUsd: attemptCost, maxOutputTokens });
      return { ok: true, value: outcome.value, meta: meta() };
    }
    const willRetry = last.retryable && attempt < maxAttempts;
    log({
      fn: req.fn,
      model,
      attempt,
      ms: lastAttemptMs,
      status,
      outcome: willRetry ? "retry" : "fail",
      error: last.code,
      message: last.message,
      usage: attemptUsage,
      costUsd: attemptCost,
      maxOutputTokens,
    });
    if (!willRetry) break;

    const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    const jittered = exp / 2 + random() * (exp / 2);
    const delay = waitMs === 0 ? Math.round(50 + random() * 200) : Math.max(waitMs ?? 0, jittered);
    if (delay >= deadlineMs - (Date.now() - t0)) break;
    try {
      await sleep(delay, opts.signal);
    } catch {
      return fail({ code: "aborted", message: "aborted by the caller", status: null, retryable: false });
    }
  }
  return fail(last);
}

// ---------------------------------------------------------------------------------------------------------------
// Validation helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const clamp01 = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

// ---------------------------------------------------------------------------------------------------------------
// Untorn's functions

/** `text_crosses` (seam v3): whether any letters or words cross the tear; false makes the verdict no clue. */
export type SeamVerdict = { same_place: boolean; confidence: number; words_across: string[]; reason: string; text_crosses?: boolean };

export type ReadingOptions = MuseOptions & {
  /** Also send the image turned by 180°, for pieces whose upright direction is unknown. */
  rotated?: ImageInput;
};

/** Binary: is this seam image a true join? */
export async function verifySeam(
  seamImage: ImageInput,
  opts: ReadingOptions & { prompt?: SeamPromptVersion } = {},
): Promise<MuseOutcome<SeamVerdict>> {
  const version = opts.prompt ?? DEFAULT_PROMPT.seam;
  const content = [textPart(PROMPTS.seam[version]), imagePart(seamImage)];
  if (opts.rotated) content.push(textPart(PROMPTS.bothOrientations), imagePart(opts.rotated));
  return museCall(
    {
      fn: "verifySeam",
      schemaName: "seam_verdict",
      schema: version === "v3" ? SEAM_SCHEMA_V3 : SEAM_SCHEMA,
      content,
      promptVersion: `${PROMPTS_VERSION}/seam.${version}${opts.rotated ? "+rot" : ""}`,
      defaults: { model: "muse-spark-1.3", effort: "low", maxOutputTokens: 4000, timeoutMs: 45_000, deadlineMs: 90_000, hedgeAfterMs: 20_000 },
      check: (j) => {
        if (!isObj(j) || typeof j.same_place !== "boolean") return null;
        const confidence = clamp01(j.confidence);
        const words_across = strArr(j.words_across);
        const reason = str(j.reason);
        if (confidence === null || !words_across || reason === null) return null;
        if (version === "v3") {
          if (typeof j.text_crosses !== "boolean") return null;
          return { same_place: j.same_place, confidence, words_across, reason, text_crosses: j.text_crosses };
        }
        return { same_place: j.same_place, confidence, words_across, reason };
      },
    },
    opts,
  );
}

export type Continuation = { choice: string; index: number; confidence: number; words_across: string[]; reason: string };

/** K-way: which of the k labelled candidates (A, B, …) continues the fragment at the top of the sheet? */
export async function chooseContinuation(
  sheetImage: ImageInput,
  k: number,
  opts: ReadingOptions & { prompt?: ChoicePromptVersion } = {},
): Promise<MuseOutcome<Continuation>> {
  const version = opts.prompt ?? DEFAULT_PROMPT.choice;
  const schema = choiceSchema(k);
  const content = [textPart(PROMPTS.choice[version](k)), imagePart(sheetImage)];
  if (opts.rotated) content.push(textPart(PROMPTS.bothOrientations), imagePart(opts.rotated));
  const letters = LETTERS.slice(0, k);
  return museCall(
    {
      fn: "chooseContinuation",
      schemaName: "continuation_choice",
      schema,
      content,
      promptVersion: `${PROMPTS_VERSION}/choice.${version}${opts.rotated ? "+rot" : ""}`,
      defaults: { model: "muse-spark-1.3", effort: "low", maxOutputTokens: 6000, timeoutMs: 45_000, deadlineMs: 90_000, hedgeAfterMs: 20_000 },
      check: (j) => {
        if (!isObj(j)) return null;
        const choice = str(j.choice)?.trim().toUpperCase() ?? "";
        const index = choice.length === 1 ? letters.indexOf(choice) : -1;
        const confidence = clamp01(j.confidence);
        const words_across = strArr(j.words_across);
        const reason = str(j.reason);
        if (index < 0 || confidence === null || !words_across || reason === null) return null;
        return { choice, index, confidence, words_across, reason };
      },
    },
    opts,
  );
}

export type PageReading = { text: string; language: string; uncertain: string[] };

export type PageOrientation = { upright: boolean; confidence: number; reason: string };

/** Is a rebuilt page upright? A quick look (minimal effort) for pages whose up/down the solver could not settle. */
export async function pageOrientation(pageImage: ImageInput, opts: MuseOptions = {}): Promise<MuseOutcome<PageOrientation>> {
  return museCall(
    {
      fn: "pageOrientation",
      schemaName: "page_orientation",
      schema: ORIENTATION_SCHEMA,
      content: [textPart(PROMPTS.orient.v1), imagePart(pageImage)],
      promptVersion: `${PROMPTS_VERSION}/orient.v1`,
      defaults: { model: "muse-spark-1.3", effort: "minimal", maxOutputTokens: 600, timeoutMs: 20_000, deadlineMs: 30_000, hedgeAfterMs: 8_000 },
      check: (j) => {
        if (!isObj(j) || typeof j.upright !== "boolean") return null;
        const confidence = clamp01(j.confidence);
        const reason = str(j.reason);
        if (confidence === null || reason === null) return null;
        return { upright: j.upright, confidence, reason };
      },
    },
    opts,
  );
}

/** The model writes the gap marker as "[…]" or "[...]" (seen live); normalise every spelling to GAP. */
export const normaliseGaps = (s: string) => s.replace(/\[\s*(?:\.\s*\.\s*\.|…)\s*\]/g, GAP);

/**
 * Transcribe a reassembled page; missing or illegible text comes back as the gap marker, never invented.
 * `prompt`: "v1" (default) keeps line breaks as on the page; "markdown" converts to Markdown by ShredBench's rules;
 * "parts" reads a sheet of partly reassembled parts and loose pieces in their original order.
 */
export async function readPage(pageImage: ImageInput, opts: MuseOptions & { prompt?: ReadPromptVersion } = {}): Promise<MuseOutcome<PageReading>> {
  const version = opts.prompt ?? "v1";
  return museCall(
    {
      fn: "readPage",
      schemaName: "page_reading",
      schema: READ_SCHEMA,
      content: [textPart(PROMPTS.read[version]), imagePart(pageImage)],
      promptVersion: `${PROMPTS_VERSION}/read.${version}`,
      defaults: { model: "muse-spark-1.3", effort: "low", maxOutputTokens: 8000, timeoutMs: 90_000, deadlineMs: 150_000, hedgeAfterMs: 45_000 },
      check: (j) => {
        if (!isObj(j)) return null;
        const text = str(j.text);
        const language = str(j.language);
        const uncertain = strArr(j.uncertain);
        if (text === null || language === null || !uncertain) return null;
        return { text: normaliseGaps(text), language: language.trim() || "und", uncertain: uncertain.map(normaliseGaps) };
      },
    },
    opts,
  );
}

export type Translation = { text: string; source_language: string; to: string };

/** Translate a transcription; gap markers pass through unchanged (checked: a translation that drops one is retried). */
export async function translate(text: string, to: string, opts: MuseOptions = {}): Promise<MuseOutcome<Translation>> {
  text = normaliseGaps(text);
  const gaps = text.split(GAP).length - 1;
  return museCall(
    {
      fn: "translate",
      schemaName: "translation",
      schema: TRANSLATE_SCHEMA,
      content: [textPart(PROMPTS.translate.v1(to)), textPart(text)],
      promptVersion: `${PROMPTS_VERSION}/translate.v1`,
      defaults: { model: "muse-spark-1.3", effort: "minimal", maxOutputTokens: 8000, timeoutMs: 60_000, deadlineMs: 120_000, hedgeAfterMs: 30_000 },
      check: (j) => {
        if (!isObj(j)) return null;
        const raw = str(j.text);
        const source_language = str(j.source_language);
        if (raw === null || source_language === null) return null;
        const out = normaliseGaps(raw);
        if (out.split(GAP).length - 1 < gaps) return null;
        return { text: out, source_language, to };
      },
    },
    opts,
  );
}

export type FragmentGroup = { fragments: number[]; reason: string };
export type FragmentSort = {
  /** 0-based indices into the crops array; every crop is in exactly one group. */
  groups: FragmentGroup[];
  /** Crops the model left out or repeated; each missing one was put in a group of its own. */
  repaired: { missing: number[]; duplicated: number[] };
};

export const MAX_SORT_IMAGES = 50;

/** Muse Wonder sorts a mixed pile of fragment crops into pages. */
export async function sortFragments(crops: ImageInput[], opts: MuseOptions = {}): Promise<MuseOutcome<FragmentSort>> {
  const n = crops.length;
  const content: ContentPart[] = [textPart(PROMPTS.sort.v1(n))];
  crops.forEach((c, i) => content.push(textPart(PROMPTS.sort.fragmentLabel(i + 1)), imagePart(c)));
  const req: StructuredRequest<FragmentSort> = {
    fn: "sortFragments",
    schemaName: "fragment_groups",
    schema: SORT_SCHEMA,
    content,
    promptVersion: `${PROMPTS_VERSION}/sort.v1`,
    defaults: { model: "muse-wonder-1.0", effort: "low", maxOutputTokens: 12000, timeoutMs: 90_000, deadlineMs: 150_000, hedgeAfterMs: 60_000 },
    check: (j) => (isObj(j) ? normaliseGroups(j.groups, n) : null),
  };
  if (n === 0 || n > MAX_SORT_IMAGES) {
    const meta: CallMeta = {
      fn: req.fn,
      model: opts.model ?? req.defaults.model,
      effort: opts.effort ?? req.defaults.effort,
      promptVersion: req.promptVersion ?? PROMPTS_VERSION,
      attempts: 0,
      ms: 0,
      lastAttemptMs: 0,
      usage: ZERO,
      costUsd: 0,
      responseId: null,
      lanes: 1,
    };
    if (n === 0) return { ok: true, value: { groups: [], repaired: { missing: [], duplicated: [] } }, meta };
    return { ok: false, error: { code: "bad_request", message: `at most ${MAX_SORT_IMAGES} fragments per call, got ${n}`, status: null, retryable: false }, meta };
  }
  return museCall(req, opts);
}

/** Turn the model's 1-based groups into a partition of 0..n-1; null when it is unusable (then the call retries). */
export function normaliseGroups(raw: unknown, n: number): FragmentSort | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const duplicated: number[] = [];
  const groups: FragmentGroup[] = [];
  for (const g of raw) {
    if (!isObj(g) || !Array.isArray(g.fragments)) return null;
    const reason = str(g.reason) ?? "";
    const frags: number[] = [];
    for (const f of g.fragments) {
      if (typeof f !== "number" || !Number.isInteger(f) || f < 1 || f > n) continue;
      const i = f - 1;
      if (seen.has(i)) {
        duplicated.push(i);
        continue;
      }
      seen.add(i);
      frags.push(i);
    }
    if (frags.length) groups.push({ fragments: frags, reason });
  }
  // Mostly empty answers are not an answer: retry rather than repair everything.
  if (seen.size < Math.ceil(n / 2)) return null;
  const missing: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) {
      missing.push(i);
      groups.push({ fragments: [i], reason: "not placed by the model; kept on its own" });
    }
  }
  return { groups, repaired: { missing, duplicated } };
}
