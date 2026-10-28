"use client";

// The run's side panels: true pipeline stages, Muse's seam reads as they land, warnings, and designed errors with
// their way out. Unstyled-but-tidy: class names and data attributes are the design pass's hooks.

import { ERRORS, type Recovery } from "@/lib/run/errors";
import type { RunState } from "@/lib/run/state";
import { STAGE_LABEL, STAGES, type ReadOut } from "@/lib/run/types";

const secs = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);

export function StageList({ state }: { state: RunState }) {
  const counts: Record<string, string> = {
    segment: state.pieces.length ? `${state.pieces.length} pieces` : "",
    match: state.asks.length ? `${state.candidates.length} candidate joins, ${state.asks.length} to read` : "",
    read: state.asks.length ? `${state.reads.length} of ${state.asks.length} seams read` : "",
    assemble: state.pages.length ? `${state.pages.length} page${state.pages.length === 1 ? "" : "s"}, ${state.joins.length} joins` : "",
    transcribe: state.transcripts.length ? `${state.transcripts.filter((t) => t.ok).length} read` : "",
  };
  return (
    <ol className="stages" aria-label="Pipeline stages">
      {STAGES.map((s) => {
        const st = state.stages[s];
        return (
          <li key={s} data-stage={s} data-status={st.status} aria-current={st.status === "active" ? "step" : undefined}>
            <span className="stage-dot" aria-hidden />
            <span className="stage-name">{STAGE_LABEL[s]}</span>
            <span className="stage-meta">
              {counts[s]}
              {st.status === "done" && st.ms !== undefined ? ` · ${secs(st.ms)}` : ""}
            </span>
            <span className="sr-only">{st.status === "done" ? "done" : st.status === "active" ? "in progress" : "waiting"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** "✓ joins", "✗ doesn't join", "picked B of 3", or "couldn't tell". */
export function verdictText(r: ReadOut): { mark: "yes" | "no" | "unsure"; text: string } {
  if (!r.ok) return { mark: "unsure", text: "no answer" };
  // at confidence 0.5 or below the solver gives a read no weight
  if (r.confidence <= 0.5) return { mark: "unsure", text: "too little text to tell" };
  if (r.kind === "pair") {
    if (r.same === null) return { mark: "unsure", text: "couldn't tell" };
    return r.same ? { mark: "yes", text: "continues" } : { mark: "no", text: "doesn't continue" };
  }
  if (r.choice === null) return { mark: "unsure", text: "couldn't tell" };
  return { mark: "yes", text: `picked ${String.fromCharCode(65 + r.choice)} of ${r.candidates.length}` };
}

export function ReadCard({ read, compact = false }: { read: ReadOut; compact?: boolean }) {
  const v = verdictText(read);
  return (
    <figure className="read-card" data-kind={read.kind} data-verdict={v.mark}>
      {read.image && !compact && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={read.image} alt={`The seam Muse read between ${read.pieces.join(" and ")}`} className="read-image" />
      )}
      <figcaption>
        <span className="read-words">{read.words.length ? read.words.map((w) => `“${w}”`).join(" · ") : read.ok ? "no words across" : ""}</span>
        <span className="read-verdict">
          <span aria-hidden>{v.mark === "yes" ? "✓" : v.mark === "no" ? "✗" : "?"}</span> {v.text}
          {read.ok ? ` · ${Math.round(read.confidence * 100)}%` : ""}
        </span>
        {!compact && read.reason && <span className="read-reason">{read.reason}</span>}
      </figcaption>
    </figure>
  );
}

/** Seam reads, newest first. The newest one is the "now testing" card. */
export function ReadFeed({ state, max = 6 }: { state: RunState; max?: number }) {
  if (!state.asks.length && !state.reads.length) return null;
  const reads = [...state.reads].reverse().slice(0, max);
  return (
    <section className="read-feed" aria-label="Muse reading across the tears" aria-live="polite">
      <h3 className="panel-title">Reading across the tears</h3>
      {reads.length ? (
        <ul>
          {reads.map((r, i) => (
            <li key={r.id} data-latest={i === 0 ? "" : undefined}>
              <ReadCard read={r} compact={i > 0} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Muse is reading {state.asks.length} seams…</p>
      )}
    </section>
  );
}

export function Warnings({ state }: { state: RunState }) {
  if (!state.warnings.length) return null;
  return (
    <ul className="warnings" aria-label="Notes on this run">
      {state.warnings.map((w) => (
        <li key={w.code} data-code={w.code}>
          {w.message}
        </li>
      ))}
    </ul>
  );
}

export const RECOVERY_LABEL: Record<Recovery, string> = {
  retake: "Take the photo again",
  upload: "Choose another photo",
  retry: "Try again",
  recorded: "Watch the recorded run",
  phone: "Use the phone instead",
  wait: "OK",
};

export function ErrorPanel({ error, onAction, actions }: { error: NonNullable<RunState["error"]>; onAction: (r: Recovery) => void; actions?: Recovery[] }) {
  const info = ERRORS[error.code] ?? ERRORS.internal;
  const recover = (actions ?? info.recover).filter((r) => r !== "wait");
  return (
    <div className="error-panel" role="alert" data-code={error.code}>
      <h3>{info.title}</h3>
      <p>{error.message || info.message}</p>
      {recover.length > 0 && (
        <div className="actions">
          {recover.map((r, i) => (
            <button key={r} type="button" className={i === 0 ? "btn btn-primary" : "btn"} onClick={() => onAction(r)}>
              {RECOVERY_LABEL[r]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SlowNotice() {
  return (
    <p className="slow-notice" role="status">
      Taking longer than usual: the models are busy. Partial results stay on screen; nothing is lost.
    </p>
  );
}
