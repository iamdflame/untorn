// A small synthetic "torn pieces on a desk" scene, rendered deterministically with sharp from SVG.
// Used by the segmentation tests (with SAM responses recorded on exactly this image) and by the fixture recorder.
import sharp from "sharp";
import type { Point } from "../mask-geometry";

/** Deterministic jagged polygon around a centre (a seeded LCG; no Math.random). */
function jagged(cx: number, cy: number, rx: number, ry: number, n: number, seed: number): Point[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = 0.82 + 0.18 * rnd();
    return [Math.round((cx + Math.cos(a) * rx * r) * 10) / 10, Math.round((cy + Math.sin(a) * ry * r) * 10) / 10] as Point;
  });
}

export const SCENE_W = 640;
export const SCENE_H = 480;
export const SCENE_PIECES: Point[][] = [jagged(150, 140, 110, 80, 48, 7), jagged(450, 150, 120, 95, 56, 11), jagged(300, 360, 130, 80, 52, 23)];

export async function renderScene(): Promise<Uint8Array> {
  const pts = (p: Point[]) => p.map(([x, y]) => `${x},${y}`).join(" ");
  const pieces = SCENE_PIECES.map((p, k) => {
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let lines = "";
    for (let y = y0 + 14; y < y1; y += 16) lines += `<rect x="${x0 + 18}" y="${y}" width="${x1 - x0 - 30}" height="3" fill="#3a3f66"/>`;
    // typed lines run off the torn edge, like text cut by a tear
    return `<clipPath id="c${k}"><polygon points="${pts(p)}"/></clipPath><polygon points="${pts(p)}" fill="#ebe5d3"/><g clip-path="url(#c${k})">${lines}</g>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_W}" height="${SCENE_H}">
<rect width="100%" height="100%" fill="#7d5a3c"/>${pieces}</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer());
}
