"use client";

// The first screen: the product already working. A recorded run of the real pipeline plays on the sample photo
// (labelled as recorded); "Run it live" sends the same photo through the pipeline now; "Tear your own" takes a phone
// photo or an upload. Live and recorded runs fold through the same reducer and are drawn by the same hero.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Recovery } from "@/lib/run/errors";
import { DEFAULT_SAMPLE, SAMPLES, STACKS, type Sample } from "@/lib/run/samples";
import type { RunResult } from "@/lib/run/types";
import { Hero } from "./hero/Hero";
import { ErrorNote, Note } from "./hero/LeadNote";
import { useNearOrIdle, usePrefersReducedMotion } from "./hooks";
import dynamic from "next/dynamic";
import { useRun, type LiveInput } from "./run/useRun";
import { openPicker, TearYourOwn } from "./TearYourOwn";

/** The sample in another language, offered under "Run the sample live". */
const GERMAN_SAMPLE = "stresemann-1922";
/** A real hand tear (a recorded live run), offered beside every simulated one. */
const REAL_SAMPLE = "hand-torn-6";

// below the fold: its code loads when it is needed
const ResultSection = dynamic(() => import("./result/ResultSection").then((m) => m.ResultSection), { ssr: false });

/** `openWeights`: the server can read on Meta's open weights, so the visitor may ask for that alone. */
export function FirstScreen({ sample: initial, openWeights = false }: { sample: Sample; openWeights?: boolean }) {
  const [openOnly, setOpenOnly] = useState(false);
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
  // Meta's API refused our key (no credit left, say): live runs go on (the paper finder outlines the pieces, the open
  // weights read them when their host answers: src/lib/server/live.ts), and the page says how before anyone tears a page
  const [livePaused, setLivePaused] = useState(false);
  const [liveMode, setLiveMode] = useState<"ok" | "open-weights" | "outlines-only">("ok");
  const [openAnswers, setOpenAnswers] = useState(true);
  const lastInput = useRef<LiveInput | null>(null);
  // the result is below the fold: build it once it's near, or once the page is idle
  const resultRef = useRef<HTMLDivElement>(null);
  const resultOn = useNearOrIdle(resultRef);

  // warm the functions, then load the recording
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health?warm=1", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ live?: string; openWeights?: boolean }>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (j.live === "paused") setLivePaused(true);
        else if (j.live === "open-weights" || j.live === "outlines-only") setLiveMode(j.live);
        if (j.openWeights === false) setOpenAnswers(false);
      })
      .catch(() => {});
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
    (asked: LiveInput) => {
      const input: LiveInput = openWeights && openAnswers && openOnly ? { ...asked, reader: "open" } : asked;
      started.current = true; // a late-loading recording must not replace a live run
      lastInput.current = input;
      setLiveSample("sample" in input);
      setSeq((n) => n + 1);
      setJ(0);
      document.getElementById("top")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      void live(input);
    },
    [live, reduced, openWeights, openAnswers, openOnly],
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

  const pausedNow = livePaused || state.error?.code === "paused";
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
      {pausedNow ? (
        <span className="paused-note">Live runs are paused just now.</span>
      ) : (
        <button type="button" className="linkish" onClick={() => goLive({ sample: sample.name })} disabled={busy}>
          Run it live
        </button>
      )}
      {liveMode !== "ok" && !pausedNow && (
        <span className="paused-note">
          {liveMode === "open-weights"
            ? "Meta’s API isn’t taking our key just now: live runs find the pieces themselves and read them with Meta’s open weights."
            : "Meta’s API isn’t taking our key just now: live runs find the pieces themselves and place them by their edges, without reading them."}
        </span>
      )}
      {sample.name !== REAL_SAMPLE && SAMPLES[REAL_SAMPLE] && <a href={`/?sample=${REAL_SAMPLE}`}>A real tear</a>}
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
        <p className="why-big">3.5 million people have asked to read their Stasi files. 15,400 sacks of those files are still in pieces.</p>
        <p className="why-sm">
          The Stasi tore them up by hand in 1989 and 1990. In 30 years, about 600 sacks have been pieced back together by hand; at that pace, the federal auditors say, the rest would take 847 years. Since 2021 the law has made it the Federal Archives’ task, in the hope that victims get their files in their lifetime.
        </p>
      </section>

      <div ref={resultRef} />
      {result && resultOn ? (
        <ResultSection result={result} catalogs={state.catalogs} photoSrc={usesSamplePhoto ? (sample.photo.hires ?? sample.photo.url) : (result.photo.url ?? state.photo?.url ?? null)} J={J} setJ={setJ} />
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
        others={[
          ...(sample.name !== REAL_SAMPLE ? [{ lead: "Torn by hand:", label: "a printed page in 6 pieces, from a live run", href: `/?sample=${REAL_SAMPLE}` }] : []),
          ...(sample.name !== GERMAN_SAMPLE ? [{ lead: "It reads other languages too:", label: "a German letter of 1922, read and translated", href: `/?sample=${GERMAN_SAMPLE}` }] : []),
          ...(sample.name !== DEFAULT_SAMPLE ? [{ lead: "Or the first screen's letter:", label: "a letter of 1927", href: "/" }] : []),
        ]}
        disabled={busy}
        paused={pausedNow}
        reader={openWeights && openAnswers ? { open: openOnly, onChange: setOpenOnly } : undefined}
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
