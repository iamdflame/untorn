// SAM 3.1's streamed text output → frames.
//
// SAM writes one segment per video frame:
//   <12f>0<|box;x1=343;y1=277;x2=368;y2=300;w=640;h=360;c=0.70|><|mask;x=0;y=0;c=0.70;data=24,26,~…|>,1<|box;…|><|mask;…|>
// A frame is complete when the next "<Nf>" marker arrives or the stream ends.

import type { Box, EncodedMask } from "./types";

export type RawObject = {
  id: number;
  box: Box;
  /** The frame size SAM reports the box in. */
  frameW: number;
  frameH: number;
  confidence: number | null;
  mask?: EncodedMask;
};

export type ParsedFrame = { frame: number; objects: RawObject[] };

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const OBJECT = new RegExp(
  `(\\d+)<\\|box;x1=${NUM};y1=${NUM};x2=${NUM};y2=${NUM};w=(\\d+);h=(\\d+)(?:;c=([0-9.eE+-]+))?\\|>` +
    `(?:<\\|mask;x=(-?\\d+);y=(-?\\d+)(?:;c=[0-9.eE+-]+)?;data=(\\d+),(\\d+),(.*?)\\|>)?`,
  "g",
);
const MARKER = /<(\d+)f>/g;

export function parseFrameSegment(segment: string): ParsedFrame | null {
  const head = /^<(\d+)f>/.exec(segment);
  if (!head) return null;
  const objects: RawObject[] = [];
  for (const m of segment.matchAll(OBJECT)) {
    const c = m[8] === undefined ? null : Number(m[8]);
    const obj: RawObject = {
      id: Number(m[1]),
      box: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
      frameW: Number(m[6]),
      frameH: Number(m[7]),
      confidence: c !== null && Number.isFinite(c) ? c : null,
    };
    if (m[9] !== undefined) {
      // SAM writes the mask raster size height first: "data=<H>,<W>,<encoding><payload>".
      obj.mask = { x: Number(m[9]), y: Number(m[10]), h: Number(m[11]), w: Number(m[12]), data: m[13] };
    }
    objects.push(obj);
  }
  return { frame: Number(head[1]), objects };
}

/** Parse a complete SAM text output. */
export function parseSamText(text: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const seg of text.split(/(?=<\d+f>)/)) {
    const f = parseFrameSegment(seg);
    if (f) frames.push(f);
  }
  return frames;
}

/** Incremental parser: feed text deltas, get frames back as soon as they're complete. */
export class SamTextAccumulator {
  private buf = "";

  push(delta: string): ParsedFrame[] {
    this.buf += delta;
    const starts = [...this.buf.matchAll(MARKER)].map((m) => m.index ?? 0);
    if (starts.length < 2) return [];
    const done: ParsedFrame[] = [];
    for (let i = 0; i < starts.length - 1; i++) {
      const f = parseFrameSegment(this.buf.slice(starts[i], starts[i + 1]));
      if (f) done.push(f);
    }
    this.buf = this.buf.slice(starts[starts.length - 1]);
    return done;
  }

  end(): ParsedFrame[] {
    const f = parseFrameSegment(this.buf);
    this.buf = "";
    return f ? [f] : [];
  }
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Read a Responses API event stream (SSE) and yield the output text deltas. */
export async function* readOutputTextDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      type ErrorFields = { message?: string; code?: string };
      let ev: { type?: string; delta?: string; error?: ErrorFields; response?: { error?: ErrorFields } } & ErrorFields;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") yield ev.delta;
      else if (ev.type === "error" || ev.type === "response.failed") {
        // `response.failed` nests the error in the response; a stream `error` event carries code and message at the top level.
        const err = ev.error ?? ev.response?.error ?? ev;
        throw new UpstreamError(err?.message ?? "upstream error", null, err?.code ?? null);
      }
    }
  }
}
