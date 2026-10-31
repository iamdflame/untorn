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

const HEIC_UNREADABLE = "That HEIC photo didn't open. Export it as JPEG, or take the photo with the phone page.";

/**
 * HEIC to JPEG. sharp's prebuilt binaries cannot decode HEVC, so libheif (wasm) decodes the pixels, and sharp encodes
 * them natively: a phone photo in about 2 s, where heic-convert's JavaScript JPEG encoder alone took several more.
 * The image's size is read from the container first and checked against MAX_PIXELS before a single pixel is decoded:
 * a small file declaring a huge image must not get its pixel buffer allocated (width × height × 4 bytes).
 */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  let images: Awaited<ReturnType<typeof import("heic-decode").default.all>>;
  try {
    const { default: decode } = await import("heic-decode");
    images = await decode.all({ buffer: bytes });
  } catch {
    throw new RunError("unreadable", HEIC_UNREADABLE);
  }
  try {
    const primary = images[0];
    if (!primary || !(primary.width > 0) || !(primary.height > 0)) throw new RunError("unreadable", HEIC_UNREADABLE);
    if (primary.width * primary.height > MAX_PIXELS) throw new RunError("too-large", "That photo has more than 50 megapixels. Send a smaller copy.");
    let pixels: { width: number; height: number; data: Uint8ClampedArray };
    try {
      pixels = await primary.decode();
    } catch {
      throw new RunError("unreadable", HEIC_UNREADABLE);
    }
    const jpeg = await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length), {
      raw: { width: pixels.width, height: pixels.height, channels: 4 },
      limitInputPixels: MAX_PIXELS,
    })
      .removeAlpha()
      .jpeg({ quality: 94 })
      .toBuffer();
    return new Uint8Array(jpeg);
  } finally {
    images.dispose?.();
  }
}

/**
 * Check an uploaded photo and return JPEG or PNG bytes sharp can decode (HEIC converted to JPEG).
 * Throws RunError with a designed code for every rejection.
 */
export async function normalisePhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array; kind: PhotoKind; width: number; height: number }> {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RunError("too-large");
  const kind = sniffImage(bytes);
  if (!kind) throw new RunError("bad-type");
  const data = kind === "heic" ? await heicToJpeg(bytes) : bytes;
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
 * Sharpness: the mean of the strongest 0.2% of absolute Laplacian responses on a 1024 px grayscale copy (paper
 * edges and ink). A blurred photo's strongest edges are soft, so the value drops. Only used for a warning.
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
      hist[Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w])]++;
      n++;
    }
  }
  const take = Math.max(1, Math.round(0.002 * n));
  let got = 0;
  let sum = 0;
  for (let v = hist.length - 1; v >= 0 && got < take; v--) {
    const k = Math.min(hist[v], take - got);
    got += k;
    sum += k * v;
  }
  return sum / take;
}
