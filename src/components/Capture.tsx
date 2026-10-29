"use client";

// The phone page (/c/<code>): a top-down guide, one photo with the camera, a check with the guide over it, then send.
// Phone-first; works with any browser that can pick a photo.

import { useEffect, useRef, useState } from "react";
import { PhotoError, preparePhoto, responseError } from "@/lib/client/photo";
import { ERRORS } from "@/lib/run/errors";
import type { ErrorCode } from "@/lib/run/types";

type Step = { kind: "checking" } | { kind: "ready" } | { kind: "preview"; file: File; url: string } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; code: ErrorCode; message?: string; retry?: File };

export const PRIVACY_LINE = "Photos are deleted within 24 hours and never used for training.";

function Guide({ children }: { children?: React.ReactNode }) {
  return (
    <div className="capture-guide">
      {children}
      <svg viewBox="0 0 300 400" aria-hidden className="guide-frame">
        <rect x="18" y="18" width="264" height="364" rx="6" fill="none" strokeDasharray="10 8" />
        <path d="M18 70 V18 H70 M230 18 H282 V70 M282 330 V382 H230 M70 382 H18 V330" fill="none" strokeWidth="4" />
      </svg>
    </div>
  );
}

export function Capture({ code }: { code: string }) {
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${code}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as { status?: string; error?: { code?: ErrorCode } };
        if (cancelled) return;
        if (!r.ok) setStep({ kind: "error", code: j.error?.code ?? "not-found" });
        else if (j.status === "expired") setStep({ kind: "error", code: "expired" });
        else setStep({ kind: "ready" });
      })
      .catch(() => !cancelled && setStep({ kind: "ready" }));
    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => () => (step.kind === "preview" ? URL.revokeObjectURL(step.url) : undefined), [step]);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) setStep({ kind: "preview", file: f, url: URL.createObjectURL(f) });
  };

  const send = async (file: File) => {
    setStep({ kind: "sending" });
    try {
      const blob = await preparePhoto(file);
      const form = new FormData();
      form.set("photo", blob, "photo");
      const res = await fetch(`/api/sessions/${code}/photo`, { method: "POST", body: form });
      if (!res.ok) throw await responseError(res);
      setStep({ kind: "sent" });
    } catch (e) {
      if (e instanceof PhotoError) setStep({ kind: "error", code: e.code, message: e.message, retry: e.code === "internal" ? file : undefined });
      else setStep({ kind: "error", code: "network", retry: file });
    }
  };

  const camera = (
    <>
      <label className={step.kind === "preview" ? "btn" : "cta tab"}>
        <span>{step.kind === "preview" ? "Take it again" : "Take the photo"}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
    </>
  );

  return (
    <main className="capture" data-step={step.kind}>
      <header className="page-rail">
        <span className="mark">
          Un<span className="bar" aria-hidden="true" />
          torn
        </span>
        <span className="code" aria-label={`Code ${code}`}>
          {code}
        </span>
      </header>
      {step.kind === "checking" && <p role="status">Checking the code…</p>}
      {step.kind === "ready" && (
        <section aria-labelledby="cap-title">
          <h1 id="cap-title">One photo of the torn pieces</h1>
          <Guide>
            <ul className="guide-tips">
              <li>Spread the pieces on a dark, plain table, not touching.</li>
              <li>Hold the phone flat, straight above them.</li>
              <li>Fill the frame; avoid glare and shadows.</li>
            </ul>
          </Guide>
          {camera}
        </section>
      )}
      {step.kind === "preview" && (
        <section aria-labelledby="cap-check">
          <h1 id="cap-check">Check the photo</h1>
          <Guide>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.url} alt="The photo you took" className="capture-preview" />
          </Guide>
          <p className="muted">All pieces inside, sharp, and seen from straight above?</p>
          <div className="actions">
            <button type="button" className="cta tab" onClick={() => send(step.file)}>
              <span>Send to the laptop</span>
            </button>
            {camera}
          </div>
        </section>
      )}
      {step.kind === "sending" && (
        <p role="status" className="capture-status">
          Sending…
        </p>
      )}
      {step.kind === "sent" && (
        <section role="status" className="capture-status">
          <h1>Sent</h1>
          <p>Watch the laptop: the pieces are being put back together.</p>
          <button type="button" className="btn" onClick={() => setStep({ kind: "ready" })}>
            Send another photo
          </button>
        </section>
      )}
      {step.kind === "error" && (
        <section role="alert" className="error-block">
          <h1>{ERRORS[step.code]?.title ?? ERRORS.internal.title}</h1>
          <p>{step.message ?? ERRORS[step.code]?.message}</p>
          <div className="actions">
            {step.retry && (
              <button type="button" className="cta tab" onClick={() => send(step.retry!)}>
                <span>Try again</span>
              </button>
            )}
            {step.code !== "expired" && step.code !== "not-found" ? (
              <button type="button" className="btn" onClick={() => setStep({ kind: "ready" })}>
                Take the photo again
              </button>
            ) : (
              <p>Make a new code on the laptop and scan it again, or upload the photo on the laptop directly.</p>
            )}
          </div>
        </section>
      )}
      <p className="privacy">{PRIVACY_LINE}</p>
    </main>
  );
}
