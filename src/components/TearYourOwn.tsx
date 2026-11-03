"use client";

// "Tear your own": a QR code (and the code in text) for the phone, polled every 1.5 s, plus a drop zone for a photo
// already on this computer. Either way, the parent starts a live run.

import { useCallback, useEffect, useRef, useState } from "react";
import { ERRORS } from "@/lib/run/errors";
import type { ErrorCode } from "@/lib/run/types";

type Session = { code: string; url: string; expiresAt: string };
type Phase = { kind: "idle" } | { kind: "creating" } | { kind: "waiting"; session: Session; svg: string } | { kind: "expired" } | { kind: "error"; code: ErrorCode };

export const POLL_MS = 1500;

/**
 * `others`: links to the other samples (a real tear, another language), under "Run the sample live".
 * `reader`: the choice to read on Meta's open weights alone, where the server offers it.
 */
export function TearYourOwn({
  onPhoto,
  onFile,
  onSample,
  others,
  disabled,
  paused,
  reader,
  footer,
}: {
  onPhoto: (photoId: string) => void;
  onFile: (file: File) => void;
  onSample?: () => void;
  others?: { lead: string; label: string; href: string }[];
  disabled?: boolean;
  /** Meta's API refused our key: live runs can't start until it accepts it again. */
  paused?: boolean;
  reader?: { open: boolean; onChange: (open: boolean) => void };
  footer?: React.ReactNode;
}) {
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
      const { default: QRCode } = await import("qrcode");
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
    <section className="tear" id="tear" aria-labelledby="tear-title">
      <div
        className="drop"
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
        <span className="rc" aria-hidden="true" />
        <div className="how tear-drop">
          <h2 id="tear-title">Tear your own.</h2>
          <p>Tear a printed page into about 6 pieces, lay them flat on something dark, text side up and not touching, and take one photo from straight above. Untorn runs the whole pipeline on it, live.</p>
          <button type="button" className="cta tab" onClick={() => fileRef.current?.click()} disabled={disabled}>
            <span>Choose a photo</span>
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
          <p className="drop-msg">Or drop it here: JPEG, PNG or HEIC, up to 15&nbsp;MB.</p>
          {paused && (
            <p className="paused-line" role="status">
              Live runs are paused just now: Meta&rsquo;s model API isn&rsquo;t accepting our key. The recorded runs above replay real runs, step by step.
            </p>
          )}
        </div>
        <div className="ways">
          <div className="way tear-phone">
            <h3>With your phone</h3>
            {phase.kind === "waiting" ? (
              <>
                <div className="qr" role="img" aria-label={`QR code for ${phase.session.url}`} dangerouslySetInnerHTML={{ __html: phase.svg }} />
                <p>
                  Scan it, or open <strong className="mono">{phase.session.url.replace(/^https?:\/\//, "")}</strong>
                </p>
                <p>
                  Code <strong className="code">{phase.session.code}</strong>. Waiting for the photo…
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
                <p role="alert">{ERRORS[phase.code]?.title ?? ERRORS.internal.title}. You can still choose a photo on this computer.</p>
                <button type="button" className="btn" onClick={create} disabled={disabled}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <p>Take the photo with the phone; the run plays here.</p>
                <button type="button" className="btn" onClick={create} disabled={disabled || phase.kind === "creating"}>
                  {phase.kind === "creating" ? "Making a code…" : "Show a QR code"}
                </button>
              </>
            )}
          </div>
          {onSample && (
            <div className="way">
              <h3>No torn page to hand?</h3>
              <p>Run this sample through the live pipeline now; it takes about a minute.</p>
              <button type="button" className="btn" onClick={onSample} disabled={disabled}>
                Run the sample live
              </button>
              {others?.map((o) => (
                <p className="way-other" key={o.href}>
                  {o.lead} <a href={o.href}>{o.label}</a>
                </p>
              ))}
            </div>
          )}
          {reader && (
            <label className="reader-line">
              <input type="checkbox" checked={reader.open} onChange={(e) => reader.onChange(e.target.checked)} disabled={disabled} />
              <span>
                <strong>Read on open weights only.</strong> Every read goes to Muse Spark Open, the Meta model whose weights an archive can run on its own servers. SAM&nbsp;3.1 still cuts out the pieces through Meta&rsquo;s API.
              </span>
            </label>
          )}
          <p className="privacy-line">Photos are deleted within 24 hours and never used for training.</p>
        </div>
      </div>
      {footer}
    </section>
  );
}

/** Open the file picker of the drop zone (used by error recovery). */
export function openPicker() {
  document.querySelector<HTMLInputElement>("#tear input[type=file]")?.click();
}
