// The paper finder (src/lib/server/paper.ts) against SAM 3.1 on recorded runs: each SAM piece against the blob that
// covers most of it, as IoU in the finder's frame. For a run that goes on when Meta's API refuses the key.
//   pnpm exec tsx scripts/eval/paper-finder.ts public/samples/fdr-1927/result.json [...]   (each run's photo.jpg beside it)

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { findPaper } from "../../src/lib/server/paper";

type Res = { photo: { width: number; height: number }; pieces: { id: string; polygon: [number, number][] }[] };

function inPoly(x: number, y: number, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

async function main() {
  for (const file of process.argv.slice(2)) {
    const res = JSON.parse(readFileSync(file, "utf8")) as Res;
    const dir = path.dirname(file);
    const photoFile = path.join(dir, "photo.jpg");
    if (!existsSync(photoFile)) throw new Error(`no ${photoFile}`);
    const { data, info } = await sharp(photoFile).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pf = findPaper({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) });
    // the run's polygons are in its own frame (the stored photo may be a smaller copy of it)
    const s = pf.width / res.photo.width;
    const lbl = new Int32Array(pf.width * pf.height).fill(-1);
    pf.masks.forEach((m, k) => {
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) lbl[(m.y + y) * pf.width + m.x + x] = k;
    });
    const area = pf.masks.map((m) => m.data.reduce((a, v) => a + v, 0));
    const ious: number[] = [];
    for (const pc of res.pieces) {
      const poly = pc.polygon.map(([x, y]) => [x * s, y * s] as [number, number]);
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(pf.width - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(pf.height - 1, Math.ceil(Math.max(...ys)));
      const votes = new Map<number, number>();
      let samArea = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (inPoly(x + 0.5, y + 0.5, poly)) {
            samArea++;
            const v = lbl[y * pf.width + x];
            if (v >= 0) votes.set(v, (votes.get(v) ?? 0) + 1);
          }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      ious.push(best ? best[1] / (samArea + area[best[0]] - best[1]) : 0);
    }
    const sorted = [...ious].sort((a, b) => a - b);
    console.log(
      `${path.basename(dir)}: SAM ${res.pieces.length} pieces, finder ${pf.masks.length} blobs; IoU > 0.9: ${ious.filter((v) => v > 0.9).length}; IoU min ${sorted[0]?.toFixed(3)} median ${sorted[sorted.length >> 1]?.toFixed(3)}; split ${pf.split}`,
    );
  }
}

main();
