import { describe, expect, it } from "vitest";
import { parseTilt, readCameraTilt, tiltDegrees, upDegFor } from "./tilt";

/** A JPEG's APP1 the way an iPhone writes it: IFD0 (orientation, Exif pointer), the Exif IFD (35 mm focal length,
 *  MakerNote) and Apple's MakerNote with the acceleration vector (signed rationals). Big-endian, like Apple's. */
function iphoneExif(gravity: [number, number, number], f35: number, orientation: number): Uint8Array {
  const b: number[] = [];
  const u16 = (v: number) => b.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const s32 = (v: number) => u32(v >>> 0);
  const entry = (tag: number, type: number, count: number) => {
    u16(tag);
    u16(type);
    u32(count);
  };
  const at = (o: number, v: number) => {
    b[o] = (v >>> 24) & 255;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  };
  // JPEG start, APP1 "Exif\0\0", TIFF header (MM, 42, IFD0 at 8)
  b.push(0xff, 0xd8, 0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0);
  const t = b.length;
  b.push(0x4d, 0x4d, 0, 0x2a);
  u32(8);
  // IFD0: orientation (SHORT), Exif IFD pointer (LONG)
  u16(2);
  entry(0x0112, 3, 1);
  u16(orientation);
  u16(0);
  entry(0x8769, 4, 1);
  const exifPtr = b.length;
  u32(0);
  u32(0);
  // Exif IFD: FocalLengthIn35mmFilm (SHORT), MakerNote (UNDEFINED)
  at(exifPtr, b.length - t);
  u16(2);
  entry(0xa405, 3, 1);
  u16(f35);
  u16(0);
  entry(0x927c, 7, 64);
  const mnPtr = b.length;
  u32(0);
  u32(0);
  // MakerNote: "Apple iOS\0", version 1, "MM", one entry (tag 8: 3 SRATIONAL), offsets from the MakerNote start
  at(mnPtr, b.length - t);
  const m = b.length;
  for (const ch of "Apple iOS") b.push(ch.charCodeAt(0));
  b.push(0, 0, 1, 0x4d, 0x4d);
  u16(1);
  entry(0x0008, 10, 3);
  const valPtr = b.length;
  u32(0);
  u32(0);
  at(valPtr, b.length - m);
  for (const g of gravity) {
    s32(Math.round(g * 1e6));
    s32(1e6);
  }
  return Uint8Array.from(b);
}

describe("readCameraTilt", () => {
  it("reads an iPhone's gravity vector, 35 mm focal length and orientation", () => {
    const t = readCameraTilt(iphoneExif([-0.006343, -0.199797, -0.972921], 24, 3))!;
    expect(t.f35).toBe(24);
    expect(t.orientation).toBe(3);
    expect(t.gravity[1]).toBeCloseTo(-0.199797, 5);
    expect(tiltDegrees(t)).toBeCloseTo(11.6, 1);
  });

  it("is null without EXIF, without Apple's MakerNote, or on truncated data", () => {
    expect(readCameraTilt(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    const ok = iphoneExif([0, 0, -1], 24, 6);
    expect(readCameraTilt(ok.subarray(0, ok.length - 20))).toBeNull();
    const notApple = Uint8Array.from(ok);
    notApple[notApple.indexOf(0x41, 40)] = 0x42; // "Apple" -> "Bpple"
    expect(readCameraTilt(notApple)).toBeNull();
  });
});

describe("parseTilt", () => {
  it("accepts a phone's numbers and refuses anything else", () => {
    expect(parseTilt({ gravity: [0, -0.2, -0.97], f35: 24, orientation: 6 })).toEqual({ gravity: [0, -0.2, -0.97], f35: 24, orientation: 6 });
    expect(parseTilt({ gravity: [0, 0, -9.8], f35: 24, orientation: 6 })).toBeNull();
    expect(parseTilt({ gravity: [0, 0, -1], f35: 2, orientation: 6 })).toBeNull();
    expect(parseTilt({ gravity: [0, 0, -1], f35: 24, orientation: 5 })).toBeNull();
    expect(parseTilt("nope")).toBeNull();
  });

  it("maps the upright orientations a phone writes", () => {
    expect([1, 6, 3, 8].map(upDegFor)).toEqual([0, 90, 180, 270]);
    expect(upDegFor(2)).toBeNull();
  });
});
