// Adapters between the solver and stream S2's model layer (src/lib/server/). Structural types only: the solver core
// never imports server code, so it stays pure and runs in the browser.
//
//   const inputs = fragmentsFromSegments(photo, (await segmentFragments(jpegBytes)).fragments);
//   const result = await solve(inputs, { content: museContentCheck({ verifySeam, chooseContinuation }) });

import { encodePng } from "./render";
import type { ContentCheck, ContentVerdict, FragmentInput, Rgba } from "./types";

/** S2's MuseOutcome: never throws for upstream trouble. */
export type MuseOutcome<T> =
  | { ok: true; value: T; meta?: unknown }
  | { ok: false; error: { code: string; message: string; status?: number; retryable?: boolean }; meta?: unknown };

export type ImageInput = { data: Uint8Array; mime: "image/jpeg" | "image/png" | "image/webp"; detail?: string };

export type SeamVerdict = { same_place: boolean; confidence: number; words_across: string[]; reason: string };
export type ContinuationVerdict = { choice: string; index: number; confidence: number; words_across: string[]; reason: string };

export type VerifySeam = (seamImage: ImageInput, opts?: { rotated?: boolean; signal?: AbortSignal }) => Promise<MuseOutcome<SeamVerdict>>;
export type ChooseContinuation = (
  sheetImage: ImageInput,
  k: number,
  opts?: { rotated?: boolean; signal?: AbortSignal },
) => Promise<MuseOutcome<ContinuationVerdict>>;

export type MuseAdapterOptions = {
  /** Image encoding for the model; PNG by default (pure JS). */
  encode?: (img: Rgba) => ImageInput;
  /** Called with every outcome (for logs, cost ledgers, the UI's reasoning panel). */
  onOutcome?: (requestId: string, outcome: MuseOutcome<SeamVerdict | ContinuationVerdict>) => void;
};

/**
 * The solver's content check, built on S2's verifySeam (pair requests) and chooseContinuation (k-way sheets).
 * A failed or unparseable call becomes `null` ("can't tell"): the solver then falls back to geometry where it may.
 * When the request says "up" is unknown, the call asks with `rotated: true` (S2 adds an upside-down copy).
 */
export function museContentCheck(fns: { verifySeam: VerifySeam; chooseContinuation: ChooseContinuation }, opts: MuseAdapterOptions = {}): ContentCheck {
  const encode = opts.encode ?? ((img: Rgba) => ({ data: encodePng(img), mime: "image/png" as const }));
  return async (req): Promise<ContentVerdict | null> => {
    const image = encode(req.render());
    const rotated = req.uprightKnown === false;
    if (req.kind === "pair") {
      const out = await fns.verifySeam(image, { rotated });
      opts.onOutcome?.(req.id, out);
      if (!out.ok) return null;
      const v = out.value;
      return { kind: "pair", id: req.id, same: v.same_place, confidence: v.confidence, reason: v.reason, wordsAcross: v.words_across };
    }
    const out = await fns.chooseContinuation(image, req.candidates.length, { rotated });
    opts.onOutcome?.(req.id, out);
    if (!out.ok) return null;
    const v = out.value;
    const index = Number.isInteger(v.index) ? v.index : v.choice ? v.choice.toUpperCase().charCodeAt(0) - 65 : -1;
    return {
      kind: "choice",
      id: req.id,
      choice: index >= 0 && index < req.candidates.length ? index : null,
      confidence: v.confidence,
      reason: v.reason,
      wordsAcross: v.words_across,
    };
  };
}

/** A piece as S2's segmentFragments returns it: the mask is a full-resolution crop at (x, y). */
export type SegmentedFragment = { id: string; mask: { x: number; y: number; width: number; height: number; data: ArrayLike<number> } };

/** Solver inputs from segmented pieces and the decoded photo (RGBA): one crop of mask and pixels per piece. */
export function fragmentsFromSegments(photo: Rgba, frags: SegmentedFragment[]): FragmentInput[] {
  return frags.map((f) => {
    const { x, y, width, height, data } = f.mask;
    const mask = new Uint8Array(width * height);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let r = 0; r < height; r++) {
      const py = y + r;
      for (let c = 0; c < width; c++) {
        const px = x + c;
        const k = r * width + c;
        mask[k] = data[k] ? 1 : 0;
        if (px < 0 || py < 0 || px >= photo.width || py >= photo.height) continue;
        const s = 4 * (py * photo.width + px);
        rgba[4 * k] = photo.data[s];
        rgba[4 * k + 1] = photo.data[s + 1];
        rgba[4 * k + 2] = photo.data[s + 2];
        rgba[4 * k + 3] = 255;
      }
    }
    return { id: f.id, mask: { width, height, data: mask }, x0: x, y0: y, rgba: { width, height, data: rgba } };
  });
}
