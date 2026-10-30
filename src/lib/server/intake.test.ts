import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { normalisePhoto, sharpness, sniffImage } from "./intake";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("photo intake", () => {
  it("knows image types by their bytes, not their names", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("png");
    expect(sniffImage(ascii("\0\0\0\x18ftypheic\0\0\0\0"))).toBe("heic");
    expect(sniffImage(ascii("\0\0\0\x18ftypmif1\0\0\0\0"))).toBe("heic");
    expect(sniffImage(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(ascii("GIF89a............"))).toBeNull();
    expect(sniffImage(ascii("%PDF-1.7 ........"))).toBeNull();
    expect(sniffImage(new Uint8Array(3))).toBeNull();
  });

  it("accepts a normal photo and refuses a broken one", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#654" } }).jpeg().toBuffer());
    await expect(normalisePhoto(jpeg)).resolves.toMatchObject({ kind: "jpeg", width: 1200, height: 900 });
    const broken = jpeg.slice(0, 40);
    await expect(normalisePhoto(broken)).rejects.toMatchObject({ code: "unreadable" });
  });

  it("measures a blurred photo as less sharp", async () => {
    const base = sharp({ create: { width: 800, height: 600, channels: 3, background: "#222" } }).composite([
      { input: Buffer.from('<svg width="800" height="600"><rect x="200" y="150" width="400" height="300" fill="#eee"/></svg>'), top: 0, left: 0 },
    ]);
    const raw = async (img: Sharp) => {
      const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data: new Uint8Array(data) };
    };
    const crisp = await sharpness(await raw(base.clone()));
    const soft = await sharpness(await raw(sharp(await base.clone().png().toBuffer()).blur(6)));
    expect(crisp).toBeGreaterThan(soft * 3);
  });
});

describe("store", () => {
  it("recognises Blob's not-found errors even with minified class names", async () => {
    const { isNotFound } = await import("./store");
    expect(isNotFound(new Error("Vercel Blob: The requested blob does not exist"))).toBe(true);
    expect(isNotFound(new Error("Vercel Blob: Access denied"))).toBe(false);
    // the first import of the store pulls in the Blob client: seconds when the whole suite runs at once
  }, 30_000);
});
