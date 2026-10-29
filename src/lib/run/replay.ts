// Replaying a stored run: rebuild its event stream from the result's timeline, and play it back on a clock.
// The live stream and a replay drive the screens through the same reducer (state.ts).

import type { RunEvent, RunResult, Stage } from "./types";

/** The events of a finished run, in their original order and timing (ms from the start). */
export function eventsFromResult(r: RunResult): RunEvent[] {
  const out: RunEvent[] = [];
  let sawPhoto = false;
  for (const e of r.timeline) {
    const t = e.t;
    switch (e.type) {
      case "start":
        out.push({ type: "start", t, runId: r.runId, source: r.source, caption: r.caption });
        break;
      case "photo":
        sawPhoto = true;
        out.push({ type: "photo", t, url: r.photo.url, width: r.photo.width, height: r.photo.height });
        break;
      case "stage": {
        const [stage, status] = (e.id ?? "").split(":") as [Stage, "active" | "done"];
        const ms = status === "done" ? r.timings[stage] : undefined;
        out.push({ type: "stage", t, stage, status, ...(ms !== undefined ? { ms } : {}) });
        break;
      }
      case "segment":
        out.push({ type: "segment", t, pieces: r.pieces });
        break;
      case "match":
        out.push({ type: "match", t, candidates: r.candidates, asks: r.asks });
        break;
      case "read": {
        const read = r.reads.find((x) => x.id === e.id);
        if (read) out.push({ type: "read", t, read });
        break;
      }
      case "assemble":
        out.push({ type: "assemble", t, pages: r.pages, joins: r.joins, unplaced: r.unplaced });
        break;
      case "transcribe": {
        const transcript = r.transcripts.find((x) => x.page === e.id);
        if (transcript) out.push({ type: "transcribe", t, transcript });
        break;
      }
      case "warning": {
        const warning = r.warnings.find((w) => w.code === e.id);
        if (warning) out.push({ type: "warning", t, warning });
        break;
      }
      case "done":
        out.push({ type: "done", t, result: r });
        break;
    }
  }
  if (!sawPhoto) out.splice(Math.min(1, out.length), 0, { type: "photo", t: 0, url: r.photo.url, width: r.photo.width, height: r.photo.height });
  if (out.at(-1)?.type !== "done") out.push({ type: "done", t: r.timings.total, result: r });
  return out;
}

/**
 * Play events back so the whole run takes about `targetMs` (never slower than real time). Returns a stop function.
 * `instant` delivers everything at once (reduced motion, or a still view).
 */
export function playEvents(events: RunEvent[], onEvent: (e: RunEvent) => void, opts: { targetMs?: number; instant?: boolean; onEnd?: () => void } = {}): () => void {
  if (opts.instant) {
    for (const e of events) onEvent(e);
    opts.onEnd?.();
    return () => {};
  }
  const total = events.at(-1)?.t ?? 0;
  const k = total > 0 ? Math.min(1, (opts.targetMs ?? 20_000) / total) : 1;
  const timers = events.map((e, i) =>
    setTimeout(() => {
      onEvent(e);
      if (i === events.length - 1) opts.onEnd?.();
    }, e.t * k),
  );
  return () => timers.forEach(clearTimeout);
}
