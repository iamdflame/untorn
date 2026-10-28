// Request builders for SAM 3.1 on the Responses API, for still images.
//
// Grammar (docs: sam/segmenting):
// - a concept prompt is a short noun phrase in `input_text`, one concept per request;
// - object prompts are `<0f>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>` built with Meta's `buildObjectPrompt`;
// - the two never mix in one request, and an image's object prompts sit on frame 0.
// Every request streams and asks for per-record confidence and `one_bit` masks (the smallest payload).

import { buildObjectPrompt } from "@meta-sam/parser";
import type { Box } from "@/lib/contracts";

export const SAM_MODEL = "sam-3.1";
/** SAM tracks or segments at most this many objects per request. */
export const MAX_OBJECTS_PER_REQUEST = 16;

export type MediaSize = { width: number; height: number };

type InputText = { type: "input_text"; text: string };
type InputImage = { type: "input_image"; image_url: string };

export type SamRequestBody = {
  model: typeof SAM_MODEL;
  stream: true;
  metadata: { include_confidence: "true"; mask_encoding: "one_bit" };
  input: [{ type: "message"; role: "user"; content: [InputText, InputImage] }];
};

export class PromptError extends Error {
  override name = "PromptError";
}

function body(text: string, imageUrl: string): SamRequestBody {
  return {
    model: SAM_MODEL,
    stream: true,
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: imageUrl }] }],
  };
}

/** Every instance of a concept ("torn piece of paper") in one image. */
export function buildConceptImageRequest(concept: string, imageUrl: string): SamRequestBody {
  const text = concept.trim();
  if (!text) throw new PromptError("a concept prompt needs a noun phrase");
  return body(text, imageUrl);
}

/** One object per box (ids 0..n-1, in order), each box in the image's own pixels. */
export function buildBoxImageRequest(boxes: readonly Box[], size: MediaSize, imageUrl: string): SamRequestBody {
  return buildBoxPointImageRequest(boxes.map((box) => ({ box })), size, imageUrl);
}

/** A point prompt in the image's own pixels; negative marks a region that is not the object. */
export type PointPrompt = { x: number; y: number; negative?: boolean };

/**
 * One object per entry (ids 0..n-1, in order): a box, optionally with positive and negative points that pin down
 * which object inside the box is meant (a thin rotated fragment's box holds a lot of desk and its neighbours).
 */
export function buildBoxPointImageRequest(
  objects: readonly { box: Box; points?: readonly PointPrompt[] }[],
  size: MediaSize,
  imageUrl: string,
): SamRequestBody {
  if (!objects.length) throw new PromptError("at least one box is needed");
  if (objects.length > MAX_OBJECTS_PER_REQUEST) throw new PromptError(`at most ${MAX_OBJECTS_PER_REQUEST} boxes per request`);
  // Meta's boxes are half-open (right and bottom exclusive), in whole media pixels.
  const clamp = (v: number, hi: number) => Math.min(Math.max(Math.round(v), 0), hi);
  const inside = (v: number, hi: number) => Math.min(Math.max(Math.floor(v), 0), hi - 1);
  const prompted = objects.map(({ box: [x1, y1, x2, y2], points }, id) => ({
    id,
    prompts: [
      {
        frame: 0,
        box: { left: clamp(x1, size.width), top: clamp(y1, size.height), right: clamp(x2, size.width), bottom: clamp(y2, size.height) },
        ...(points?.length
          ? {
              points: points.map((p) => ({
                x: inside(p.x, size.width),
                y: inside(p.y, size.height),
                label: p.negative ? ("negative" as const) : ("positive" as const),
              })),
            }
          : {}),
      },
    ],
  }));
  return body(buildObjectPrompt({ size, objects: prompted }), imageUrl);
}

export const jpegDataUrl = (base64: string) => `data:image/jpeg;base64,${base64}`;
