"use client";

// What replaces the deck on the stage when a live run needs words: a designed error with its way out, or a calm note.

import { ERRORS, type Recovery } from "@/lib/run/errors";
import type { ErrorCode } from "@/lib/run/types";

export const RECOVERY_LABEL: Record<Recovery, string> = {
  retake: "Take the photo again",
  upload: "Choose another photo",
  retry: "Try again",
  recorded: "Watch the recorded run",
  phone: "Use the phone instead",
  wait: "OK",
};

export function ErrorNote({ code, message, onAction, actions }: { code: ErrorCode; message?: string; onAction: (r: Recovery) => void; actions?: Recovery[] }) {
  const info = ERRORS[code] ?? ERRORS.internal;
  const recover = (actions ?? info.recover).filter((r) => r !== "wait");
  return (
    <div className="lead-note error-panel" role="alert" data-tone="error" data-code={code}>
      <h2>{info.title}</h2>
      <p>{message || info.message}</p>
      {recover.length > 0 && (
        <div className="actions">
          {recover.map((r) => (
            <button key={r} type="button" className="btn" onClick={() => onAction(r)}>
              {RECOVERY_LABEL[r]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Note({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="lead-note" role="status">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
