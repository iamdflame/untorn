"use client";

// The finished run: the rebuilt page (zoomable), the transcript and translation, the join map (both clues per seam),
// the pieces left unplaced, and downloads.

import { useId, useState } from "react";
import type { RunState } from "@/lib/run/state";
import type { JoinOut, PieceOut, RunResult } from "@/lib/run/types";
import { downloadUrl, pointsAttr, polygonBox } from "./geometry";

export function PieceThumb({ piece, photo, size = 56 }: { piece: PieceOut; photo: RunResult["photo"]; size?: number }) {
  const [x0, y0, x1, y1] = polygonBox(piece.polygon);
  const pad = 4;
  const id = `thumb-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="piece-thumb" width={size} height={size} viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} role="img" aria-label={`Piece ${piece.id}`}>
      <defs>
        <clipPath id={id}>
          <polygon points={pointsAttr(piece.polygon)} />
        </clipPath>
      </defs>
      {photo.url ? (
        <image href={photo.url} x={0} y={0} width={photo.width} height={photo.height} preserveAspectRatio="none" clipPath={`url(#${id})`} />
      ) : (
        <polygon points={pointsAttr(piece.polygon)} className="thumb-paper" />
      )}
    </svg>
  );
}

function PageViewer({ result }: { result: RunResult }) {
  const [k, setK] = useState(0);
  const [zoom, setZoom] = useState(1);
  const page = result.pages[k];
  if (!page) return null;
  return (
    <section className="page-viewer" aria-label="The rebuilt page">
      <div className="viewer-bar">
        {result.pages.length > 1 && (
          <div role="tablist" aria-label="Pages">
            {result.pages.map((p, i) => (
              <button key={p.id} role="tab" type="button" aria-selected={i === k} className="btn btn-small" onClick={() => (setK(i), setZoom(1))}>
                Page {i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="zoom" aria-label="Zoom">
          <button type="button" className="btn btn-small" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} aria-label="Zoom out">
            −
          </button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-small" onClick={() => setZoom((z) => Math.min(4, z * 1.5))} disabled={zoom >= 4} aria-label="Zoom in">
            +
          </button>
        </div>
      </div>
      <div className="page-scroll" tabIndex={0} aria-label="Rebuilt page, scrollable when zoomed">
        {page.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={page.image}
            alt={`Rebuilt page ${k + 1}: ${page.pieces.length} pieces joined`}
            style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none" }}
            onClick={() => setZoom((z) => (z >= 4 ? 1 : z * 1.5))}
          />
        ) : (
          <p className="muted">The page image wasn&apos;t stored.</p>
        )}
      </div>
      <p className="page-meta">
        {page.pieces.length} pieces · completeness {Math.round(page.completeness * 100)}% · confidence {Math.round(page.confidence * 100)}%
      </p>
    </section>
  );
}

function Transcript({ result }: { result: RunResult }) {
  const [view, setView] = useState<"text" | "translation">("text");
  if (!result.transcripts.length) return null;
  return (
    <section className="transcript" aria-label="Transcript">
      <h3 className="panel-title">What the page says</h3>
      {result.transcripts.map((t, i) => (
        <div key={t.page} className="transcript-page">
          {result.transcripts.length > 1 && <h4>Page {i + 1}</h4>}
          {!t.ok ? (
            <p className="muted">Muse couldn&apos;t read this page this time.</p>
          ) : (
            <>
              {t.translation && (
                <div role="tablist" aria-label="Transcript or translation" className="viewer-bar">
                  <button type="button" role="tab" aria-selected={view === "text"} className="btn btn-small" onClick={() => setView("text")}>
                    Original ({t.language})
                  </button>
                  <button type="button" role="tab" aria-selected={view === "translation"} className="btn btn-small" onClick={() => setView("translation")}>
                    English
                  </button>
                </div>
              )}
              <pre className="transcript-text" lang={view === "translation" ? "en" : t.language}>
                {markGaps(view === "translation" && t.translation ? t.translation.text : t.text)}
              </pre>
              {!t.translation && <p className="muted small">Language: {t.language}. Gaps where paper is missing are marked […]; nothing is filled in.</p>}
              {t.uncertain.length > 0 && <p className="muted small">Uncertain readings: {t.uncertain.join(", ")}</p>}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

function markGaps(text: string) {
  return text.split(/(\[…\])/g).map((part, i) =>
    part === "[…]" ? (
      <mark key={i} className="gap" title="Missing or illegible: left as a gap">
        […]
      </mark>
    ) : (
      part
    ),
  );
}

const DECIDED: Record<JoinOut["decidedBy"], string> = {
  geometry: "shape",
  "geometry+content": "shape + reading",
  content: "reading broke a tie",
};

function JoinMap({ result }: { result: RunResult }) {
  const pieces = new Map(result.pieces.map((p) => [p.id, p] as const));
  if (!result.joins.length) return null;
  return (
    <section className="join-map" aria-label="Join map">
      <h3 className="panel-title">Join map: the two clues behind every join</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Pieces</th>
              <th scope="col">Shape fit</th>
              <th scope="col">What Muse read across</th>
              <th scope="col">Decided by</th>
            </tr>
          </thead>
          <tbody>
            {result.joins.map((j) => (
              <tr key={j.candidate} data-decided={j.decidedBy} data-read={!j.read ? "none" : j.read.agrees === null ? "unsure" : j.read.agrees ? "agrees" : "disagrees"}>
                <td data-label="Pieces">
                  <span className="pair">
                    {pieces.get(j.a) && <PieceThumb piece={pieces.get(j.a)!} photo={result.photo} size={36} />}
                    {pieces.get(j.b) && <PieceThumb piece={pieces.get(j.b)!} photo={result.photo} size={36} />}
                    <span>
                      {j.a}–{j.b}
                    </span>
                  </span>
                </td>
                <td data-label="Shape fit">
                  {Math.round(j.shape.score)} px of seam · {j.shape.rms.toFixed(2)} px misfit · {Math.round(j.shape.confidence * 100)}%
                </td>
                <td data-label="Muse read">
                  {j.read ? (
                    <>
                      {j.read.words.length ? j.read.words.map((w) => `“${w}”`).join(" · ") : "no words"}{" "}
                      {j.read.agrees === null ? (
                        <span className="muted">(too little text to tell)</span>
                      ) : (
                        <>
                          <span aria-hidden>{j.read.agrees ? "✓" : "✗"}</span>
                          <span className="sr-only">{j.read.agrees ? "agrees" : "disagrees"}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="muted">not read at this placement</span>
                  )}
                </td>
                <td data-label="Decided by">{DECIDED[j.decidedBy]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Unplaced({ result }: { result: RunResult }) {
  if (!result.unplaced.length) return null;
  const why = { "no-match": "no edge fitted", "twin-unresolved": "twins couldn't be told apart", rejected: "a fit was found but the clues disagreed" } as const;
  return (
    <section className="unplaced" aria-label="Pieces left unplaced">
      <h3 className="panel-title">Left unplaced, never forced</h3>
      <ul>
        {result.unplaced.map((u) => {
          const p = result.pieces.find((x) => x.id === u.id);
          return (
            <li key={u.id}>
              {p && <PieceThumb piece={p} photo={result.photo} size={44} />} {u.id}: {why[u.reason]}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Downloads({ result }: { result: RunResult }) {
  const json = result.source === "sample" && result.photo.url?.startsWith("/samples/") ? result.photo.url.replace(/photo\.jpg$/, "result.json") : `/api/runs/${result.runId}?download=1`;
  return (
    <section className="downloads" aria-label="Downloads">
      {result.pages.map(
        (p, i) =>
          p.image && (
            <a key={p.id} className="btn" href={downloadUrl(p.image)} download={`untorn-${result.runId}-page-${i + 1}.png`}>
              Page {result.pages.length > 1 ? i + 1 : ""} (PNG)
            </a>
          ),
      )}
      <a className="btn" href={json} download={`untorn-${result.runId}.json`}>
        Run data (JSON)
      </a>
      <span className="muted small">
        {result.timings.total ? `${(result.timings.total / 1000).toFixed(1)} s` : ""} · model cost ${result.cost.usd.toFixed(2)}
      </span>
    </section>
  );
}

export function ResultView({ state }: { state: RunState }) {
  const r = state.result;
  if (!r) return null;
  return (
    <div className="result" data-pages={r.pages.length}>
      {r.pages.length ? <PageViewer result={r} /> : <p className="muted">No two pieces could be joined with confidence. The pieces are shown as found.</p>}
      <div className="result-side">
        <Transcript result={r} />
        <Downloads result={r} />
      </div>
      <JoinMap result={r} />
      <Unplaced result={r} />
    </div>
  );
}
