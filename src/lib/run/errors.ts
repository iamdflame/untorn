// Every failure a first try can hit (BLUEPRINT §2), in plain words, with the way out. Shared by server and screens.

import type { ErrorCode, WarningCode } from "./types";

export type Recovery = "retake" | "upload" | "retry" | "recorded" | "phone" | "wait";

export type ErrorInfo = { title: string; message: string; recover: Recovery[]; status: number };

export const ERRORS: Record<ErrorCode, ErrorInfo> = {
  "bad-type": { title: "That isn't a photo we can read", message: "Send a JPEG, PNG or HEIC photo of the torn pieces.", recover: ["upload", "phone"], status: 415 },
  "too-large": { title: "That photo is too large", message: "Photos up to 15 MB work. Try a smaller copy, or take the photo with the phone.", recover: ["upload", "phone"], status: 413 },
  "too-small": { title: "That photo is too small to measure edges", message: "Use a photo at least 1000 pixels on its short side, taken straight down.", recover: ["retake", "upload"], status: 422 },
  unreadable: { title: "That file didn't open as an image", message: "It may be damaged or in an unusual format. Try another photo.", recover: ["upload", "phone"], status: 422 },
  "no-pieces": {
    title: "No paper pieces found",
    message: "Spread the pieces on a dark, plain surface, hold the phone straight above them, and take the photo again.",
    recover: ["retake", "recorded"],
    status: 422,
  },
  "too-many": { title: "Too many pieces in one photo", message: "Try up to 120 pieces per photo; split a big pile into a few photos.", recover: ["retake"], status: 422 },
  "rate-limited": { title: "Too many runs from here", message: "Give it a few minutes. The recorded run still plays.", recover: ["wait", "recorded"], status: 429 },
  "daily-cap": { title: "Today's live runs are used up", message: "We cap the model spend per day. The recorded run shows the whole pipeline.", recover: ["recorded"], status: 429 },
  busy: { title: "Untorn is busy right now", message: "Several runs are going at once. Try again in a minute.", recover: ["retry", "recorded"], status: 503 },
  "model-error": { title: "The models didn't answer", message: "Meta's model API returned errors after several retries. Try again in a moment.", recover: ["retry", "recorded"], status: 502 },
  timeout: { title: "This is taking too long", message: "The models are slow right now. Try again, or watch the recorded run.", recover: ["retry", "recorded"], status: 504 },
  "not-found": { title: "Nothing here", message: "This run or code doesn't exist. Runs and photos are deleted after 24 hours.", recover: ["recorded"], status: 404 },
  expired: { title: "This code has expired", message: "Codes last 20 minutes. Make a new one on the laptop.", recover: ["phone"], status: 410 },
  internal: { title: "Something broke on our side", message: "It's been logged. Try again, or watch the recorded run.", recover: ["retry", "recorded"], status: 500 },
};

export const WARNINGS: Record<WarningCode, string> = {
  blurry: "The photo looks blurred. A sharper photo, taken straight down, will join more pieces.",
  "small-photo": "The photo is small, so edges are coarse. A full-resolution photo joins more pieces.",
  "no-text": "No writing was found on the pieces. They may be face down: flip them and take another photo. Joins use shape only.",
  "some-blank": "Some pieces carry no writing, so only their shape could place them.",
  "slow-reading": "Muse was slow, so some seams were left unread; those joins rest on shape alone.",
  "reading-failed": "Muse couldn't read some seams; those joins rest on shape alone.",
  partial: "Not every piece found its place. The unplaced pieces are shown, never forced.",
  "many-pieces": "Many pieces: this run takes longer.",
  overlap: "Some pieces seem to touch or overlap. Spread them apart for a cleaner result.",
};

/** A typed failure the routes turn into a designed error event or JSON body (never a stack trace). */
export class RunError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERRORS[code].message);
    this.name = "RunError";
  }
}

export function errorBody(code: ErrorCode, message?: string) {
  const e = ERRORS[code];
  return { error: { code, title: e.title, message: message ?? e.message, recover: e.recover } };
}
