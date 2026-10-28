// Image plumbing for the model layer, on sharp: decode a phone photo once, then resize, crop and re-encode views of
// it for SAM and Muse. Server-only (sharp is a native module).

import sharp from "sharp";

/** Interleaved 8-bit RGB pixels, row-major. */
export type Rgb = { width: number; height: number; data: Uint8Array };

export type DecodedPhoto = {
  width: number;
  height: number;
  rgb: Rgb;
  /** JPEG bytes of the upright full-resolution photo (the original file when it needed no rotation). */
  jpeg: Uint8Array;
};

/** Decode any sharp-readable photo, applying its EXIF orientation, to upright RGB plus a full-resolution JPEG. */
export async function decodePhoto(input: Uint8Array): Promise<DecodedPhoto> {
  const meta = await sharp(input).metadata();
  const upright = sharp(input).rotate().removeAlpha().toColourspace("srgb");
  const { data, info } = await upright.clone().raw().toBuffer({ resolveWithObject: true });
  const needsJpeg = meta.format !== "jpeg" || (meta.orientation ?? 1) !== 1;
  const jpeg = needsJpeg ? await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer() : input;
  return { width: info.width, height: info.height, rgb: { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }, jpeg: new Uint8Array(jpeg) };
}

const fromRgb = (rgb: Rgb) => sharp(Buffer.from(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length), { raw: { width: rgb.width, height: rgb.height, channels: 3 } });

/** Resize so the long side is `longSide` (never enlarges) and encode as JPEG. Returns the new size. */
export async function resizeJpeg(rgb: Rgb, longSide: number, quality = 90): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const s = Math.min(1, longSide / Math.max(rgb.width, rgb.height));
  const width = Math.max(1, Math.round(rgb.width * s));
  const height = Math.max(1, Math.round(rgb.height * s));
  const buf = await fromRgb(rgb).resize(width, height, { kernel: "lanczos3", fit: "fill" }).jpeg({ quality }).toBuffer();
  return { jpeg: new Uint8Array(buf), width, height };
}

/**
 * Crop a region (clamped to the image) and encode as JPEG; with `longSide`, also downscale the crop to it.
 * left/top/width/height describe the crop in the source; outW/outH the encoded image.
 */
export async function cropJpeg(
  rgb: Rgb,
  region: { left: number; top: number; width: number; height: number },
  quality = 92,
  longSide?: number,
): Promise<{ jpeg: Uint8Array; left: number; top: number; width: number; height: number; outW: number; outH: number }> {
  const left = Math.max(0, Math.floor(region.left));
  const top = Math.max(0, Math.floor(region.top));
  const width = Math.max(1, Math.min(rgb.width - left, Math.ceil(region.width - (left - region.left))));
  const height = Math.max(1, Math.min(rgb.height - top, Math.ceil(region.height - (top - region.top))));
  const s = longSide ? Math.min(1, longSide / Math.max(width, height)) : 1;
  const outW = Math.max(1, Math.round(width * s)), outH = Math.max(1, Math.round(height * s));
  let img = fromRgb(rgb).extract({ left, top, width, height });
  if (s < 1) img = img.resize(outW, outH, { kernel: "lanczos3", fit: "fill" });
  const buf = await img.jpeg({ quality }).toBuffer();
  return { jpeg: new Uint8Array(buf), left, top, width, height, outW, outH };
}

/** Turn an encoded image by 180° (for reading pieces whose upright direction is unknown). */
export async function rotate180Jpeg(img: Uint8Array, quality = 92): Promise<Uint8Array> {
  return new Uint8Array(await sharp(img).rotate(180).jpeg({ quality }).toBuffer());
}
