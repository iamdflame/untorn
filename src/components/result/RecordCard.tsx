"use client";

// The archive record of a rebuilt page: what Muse Wonder catalogued from the transcript, each name and date with the
// page's own words beside it when they differ. Only checked fields arrive here (src/lib/server/record.ts). The
// provenance row takes a spoken note: Muse Voice Transcribe writes down where the page was found.

import { useEffect, useRef, useState } from "react";
import { NOTE_MAX_S, toWav } from "@/lib/client/wav";
import type { CatalogOut, RecordField, SpokenNote } from "@/lib/run/types";
import { differsFromQuote, KIND_LABEL, recordDate } from "@/lib/run/record-view";

function Name({ f }: { f: RecordField }) {
  return (
    <span className="rec-name">
      {f.name}
      {differsFromQuote(f.name, f.quote) && <span className="as">“{f.quote.replace(/\s+/g, " ")}”</span>}
    </span>
  );
}

function Names({ list }: { list: RecordField[] }) {
  return (
    <ul className="rec-list">
      {list.map((f) => (
        <li key={f.quote}>
          <Name f={f} />
        </li>
      ))}
    </ul>
  );
}

/** Record a note in the browser (up to a minute), turn it into WAV, and have /api/notes transcribe it. */
function VoiceNote({ note, onNote }: { note: SpokenNote | null; onNote: (n: SpokenNote | null) => void }) {
  const [state, setState] = useState<"idle" | "asking" | "recording" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; timer: number } | null>(null);

  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      r.mr.onstop = null;
      if (r.mr.state !== "inactive") r.mr.stop();
      r.stream.getTracks().forEach((t) => t.stop());
      clearInterval(r.timer);
    },
    [],
  );

  const send = async (clip: Blob) => {
    setState("sending");
    try {
      const wav = await toWav(clip);
      const form = new FormData();
      form.set("audio", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "note.wav");
      const res = await fetch("/api/notes", { method: "POST", body: form });
      const j = (await res.json().catch(() => null)) as (SpokenNote & { error?: { message?: string } }) | null;
      if (!res.ok || !j?.text) throw new Error(j?.error?.message ?? "The note couldn’t be written down. Try again.");
      onNote({ text: j.text, audioMs: j.audioMs, ms: j.ms, costUsd: j.costUsd, model: j.model });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The note couldn’t be written down. Try again.");
    }
    setState("idle");
  };

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can’t record audio.");
      return;
    }
    setState("asking");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setState("idle");
      setError("Allow the microphone to record a note.");
      return;
    }
    const mr = new MediaRecorder(stream, { audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (rec.current) clearInterval(rec.current.timer);
      rec.current = null;
      void send(new Blob(chunks, { type: mr.mimeType }));
    };
    const t0 = Date.now();
    const timer = window.setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      setSecs(Math.floor(s));
      if (s >= NOTE_MAX_S && mr.state === "recording") mr.stop();
    }, 250);
    rec.current = { mr, stream, timer };
    setSecs(0);
    mr.start();
    setState("recording");
  };
  const stop = () => {
    if (rec.current?.mr.state === "recording") rec.current.mr.stop();
  };

  if (state === "recording")
    return (
      <div className="note">
        <button type="button" className="btn note-btn rec-on" onClick={stop} aria-label={`Stop recording, ${secs} seconds`}>
          <span className="dot" aria-hidden="true" />
          Stop <span className="t">{`0:${String(secs).padStart(2, "0")}`}</span>
        </button>
        <p className="note-hint">Listening. Say where the page was found: box, folder, place, date.</p>
      </div>
    );
  return (
    <div className="note">
      {note && state !== "sending" && (
        <>
          <p className="note-text">{note.text}</p>
          <p className="note-hint">
            Spoken, and written down by Muse Voice Transcribe in {(note.ms / 1000).toFixed(1)} s. The recording isn’t kept.{" "}
            <button type="button" className="linkish" onClick={() => onNote(null)}>
              Clear
            </button>
          </p>
        </>
      )}
      {!note && (
        <button type="button" className="btn note-btn" onClick={start} disabled={state !== "idle"}>
          <MicIcon />
          {state === "sending" ? "Writing it down…" : state === "asking" ? "Allow the microphone…" : "Say where it came from"}
        </button>
      )}
      {!note && state === "idle" && !error && <p className="note-hint">Archives record where every page was found. Say it; Muse Voice Transcribe writes it into the record.</p>}
      {error && (
        <p className="note-hint err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5ZM5 9.5a5 5 0 0 0 10 0M10 14.5v3M7 17.5h6" />
    </svg>
  );
}

export function RecordCard({ catalog, note, onNote }: { catalog: CatalogOut; note: SpokenNote | null; onNote: (n: SpokenNote | null) => void }) {
  if (catalog.status === "pending")
    return (
      <div className="r-rec" aria-live="polite" aria-busy="true">
        <h3>Archive record</h3>
        <p className="rec-wait">Muse Wonder is cataloguing the page from its transcript…</p>
      </div>
    );
  if (catalog.status === "failed" || !catalog.record)
    return (
      <div className="r-rec" aria-live="polite">
        <h3>Archive record</h3>
        <p className="r-note">Muse Wonder couldn’t catalogue this page this time. The transcript above is complete.</p>
      </div>
    );
  const r = catalog.record;
  const date = recordDate(r);
  const rows: [string, React.ReactNode][] = [["Kind", KIND_LABEL[r.kind]]];
  if (date)
    rows.push([
      "Date",
      <span key="d" className="rec-name">
        {date}
        {r.date && r.date.iso && differsFromQuote(date, r.date.quote) && <span className="as">“{r.date.quote}”</span>}
      </span>,
    ]);
  if (r.place) rows.push(["Written at", <Name key="p" f={r.place} />]);
  if (r.from) rows.push(["From", <Name key="f" f={r.from} />]);
  if (r.to) rows.push(["To", <Name key="t" f={r.to} />]);
  if (r.people.length) rows.push(["People", <Names key="pe" list={r.people} />]);
  if (r.places.length) rows.push(["Places", <Names key="pl" list={r.places} />]);
  if (r.organisations.length) rows.push(["Organisations", <Names key="o" list={r.organisations} />]);
  rows.push(["Found", <VoiceNote key="n" note={note} onNote={onNote} />]);
  const secs = catalog.ms ? ` in ${(catalog.ms / 1000).toFixed(1)} s` : "";
  return (
    <div className="r-rec" aria-live="polite">
      <h3>Archive record</h3>
      <dl className="rec">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {r.summary && <p className="rec-sum">{r.summary}</p>}
      <p className="r-note">
        Catalogued by Muse Wonder from the transcript{secs}. Every name and date quotes the page, and Untorn checked each quote against the transcript
        {catalog.dropped ? `; ${catalog.dropped === 1 ? "one that didn’t match was" : `${catalog.dropped} that didn’t match were`} left out` : ""}. The summary is Muse’s own words.
      </p>
    </div>
  );
}
