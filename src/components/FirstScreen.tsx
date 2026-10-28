"use client";

// The first screen: the product already working. A recorded run of the real pipeline plays on the sample photo
// (labelled as recorded); "Run it live" sends the same photo through the pipeline now; "Tear your own" takes a phone
// photo or an upload. Live and recorded runs fold through the same reducer and are drawn by the same hero.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Recovery } from "@/lib/run/errors";
import { SAMPLES, STACKS, type Sample } from "@/lib/run/samples";
import type { RunResult } from "@/lib/run/types";
import { Hero } from "./hero/Hero";
import { ErrorNote, Note } from "./hero/LeadNote";
import { useNearOrIdle, usePrefersReducedMotion } from "./hooks";
import { ResultSection } from "./result/ResultSection";
import { useRun, type LiveInput } from "./run/useRun";
import { openPicker, TearYourOwn } from "./TearYourOwn";

export function FirstScreen({ sample: initial }: { sample: Sample }) {
  const run = useRun();
  const { state } = run;
  const reduced = usePrefersReducedMotion();
  // a sample can be named in the address (/?sample=<name>)
  const search = useSyncExternalStore(
    () => () => {},
    () => location.search,
    () => "",
  );
  const named = new URLSearchParams(search).get("sample");
  const sample = (named && SAMPLES[named]) || initial;
  const [recorded, setRecorded] = useState<RunResult | null>(null);
  const [recordingMissing, setRecordingMissing] = useState(false);
  const [seq, setSeq] = useState(0);
  const [J, setJ] = useState(0);
  const [liveSample, setLiveSample] = useState(false);
  const lastInput = useRef<LiveInput | null>(null);
  // the result is below the fold: build it once it's near, or once the page is idle
  const resultRef = useRef<HTMLDivElement>(null);
  const resultOn = useNearOrIdle(resultRef);

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

  const { replay, live, stop } = run;
  const playRecorded = useCallback(() => {
    if (!recorded) return;
    // the recording is a stored run: all its events at once; the hero plays them in pipeline order
    replay(recorded, { instant: true });
    setSeq((n) => n + 1);
    setLiveSample(false);
  }, [recorded, replay]);

  // the recording plays as soon as it arrives, unless a live run already started
  const started = useRef(false);
  useEffect(() => {
    if (!recorded || started.current) return;
    started.current = true;
    playRecorded();
  }, [recorded, playRecorded]);

  const goLive = useCallback(
    (input: LiveInput) => {
      started.current = true; // a late-loading recording must not replace a live run
      lastInput.current = input;
      setLiveSample("sample" in input);
      setSeq((n) => n + 1);
      setJ(0);
      document.getElementById("top")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      void live(input);
    },
    [live, reduced],
  );
  const onPhoto = useCallback((photoId: string) => goLive({ photoId }), [goLive]);
  const onFile = useCallback((file: File) => goLive({ file }), [goLive]);

  const onAction = (r: Recovery) => {
    if (r === "retry" && lastInput.current) goLive(lastInput.current);
    else if (r === "recorded") {
      stop();
      playRecorded();
    } else if (r === "upload") openPicker();
    else if (r === "phone" || r === "retake") document.getElementById("tear")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  };

  // J pulls the result apart when the result is in view (the hero handles J above it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "j" && e.key !== "J") || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element | null)?.closest?.("input,textarea,select")) return;
      const rr = document.getElementById("result")?.getBoundingClientRect();
      if (rr && rr.top < innerHeight * 0.5 && rr.bottom > innerHeight * 0.3) {
        setJ((v) => (v ? 0 : 1));
        e.preventDefault();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const isLive = state.mode === "live";
  const busy = isLive && (state.status === "running" || state.status === "queued");
  const usesSamplePhoto = !isLive || liveSample;
  const secs = state.result ? (state.result.timings.total / 1000).toFixed(1) : null;

  const honesty = isLive ? (
    <p className="honest">
      {busy && <span className="live-dot" aria-hidden="true" />}
      {state.status === "done" ? `Live run, photo to page in ${secs} s.` : state.status === "error" ? "The live run stopped." : liveSample ? "Live run of the real pipeline, on the same photo." : "Live run of the real pipeline on your photo."}
      {state.status === "done" && state.runId && <Link href={`/r/${state.runId}`}>Permalink</Link>}
      {recorded && (
        <button type="button" className="linkish" onClick={() => onAction("recorded")}>
          Back to the recording
        </button>
      )}
    </p>
  ) : (
    <p className="honest">
      {sample.honesty}
      <button type="button" className="linkish" onClick={() => goLive({ sample: sample.name })} disabled={busy}>
        Run it live
      </button>
    </p>
  );

  let lead: React.ReactNode = null;
  if (state.error) lead = <ErrorNote code={state.error.code} message={state.error.message} onAction={onAction} />;
  else if (isLive && state.status === "queued") lead = <Note title="Waiting for a free slot">{<p>{state.queuePosition} ahead of you. The run starts by itself.</p>}</Note>;
  else if (isLive && run.slow) lead = <Note title="Taking longer than usual">{<p>The models are busy. Partial results stay on screen; nothing is lost.</p>}</Note>;
  else if (!isLive && recordingMissing && !recorded) lead = <Note title="The recording didn’t load">{<p>Run it live instead: the same photo goes through the whole pipeline now.</p>}</Note>;

  const twins = sample.twins ? (STACKS[sample.twins] ?? null) : null;
  const result = state.result;
  const n = state.pieces.length || result?.pieces.length || 0;

  return (
    <main>
      <a className="skip" href="#result">
        Skip to the result
      </a>
      <Hero
        state={state}
        mode={isLive ? "live" : "recorded"}
        runKey={`${isLive ? "live" : "rec"}-${seq}`}
        sample={sample}
        twins={twins}
        reduced={reduced}
        honesty={honesty}
        lead={lead}
        samplePhoto={usesSamplePhoto}
        photoAlt={isLive && !liveSample ? `Your photo${n ? ` of ${n} torn pieces` : ""}, as the run sees it.` : `${sample.title}: the photo the run starts from.`}
      />

      <section className="matters" aria-labelledby="whyh">
        <p className="why-k" id="whyh">
          Why it matters
        </p>
        <p className="why-big">In 30 years, about 600 of 16,000 sacks of hand-torn Stasi files have been rebuilt by hand.</p>
        <p className="why-sm">The federal auditors put the finish at 847 years at this pace. The law asks that victims get their files back in their lifetime. At this pace, they won’t.</p>
      </section>

      <div ref={resultRef} />
      {result && resultOn ? (
        <ResultSection result={result} photoSrc={usesSamplePhoto ? (sample.photo.hires ?? sample.photo.url) : (result.photo.url ?? state.photo?.url ?? null)} J={J} setJ={setJ} />
      ) : (
        <section className="result" id="result" aria-labelledby="rh" aria-busy={busy}>
          <div className="r-head">
            <h2 id="rh">{isLive && !result ? "The page appears here when the run is done." : "Loading the result…"}</h2>
          </div>
        </section>
      )}

      <TearYourOwn
        onPhoto={onPhoto}
        onFile={onFile}
        onSample={() => goLive({ sample: sample.name })}
        disabled={busy}
        footer={
          <footer className="foot">
            <p>
              Untorn, for the Meta AI developer hackathon. {sample.credit} Outlines are SAM 3.1’s real masks; every word shown at a seam is Muse’s real reading from a recorded run; poses are the solver’s.
            </p>
            <p>
              Photos are deleted within 24 hours and never used for training. <Link href="/accuracy">How accurate is it?</Link>
            </p>
          </footer>
        }
      />
    </main>
  );
}
