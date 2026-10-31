"use client";

// The first screen's stage: the run drawn on a light table in a dim room (see engine.ts), the torn headline that
// rejoins as the pieces come home, one sentence, the paper-tab "Tear your own", and the honesty line. React renders
// the structure once; the engine moves it.

import { useEffect, useMemo, useRef } from "react";
import { PHOTO_SIZES, type Sample, type StackTrial } from "@/lib/run/samples";
import { currentStage, type RunState } from "@/lib/run/state";
import type { EngineInput, HeroApi } from "./engine";

export type HeroMode = "recorded" | "live" | "replay";

const H1 = (
  <>
    Every torn<br className="bd" /> page,<br className="bp" /> whole<br className="bd" /> again.
  </>
);

function srcSet(sample: Sample) {
  return sample.photo.sources?.map((s) => `${s.url} ${s.w}w`).join(", ");
}


export function Hero({
  state,
  mode,
  runKey,
  sample,
  twins,
  reduced,
  honesty,
  lead,
  photoAlt,
  samplePhoto,
}: {
  state: RunState;
  mode: HeroMode;
  /** Changes when a new run starts (restarts the clock). */
  runKey: string;
  sample: Sample | null;
  twins: StackTrial | null;
  reduced: boolean;
  /** The honesty line, with its action ("Run it live"). */
  honesty: React.ReactNode;
  /** Replaces the deck (errors, live notes). */
  lead?: React.ReactNode;
  photoAlt: string;
  /** This run's photo is the sample's (use its full-resolution copy). */
  samplePhoto: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const api = useRef<HeroApi | null>(null);

  const latest = useRef<EngineInput | null>(null);
  const reducedRef = useRef(reduced);
  // the engine loads after the first paint (the headline and the blur-up are the first screen); the stage photo starts
  // loading at the same time (the engine asks for the same srcset and sizes, so the browser reuses the response)
  const warmSrcset = sample?.photo.sources ? srcSet(sample) : null;
  useEffect(() => {
    if (!warmSrcset) return;
    const im = new Image();
    im.sizes = PHOTO_SIZES;
    im.srcset = warmSrcset;
  }, [warmSrcset]);
  useEffect(() => {
    let h: HeroApi | null = null;
    let gone = false;
    import("./engine").then(({ createHero }) => {
      if (gone || !root.current) return;
      h = createHero(root.current, { reduced: reducedRef.current });
      api.current = h;
      if (latest.current) h.update(latest.current);
    });
    return () => {
      gone = true;
      h?.destroy();
      api.current = null;
    };
  }, []);
  useEffect(() => {
    reducedRef.current = reduced;
    api.current?.setReduced(reduced);
  }, [reduced]);

  // the photo the paper is cut from: the sample's full-resolution copy when this run is of a sample, else the run's
  const fromSample = !!sample && samplePhoto;
  const photoSrc = fromSample && sample ? (sample.photo.hires ?? sample.photo.url) : (state.photo?.url ?? null);
  const pw = state.photo?.width ?? sample?.photo.width ?? 0;
  const ph = state.photo?.height ?? sample?.photo.height ?? 0;
  const tr = state.transcripts.find((x) => x.ok);
  const transcript = tr?.text ?? null;
  // a page in another language: the stage shows Muse's English translation (the result keeps both)
  const translationText = tr?.translation && tr.language !== tr.translation.to ? tr.translation.text : null;
  const translationFrom = translationText ? (tr?.language ?? null) : null;
  const stage = currentStage(state);

  const input = useMemo<EngineInput>(
    () => ({
      key: runKey,
      mode,
      photo: photoSrc && pw ? { src: photoSrc, width: pw, height: ph, stage: fromSample && sample?.photo.sources ? { srcset: srcSet(sample)!, sizes: PHOTO_SIZES } : null } : null,
      pieces: state.pieces,
      pages: state.pages,
      joins: state.joins,
      reads: state.reads,
      transcript,
      translation: translationText && translationFrom ? { text: translationText, from: translationFrom } : null,
      progress: { stage, asks: state.asks.length, done: state.status === "done", failed: state.status === "error" },
      twins: mode === "recorded" ? twins : null,
    }),
    [runKey, mode, photoSrc, pw, ph, fromSample, sample, state.pieces, state.pages, state.joins, state.reads, transcript, translationText, translationFrom, stage, state.asks.length, state.status, twins],
  );
  useEffect(() => {
    latest.current = input;
    api.current?.update(input);
  }, [input]);

  const showPlaceholder = mode === "recorded" && sample;
  return (
    <section ref={root} className="hero" id="top" aria-labelledby="h1" data-mode={mode}>
      {showPlaceholder && sample.photo.lqip && (
        // a blur-up of the photo, painted with the HTML; the canvas covers it with the real pixels as soon as they load
        // eslint-disable-next-line @next/next/no-img-element
        <img className="hero-photo" src={sample.photo.lqip} alt={photoAlt} width={240} height={180} />
      )}
      <canvas className="plate" aria-hidden="true" />
      {!showPlaceholder && <p className="sr">{photoAlt}</p>}

      <header className="rail">
        <a className="mark" href="#top" aria-label="Untorn, home">
          Un<span className="bar" aria-hidden="true" />torn
        </a>
        <a className="rail-cta" href="#tear">
          Tear your own
        </a>
      </header>

      <div className="lead">
        <h1 className="torn" id="h1">
          <span className="sr">Every torn page, whole again.</span>
          <span className="half hl" aria-hidden="true">
            {H1}
          </span>
          <span className="half hr" aria-hidden="true">
            {H1}
          </span>
          <svg className="tseam" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
            <path vectorEffect="non-scaling-stroke" d="" />
          </svg>
        </h1>
        <div className="swap">
          <div className="intro">
            {lead ?? (
              <p className="deck">
                <span className="dk">Untorn rebuilds a torn page from one photo: SAM&nbsp;3.1 cuts out every piece, and Muse reads the half-letters across each tear.</span>
                <span className="dp">SAM&nbsp;3.1 cuts the pieces. Muse reads across the tears.</span>
              </p>
            )}
          </div>
          <div className="tx" aria-live="off">
            <p className="tx-h">Muse read the page</p>
            <p className="tx-body" />
            <a className="tx-more" href="#result">
              Read the transcript
            </a>
          </div>
        </div>
        <div className="act">
          <a className="cta tab" href="#tear">
            <span>Tear your own</span>
          </a>
          <p className="status" role="status" aria-live="polite" />
        </div>
      </div>

      <div className="reading" aria-live="polite">
        <p className="rd-word" />
        <p className="rd-note" />
      </div>

      <div className="m-area" aria-hidden="true" />
      <div className="m-center" aria-hidden="true" />
      <div className="m-proof" aria-hidden="true" />

      <div className="stagebar">
        {honesty}
        <div className="ctrl" role="group" aria-label="Run controls">
          <button type="button" className="ib btn-prev" aria-label="Previous step (left arrow)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 4.5 7 10l5.5 5.5" />
            </svg>
          </button>
          <button type="button" className="ib btn-play" aria-label="Pause (space)">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="i-pause">
              <path d="M7.5 5v10M12.5 5v10" />
            </svg>
            <svg viewBox="0 0 20 20" aria-hidden="true" className="i-play">
              <path d="M7 4.8v10.4L15 10z" />
            </svg>
          </button>
          <button type="button" className="ib btn-next" aria-label="Next step (right arrow)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7.5 4.5 13 10l-5.5 5.5" />
            </svg>
          </button>
          <button type="button" className="ib jb btn-j" aria-pressed="false" aria-label="Join map (J)">
            <kbd>J</kbd>
          </button>
        </div>
      </div>

      {twins && mode === "recorded" && <Twins d={twins} />}

      <div className="climax" aria-hidden="true">
        <p className="cl-word">
          <span className="cl-l" />
          <i className="cl-bar" />
          <span className="cl-r" />
        </p>
        <p className="cl-why" />
        <p className="cl-cell" />
      </div>
    </section>
  );
}

function Twins({ d }: { d: StackTrial }) {
  const split = (w: string) => {
    const [l, r] = w.split("|");
    return (
      <span className="w" key={w}>
        {l}
        <i className="bar" />
        {r}
      </span>
    );
  };
  const { trials, correct, chance } = d.summary;
  return (
    <figure className="twins" aria-label="Stack trial: three scraps with the same torn edge">
      <figcaption className="tw-cap">
        <strong className="tw-q">
          These three scraps have the same torn edge. <span>Only one belongs here. Which?</span>
        </strong>
      </figcaption>
      <div className="tw-stage">
        {/* the scraps are painted into canvases when the beat comes (late images would read as the page's largest paint) */}
        <canvas className="tw tw-L" data-src={d.images.L.url} role="img" aria-label="The piece on the page, its torn edge waiting for a scrap" width={d.images.L.w} height={d.images.L.h} />
        {(["A", "B", "C"] as const).map((k) => (
          <button key={k} type="button" className="tw tw-c" data-k={k} aria-label={`Scrap ${k}`} tabIndex={-1} style={{ width: d.images[k].w, height: d.images[k].h }}>
            <canvas data-src={d.images[k].url} aria-hidden="true" width={d.images[k].w} height={d.images[k].h} />
            <svg viewBox={`0 0 ${d.images[k].w} ${d.images[k].h}`} aria-hidden="true">
              <path className="strike" pathLength={100} d={`M6 ${d.images[k].h - 10} 58 8`} />
            </svg>
            <span className="tag">{k}</span>
          </button>
        ))}
        <svg className="tw-ov" aria-hidden="true">
          {d.rings.map((_, i) => (
            <circle key={i} className="ring" r="17" />
          ))}
        </svg>
      </div>
      <div className="tw-foot">
        <p className="tw-msg" aria-live="polite" />
        <p className="tw-verdict">
          <strong>
            Only {d.choice} makes words:{" "}
            {d.words.map((w, i) => (
              <span key={w}>
                {i > 0 && ", "}
                {split(w)}
              </span>
            ))}
            .
          </strong>
          <span className="tw-why">
            The edge is a three-way tie; reading decides. In {trials} stack trials Muse picked the right scrap {correct === trials ? `all ${trials} times` : `${correct} times`}; chance is 1&nbsp;in&nbsp;{chance}.
          </span>
          <span className="note">{d.label}</span>
        </p>
      </div>
    </figure>
  );
}
