"use client";

// "Tear your own": a QR code (and the code in text) for the phone, polled every 1.5 s, plus a drop zone for a photo
// already on this computer. Either way, the parent starts a live run.

import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { ERRORS } from "@/lib/run/errors";
import type { ErrorCode } from "@/lib/run/types";

type Session = { code: string; url: string; expiresAt: string };
type Phase = { kind: "idle" } | { kind: "creating" } | { kind: "waiting"; session: Session; svg: string } | { kind: "expired" } | { kind: "error"; code: ErrorCode };

export const POLL_MS = 1500;

export function TearYourOwn({ onPhoto, onFile, disabled }: { onPhoto: (photoId: string) => void; onFile: (file: File) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const create = useCallback(async () => {
    setPhase({ kind: "creating" });
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { code?: ErrorCode } } | null;
        return setPhase({ kind: "error", code: j?.error?.code ?? "internal" });
      }
      const session = (await res.json()) as Session;
      const svg = await QRCode.toString(session.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      setPhase({ kind: "waiting", session, svg });
    } catch {
      setPhase({ kind: "error", code: "network" });
    }
  }, []);

  // poll the session until the phone's photo lands
  const code = phase.kind === "waiting" ? phase.session.code : null;
  useEffect(() => {
    if (!code) return;
    let stopped = false;
    let failures = 0;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/sessions/${code}`, { cache: "no-store" });
        const j = (await res.json()) as { status?: string; photoId?: string };
        if (stopped) return;
        failures = 0;
        if (j.status === "photo" && j.photoId) {
          stopped = true;
          setPhase({ kind: "idle" });
          onPhoto(j.photoId);
          return;
        }
        if (j.status === "expired" || res.status === 404) {
          stopped = true;
          setPhase({ kind: "expired" });
          return;
        }
      } catch {
        if (++failures > 20) {
          stopped = true;
          setPhase({ kind: "error", code: "network" });
          return;
        }
      }
      timer = setTimeout(poll, POLL_MS);
    };
    let timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, onPhoto]);

  const take = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  return (
    <section className="tear-your-own" id="tear" aria-labelledby="tear-title">
      <h2 id="tear-title">Tear your own</h2>
      <p>Tear a page, spread the pieces on a dark table, and take one photo from straight above.</p>
      <div className="tear-grid">
        <div className="tear-phone">
          <h3>With your phone</h3>
          {phase.kind === "waiting" ? (
            <>
              <div className="qr" role="img" aria-label={`QR code for ${phase.session.url}`} dangerouslySetInnerHTML={{ __html: phase.svg }} />
              <p>
                Scan it, or open <strong className="mono">{phase.session.url.replace(/^https?:\/\//, "")}</strong>
              </p>
              <p>
                Code <strong className="mono code">{phase.session.code}</strong> · waiting for the photo…
              </p>
            </>
          ) : phase.kind === "expired" ? (
            <>
              <p>That code expired.</p>
              <button type="button" className="btn" onClick={create} disabled={disabled}>
                Make a new code
              </button>
            </>
          ) : phase.kind === "error" ? (
            <>
              <p role="alert">{ERRORS[phase.code]?.title ?? ERRORS.internal.title}. You can still upload a photo here.</p>
              <button type="button" className="btn" onClick={create} disabled={disabled}>
                Try again
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={create} disabled={disabled || phase.kind === "creating"}>
              {phase.kind === "creating" ? "Making a code…" : "Show a QR code"}
            </button>
          )}
        </div>
        <div
          className="tear-drop"
          data-dragging={dragging ? "" : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled) take(e.dataTransfer.files);
          }}
        >
          <h3>Or a photo on this computer</h3>
          <p>Drop it here (JPEG, PNG or HEIC, up to 15 MB).</p>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={disabled}>
            Choose a photo
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/heic,image/heif,image/webp,.heic,.heif"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a photo of torn pieces"
            onChange={(e) => {
              take(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <p className="muted small">Photos are deleted within 24 hours and never used for training.</p>
    </section>
  );
}

/** Open the file picker of the drop zone (used by error recovery). */
export function openPicker() {
  document.querySelector<HTMLInputElement>(".tear-drop input[type=file]")?.click();
}
