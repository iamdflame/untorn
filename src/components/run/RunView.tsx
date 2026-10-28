"use client";

// A run on screen: the photo stage with stages and Muse's reads beside it, then the result. Used by the first screen
// (recorded replay and live runs), the permalink /r/<runId> and phone/upload runs.

import { useSyncExternalStore } from "react";
import type { Recovery } from "@/lib/run/errors";
import { ErrorPanel, ReadFeed, SlowNotice, StageList, Warnings } from "./panels";
import { PhotoStage } from "./PhotoStage";
import { ResultView } from "./ResultView";
import type { RunHandle } from "./useRun";

const motionQuery = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(motionQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(motionQuery).matches,
    () => false,
  );
}

export function RunView({
  run,
  onAction,
  label,
  fallbackPhoto,
}: {
  run: RunHandle;
  onAction: (r: Recovery) => void;
  label?: React.ReactNode;
  fallbackPhoto?: { url: string; width: number; height: number };
}) {
  const { state } = run;
  const reduced = usePrefersReducedMotion();
  const busy = state.status === "running" || state.status === "queued";
  return (
    <div className="run-view" data-status={state.status} data-mode={state.mode ?? "none"} aria-busy={busy}>
      <div className="run-main">
        <div className="run-stage-wrap">
          {label}
          <PhotoStage state={state} reducedMotion={reduced} fallbackPhoto={fallbackPhoto} />
          {state.caption && <p className="caption">{state.caption}</p>}
        </div>
        <aside className="run-side">
          {state.status === "queued" && (
            <p className="slow-notice" role="status">
              Waiting for a free slot: {state.queuePosition} ahead of you.
            </p>
          )}
          <StageList state={state} />
          {run.slow && <SlowNotice />}
          <ReadFeed state={state} />
          <Warnings state={state} />
          {state.error && <ErrorPanel error={state.error} onAction={onAction} />}
        </aside>
      </div>
      <ResultView state={state} />
    </div>
  );
}
