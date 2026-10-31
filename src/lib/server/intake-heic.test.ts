import { beforeEach, describe, expect, it, vi } from "vitest";

// heic-decode stubbed: the size each image declares, and whether its pixels were ever decoded
const heic = vi.hoisted(() => ({
  images: [] as { width: number; height: number }[],
  fails: false,
  decoded: 0,
  disposed: 0,
}));
vi.mock("heic-decode", () => ({
  default: Object.assign(
    async () => {
      throw new Error("the intake decodes through all()");
    },
    {
      all: async () => {
        if (heic.fails) throw new Error("HEIF image not found");
        const list = heic.images.map((im) => ({
          ...im,
          decode: async () => {
            heic.decoded++;
            return { width: im.width, height: im.height, data: new Uint8ClampedArray(im.width * im.height * 4).fill(128) };
          },
        }));
        return Object.assign(list, { dispose: () => void heic.disposed++ });
      },
    },
  ),
}));

import { MAX_PIXELS, normalisePhoto } from "./intake";

/** Bytes that sniff as HEIC (an ftyp box with the heic brand); the stub supplies the rest. */
const heicFile = () => new TextEncoder().encode("\0\0\0\x18ftypheic\0\0\0\0mif1heic" + " ".repeat(64));

describe("HEIC intake", () => {
  beforeEach(() => {
    heic.images = [];
    heic.fails = false;
    heic.decoded = 0;
    heic.disposed = 0;
  });

  it("refuses an image declared beyond 50 MP before decoding a single pixel", async () => {
    // a few bytes of file can declare 100 000 × 100 000 px: its pixel buffer would be 40 GB
    heic.images = [{ width: 100_000, height: 100_000 }];
    await expect(normalisePhoto(heicFile())).rejects.toMatchObject({ code: "too-large" });
    expect(heic.decoded).toBe(0);
    expect(heic.disposed).toBe(1);
    // just over the limit is refused as well, at the limit it is not
    heic.images = [{ width: MAX_PIXELS / 5000 + 1, height: 5000 }];
    await expect(normalisePhoto(heicFile())).rejects.toMatchObject({ code: "too-large" });
    expect(heic.decoded).toBe(0);
  });

  it("calls a file without an image, or one the decoder rejects, unreadable", async () => {
    heic.images = [];
    await expect(normalisePhoto(heicFile())).rejects.toMatchObject({ code: "unreadable" });
    heic.fails = true;
    await expect(normalisePhoto(heicFile())).rejects.toMatchObject({ code: "unreadable" });
    expect(heic.decoded).toBe(0);
  });

  it("converts a normal HEIC photo to JPEG", async () => {
    heic.images = [{ width: 800, height: 600 }];
    const out = await normalisePhoto(heicFile());
    expect(out).toMatchObject({ kind: "heic", width: 800, height: 600 });
    expect([out.bytes[0], out.bytes[1], out.bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(heic.decoded).toBe(1);
    expect(heic.disposed).toBe(1);
  });
});
