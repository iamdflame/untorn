// Browser side of sending a photo: check it, shrink it to a size the server accepts in one request (Vercel caps
// request bodies at 4.5 MB), then post it. HEIC files the browser can't decode go up as they are (the server
// converts them).

import { ERRORS } from "@/lib/run/errors";
import { MAX_REQUEST_BYTES, MAX_UPLOAD_BYTES, type ErrorCode } from "@/lib/run/types";

export class PhotoError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERRORS[code].message);
  }
}

const IMAGE_NAME = /\.(jpe?g|png|heic|heif|webp|avif)$/i;
/**
 * Longest side ever sent (a 48 MP phone photo is 8064 px). Detail is what tells a true torn-edge fit from a chance
 * one: the real torn page placed 9 of 10 pieces at its full 4284×5712, but 5 of 10 (2 misplaced) shrunk to 1920×2560.
 * So a photo goes up at full size, and only its JPEG quality steps down to fit the request limit.
 */
export const SEND_LONG_SIDE = 8064;
/** JPEG qualities tried in order before the photo is shrunk at all (a 24 MP desk photo is ~3.6 MB at 0.8). */
const QUALITIES = [0.92, 0.88, 0.84, 0.8, 0.75];

export function looksLikePhoto(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_NAME.test(file.name);
}

/** A photo ready to post: downscaled JPEG when the browser can decode it, else the original bytes. */
export async function preparePhoto(file: File): Promise<Blob> {
  if (!looksLikePhoto(file)) throw new PhotoError("bad-type");
  if (file.size > MAX_UPLOAD_BYTES) throw new PhotoError("too-large");
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = null;
  }
  if (!bitmap) {
    if (file.size <= MAX_REQUEST_BYTES) return file;
    throw new PhotoError("too-large", "This browser can't shrink that photo before sending. Export it as JPEG, or take it with the phone page.");
  }
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= SEND_LONG_SIDE && file.size <= MAX_REQUEST_BYTES && /jpe?g|png/i.test(file.type)) {
    bitmap.close();
    return file;
  }
  // full size first, stepping the quality down; only then shrink, 15% at a time
  for (let s = Math.min(1, SEND_LONG_SIDE / long); s >= 0.35; s *= 0.85) {
    const w = Math.round(bitmap.width * s);
    const h = Math.round(bitmap.height * s);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    // a phone browser may refuse a canvas this large (iOS caps canvas area): then try smaller
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    for (const q of QUALITIES) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
      if (blob && blob.size <= MAX_REQUEST_BYTES) {
        bitmap.close();
        return blob;
      }
    }
  }
  bitmap.close();
  throw new PhotoError("too-large");
}

/** Parse an error body from a non-2xx response into a PhotoError. */
export async function responseError(res: Response): Promise<PhotoError> {
  try {
    const j = (await res.json()) as { error?: { code?: ErrorCode; message?: string } };
    const code = j.error?.code && j.error.code in ERRORS ? j.error.code : "internal";
    return new PhotoError(code, j.error?.message);
  } catch {
    return new PhotoError(res.status === 413 ? "too-large" : res.status === 429 ? "rate-limited" : "internal");
  }
}
