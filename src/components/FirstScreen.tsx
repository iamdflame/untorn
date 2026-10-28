"use client";

// The first screen: the product already working. A recorded run of the real pipeline replays on the sample photo
// (labelled as recorded); "Run it live" sends the same photo through the pipeline now; "Tear your own" takes a phone
// photo or an upload.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Recovery } from "@/lib/run/errors";
import type { Sample } from "@/lib/run/samples";
import type { RunResult } from "@/lib/run/types";
import { RunView, usePrefersReducedMotion } from "./run/RunView";
import { useRun, type LiveInput } from "./run/useRun";
import { openPicker, TearYourOwn } from "./TearYourOwn";

export function FirstScreen({ sample }: { sample: Sample }) {
  const run = useRun();
  const { state } = run;
  const reduced = usePrefersReducedMotion();
  const [recorded, setRecorded] = useState<RunResult | null>(null);
  const [recordingMissing, setRecordingMissing] = useState(false);
  const lastInput = useRef<LiveInput | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // warm the functions, then load the recording
  useEffect(() => {
    fetch("/api/health?warm=1", { cache: "no-store" }).catch(() => {});
    let cancelled = false;
    fetch(sample.recorded)
      .then((r) => (r.ok ? (r.json() as Promise<RunResult>) : Promise.reject(new Error(String(r.status)))))
      .then((r) => !cancelled && setRecorded(r))
      .catch(() => !cancelled && setRecordingMissing(true));
    return () => {
      cancelled = true;
    };
  }, [sample.recorded]);

  const { replay, live } = run;
  const playRecorded = useCallback(() => {
    if (recorded) replay(recorded, { instant: reduced, targetMs: 20_000 });
  }, [recorded, reduced, replay]);

  // the recording plays as soon as it arrives (a still, for reduced motion)
  const started = useRef(false);
  useEffect(() => {
    if (!recorded || started.current) return;
    started.current = true;
    playRecorded();
  }, [recorded, playRecorded]);

  const goLive = useCallback(
    (input: LiveInput) => {
      lastInput.current = input;
      stageRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      void live(input);
    },
    [live, reduced],
  );
  const onPhoto = useCallback((photoId: string) => goLive({ photoId }), [goLive]);
  const onFile = useCallback((file: File) => goLive({ file }), [goLive]);

  const onAction = (r: Recovery) => {
    if (r === "retry" && lastInput.current) goLive(lastInput.current);
    else if (r === "recorded") playRecorded();
    else if (r === "upload") openPicker();
    else if (r === "phone" || r === "retake") document.getElementById("tear")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  };

  const busy = state.mode === "live" && (state.status === "running" || state.status === "queued");
  const label = (
    <div className="run-label" data-mode={state.mode ?? "replay"}>
      {state.mode === "live" ? (
        <span className="run-label-text">
          <span className="live-dot" aria-hidden /> Live run
          {state.status === "done" && state.runId && (
            <>
              {" · "}
              <Link href={`/r/${state.runId}`}>permalink</Link>
            </>
          )}
        </span>
      ) : (
        <span className="run-label-text">A recorded run of the real pipeline</span>
      )}
      <span className="run-label-actions">
        <button type="button" className="btn btn-primary" onClick={() => goLive({ sample: sample.name })} disabled={busy}>
          {busy ? "Running live…" : "Run it live"}
        </button>
        {recorded && (state.mode === "live" || !run.replaying) && (
          <button type="button" className="btn" onClick={playRecorded} disabled={busy}>
            {state.mode === "live" ? "Back to the recording" : "Replay"}
          </button>
        )}
      </span>
    </div>
  );

  return (
    <main className="first-screen">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Untorn
        </Link>
        <nav aria-label="Site">
          <a href="#tear">Tear your own</a>
          <Link href="/accuracy">Accuracy</Link>
        </nav>
      </header>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Torn pages, put back together from one photo.</h1>
        <p className="lede">
          In 1989 the Stasi tore its files apart by hand. About 16,000 sacks of scraps were saved, and some 15,400 are still untouched. Untorn outlines every piece with Meta&apos;s SAM 3.1, and
          Muse reads the half-letters across each tear to decide which pieces belong together.
        </p>
      </section>
      <div ref={stageRef} className="first-run">
        <RunView run={run} onAction={onAction} label={label} fallbackPhoto={sample.photo} />
        {recordingMissing && state.mode !== "live" && <p className="muted">The recording didn&apos;t load. Run it live instead.</p>}
      </div>
      <TearYourOwn onPhoto={onPhoto} onFile={onFile} disabled={busy} />
      <footer className="site-footer">
        <p>
          Untorn is a project for the Meta AI developer hackathon. Photos are deleted within 24 hours and never used for training. <Link href="/accuracy">How accurate is it?</Link>
        </p>
      </footer>
    </main>
  );
}
