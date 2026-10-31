// The camera's tilt, read from the photo itself. iPhones store the phone's gravity vector at the moment of the shot
// (Apple's MakerNote tag 0x0008, "AccelerationVector": x right, y up the screen, z out of the screen, in g) next to the
// 35 mm-equivalent focal length and the orientation. A photo taken at an angle makes far pieces smaller (11.6° made
// them 30% smaller across one table) and their edges stop fitting; these three numbers undo it exactly
// (src/lib/server/rectify.ts). Shared by the browser, which reads them before it re-encodes a photo (that drops EXIF),
// and the server, which reads its own copy first.

export type CameraTilt = { gravity: [number, number, number]; f35: number; orientation: number };

/** Read the tilt from a JPEG or HEIC's EXIF (null when any part is missing or malformed: not an iPhone, no EXIF). */
export function readCameraTilt(bytes: Uint8Array): CameraTilt | null {
  try {
    const t = findTiff(bytes.subarray(0, 1 << 20));
    if (t < 0) return null;
    const le = bytes[t] === 0x49;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number) => (o + 2 <= bytes.length ? dv.getUint16(o, le) : NaN);
    const u32 = (o: number) => (o + 4 <= bytes.length ? dv.getUint32(o, le) : NaN);
    const ifd = (start: number) => {
      const n = u16(start);
      const out = new Map<number, { type: number; count: number; at: number }>();
      if (!(n > 0 && n < 512)) return out;
      for (let k = 0; k < n; k++) {
        const e = start + 2 + 12 * k;
        const type = u16(e + 2);
        const count = u32(e + 4);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
        out.set(u16(e), { type, count, at: size * count <= 4 ? e + 8 : t + u32(e + 8) });
      }
      return out;
    };
    const ifd0 = ifd(t + u32(t + 4));
    const orientation = ifd0.get(0x0112) ? u16(ifd0.get(0x0112)!.at) : 1;
    const exifPtr = ifd0.get(0x8769);
    if (!exifPtr) return null;
    const exif = ifd(t + u32(exifPtr.at));
    const f35e = exif.get(0xa405);
    const f35 = f35e ? u16(f35e.at) : NaN;
    const mn = exif.get(0x927c);
    if (!mn) return null;
    // Apple's MakerNote: "Apple iOS\0", a 2-byte version, "MM", then an IFD whose offsets count from the MakerNote
    const m = mn.at;
    if (String.fromCharCode(...bytes.subarray(m, m + 9)) !== "Apple iOS") return null;
    const mle = bytes[m + 12] === 0x49;
    const m16 = (o: number) => (o + 2 <= bytes.length ? dv.getUint16(o, mle) : NaN);
    const m32 = (o: number) => (o + 4 <= bytes.length ? dv.getUint32(o, mle) : NaN);
    const s32 = (o: number) => (o + 4 <= bytes.length ? dv.getInt32(o, mle) : NaN);
    const n = m16(m + 14);
    if (!(n > 0 && n < 512)) return null;
    for (let k = 0; k < n; k++) {
      const e = m + 16 + 12 * k;
      if (m16(e) !== 0x0008 || m16(e + 2) !== 10 || m32(e + 4) !== 3) continue;
      const v = m + m32(e + 8);
      const g = [0, 1, 2].map((q) => s32(v + 8 * q) / s32(v + 8 * q + 4)) as [number, number, number];
      return parseTilt({ gravity: g, f35, orientation });
    }
    return null;
  } catch {
    return null;
  }
}

/** The TIFF header that follows "Exif\0\0" (a JPEG's APP1, a HEIC's Exif item); -1 when there is none. */
function findTiff(b: Uint8Array): number {
  for (let i = 0; i + 10 < b.length; i++) {
    if (b[i] !== 0x45 || b[i + 1] !== 0x78 || b[i + 2] !== 0x69 || b[i + 3] !== 0x66 || b[i + 4] !== 0 || b[i + 5] !== 0) continue;
    const t = i + 6;
    if ((b[t] === 0x4d && b[t + 1] === 0x4d && b[t + 2] === 0 && b[t + 3] === 0x2a) || (b[t] === 0x49 && b[t + 1] === 0x49 && b[t + 2] === 0x2a && b[t + 3] === 0)) return t;
  }
  return -1;
}

/** A tilt from untrusted JSON (a browser's reading): the numbers must be ones a phone produces. */
export function parseTilt(v: unknown): CameraTilt | null {
  if (!v || typeof v !== "object") return null;
  const { gravity: g, f35, orientation } = v as Record<string, unknown>;
  if (!Array.isArray(g) || g.length !== 3 || !g.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const mag = Math.hypot(g[0], g[1], g[2]);
  if (mag < 0.5 || mag > 1.5) return null;
  if (typeof f35 !== "number" || !(f35 >= 10 && f35 <= 300)) return null;
  if (typeof orientation !== "number" || upDegFor(orientation) === null) return null;
  return { gravity: [g[0], g[1], g[2]], f35, orientation };
}

/** Degrees between the lens axis and straight down. */
export function tiltDegrees(t: CameraTilt): number {
  const [x, y, z] = t.gravity;
  return (Math.acos(Math.max(-1, Math.min(1, -z / Math.hypot(x, y, z)))) * 180) / Math.PI;
}

/**
 * Where the upright photo's "up" points in the phone's x–y plane, from the EXIF orientation: 6 (held upright) 90°,
 * 3 (on its side, top to the right) 180°, measured on the user's photos; 1 and 8 complete the turn. Mirrored
 * orientations (2, 4, 5, 7) don't come from a phone camera: null.
 */
export function upDegFor(orientation: number): number | null {
  return ({ 1: 0, 6: 90, 3: 180, 8: 270 } as Record<number, number>)[orientation] ?? null;
}
