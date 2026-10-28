// Photo intake for uploads and phone captures: type-check by content (never by name or the client's MIME type),
// cap the size, convert HEIC, decode upright, and measure blur. Server-only.

import sharp, { type Metadata } from "sharp";
import { RunError } from "@/lib/run/errors";
import { MAX_UPLOAD_BYTES } from "@/lib/run/types";

export type PhotoKind = "jpeg" | "png" | "webp" | "heic" | "avif";

/** The image type from the file's first bytes, or null for anything else. */
export function sniffImage(b: Uint8Array): PhotoKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (["avif", "avis"].includes(brand)) return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

/** Smallest short side we accept (px): below this, torn edges are a few pixels across. */
export const MIN_SHORT_SIDE = 600;
/** Largest photo we decode (px): 50 MP. */
export const MAX_PIXELS = 50_000_000;

/**
 * Check an uploaded photo and return JPEG or PNG bytes sharp can decode (HEIC converted to JPEG).
 * Throws RunError with a designed code for every rejection.
 */
export async function normalisePhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array; kind: PhotoKind; width: number; height: number }> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RunError("too-large");
  const kind = sniffImage(bytes);
  if (!kind) throw new RunError("bad-type");
  let data = bytes;
  if (kind === "heic") {
    try {
      const { default: convert } = await import("heic-convert");
      data = new Uint8Array(await convert({ buffer: bytes, format: "JPEG", quality: 0.94 }));
    } catch {
      throw new RunError("unreadable", "That HEIC photo didn't open. Export it as JPEG, or take the photo with the phone page.");
    }
  }
  let meta: Metadata;
  try {
    meta = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new RunError("unreadable");
  }
  if (!meta.width || !meta.height) throw new RunError("unreadable");
  if (meta.width * meta.height > MAX_PIXELS) throw new RunError("too-large", "That photo has more than 50 megapixels. Send a smaller copy.");
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  if (Math.min(width, height) < MIN_SHORT_SIDE) throw new RunError("too-small");
  return { bytes: data, kind, width, height };
}

/**
 * Sharpness: the 99th percentile of the absolute Laplacian on a 1024 px grayscale copy. Paper edges and ink give
 * sharp photos values well above 40; a blurred photo stays low. Only used for a warning.
 */
export async function sharpness(rgb: { width: number; height: number; data: Uint8Array }): Promise<number> {
  const s = Math.min(1, 1024 / Math.max(rgb.width, rgb.height));
  const w = Math.max(3, Math.round(rgb.width * s));
  const h = Math.max(3, Math.round(rgb.height * s));
  const { data } = await sharp(Buffer.from(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length), { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .resize(w, h, { kernel: "cubic", fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hist = new Uint32Array(1021);
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]);
      hist[lap]++;
      n++;
    }
  }
  let acc = 0;
  for (let v = 0; v < hist.length; v++) {
    acc += hist[v];
    if (acc >= 0.99 * n) return v;
  }
  return 1020;
}
