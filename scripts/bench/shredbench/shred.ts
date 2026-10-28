// Cut each rendered replica page into N Voronoi cells and scatter them on a 4096 × 4096 photo: our own 2D
// re-implementation of ShredBench's published protocol ("we use a k-d tree algorithm to assign pixels to N seed
// points, creating natural, jagged boundaries"; fragments rotated, scattered, with shadows). What we reproduce:
// - N seeds uniform on the page; cells assigned at half resolution and upsampled nearest-neighbour, so every cut
//   has ShredBench's 2-px stair steps;
// - each cell turned by a random angle and packed centre-out with a 30 px gap, the whole layout fitted to the frame;
// - a uniform grey ground (their renders measure 148–152), a soft drop shadow, gentle low-frequency shading across
//   each piece, slight blur and noise, JPEG.
// What we do not: Blender's 3D curl and crumple, its bulging page borders, perspective. It is labelled everywhere as
// "our re-implementation of ShredBench's protocol, 2D compositing, no Blender".
//
//   pnpm tsx scripts/bench/shredbench/shred.ts [--root DIR] [--pieces 8,12,16]
// → <root>/replica/data_<N>/<domain>/<name>.jpg + .json (true pose of every cell: page → photo), replica/split.json

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { argValue, DEFAULT_ROOT } from "../../eval/shredbench/args";

export const PHOTO = 4096;
const GROUND = 150;

/** Deterministic PRNG (mulberry32) from a string. */
function rngOf(key: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CellTruth = {
  /** Cell index (seed order). */
  k: number;
  /** Page → photo: photo = scale · R(theta) · (page − centroid) + centre. */
  theta: number;
  centroid: [number, number];
  centre: [number, number];
  area: number;
};
export type ShredTruth = { page: { width: number; height: number }; pieces: number; scale: number; seeds: [number, number][]; cells: CellTruth[]; photo: { width: number; height: number } };

/** Voronoi labels, assigned at half resolution and upsampled nearest-neighbour (ShredBench's 2-px stair steps). */
function voronoiLabels(W: number, H: number, seeds: [number, number][]): Uint8Array {
  const w = Math.ceil(W / 2);
  const h = Math.ceil(H / 2);
  const half = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const dx = x - seeds[k][0] / 2;
        const dy = y - seeds[k][1] / 2;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      half[y * w + x] = best;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = half[(y >> 1) * w + (x >> 1)];
  return out;
}

/** Greedy centre-out packing on a coarse grid (1 cell = `g` page px), with a gap of `pad` cells around each piece. */
function pack(masks: { w: number; h: number; occ: Uint8Array; area: number }[], pad: number, grow = 1): [number, number][] {
  const total = masks.reduce((s, m) => s + m.area, 0);
  let side = Math.ceil(1.5 * grow * Math.sqrt(total / 0.5));
  side = Math.max(side, Math.ceil(2 * grow * Math.max(...masks.map((m) => Math.max(m.w, m.h)))));
  const canvas = new Uint8Array(side * side);
  const order = masks.map((_, i) => i).sort((a, b) => masks[b].area - masks[a].area);
  const pos: [number, number][] = masks.map(() => [0, 0]);
  // candidate offsets by distance of the piece centre to the canvas centre
  for (const i of order) {
    const m = masks[i];
    const cands: [number, number, number][] = [];
    for (let y = 0; y + m.h <= side; y += 2) for (let x = 0; x + m.w <= side; x += 2) cands.push([(x + m.w / 2 - side / 2) ** 2 + (y + m.h / 2 - side / 2) ** 2, x, y]);
    cands.sort((a, b) => a[0] - b[0]);
    let placed = false;
    for (const [, x, y] of cands) {
      let free = true;
      for (let r = 0; r < m.h && free; r++) {
        for (let c = 0; c < m.w; c++) {
          if (m.occ[r * m.w + c] && canvas[(y + r) * side + x + c]) {
            free = false;
            break;
          }
        }
      }
      if (!free) continue;
      // stamp with the gap
      for (let r = 0; r < m.h; r++) {
        for (let c = 0; c < m.w; c++) {
          if (!m.occ[r * m.w + c]) continue;
          for (let dy = -pad; dy <= pad; dy++) {
            for (let dx = -pad; dx <= pad; dx++) {
              const yy = y + r + dy;
              const xx = x + c + dx;
              if (yy >= 0 && xx >= 0 && yy < side && xx < side) canvas[yy * side + xx] = 1;
            }
          }
        }
      }
      pos[i] = [x + m.w / 2, y + m.h / 2];
      placed = true;
      break;
    }
    // long cells of a tall page can run out of room: start again on a larger canvas
    if (!placed) return pack(masks, pad, grow * 1.3);
  }
  return pos;
}

/** Separable box blur, three passes ≈ Gaussian of the given sigma. In place on a float raster. */
function blur(f: Float32Array, W: number, H: number, sigma: number) {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  const tmp = new Float32Array(Math.max(W, H));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += f[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[x] = s / (2 * r + 1);
        s += f[y * W + Math.min(W - 1, x + r + 1)] - f[y * W + Math.max(0, x - r)];
      }
      f.set(tmp.subarray(0, W), y * W);
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += f[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        tmp[y] = s / (2 * r + 1);
        s += f[Math.min(H - 1, y + r + 1) * W + x] - f[Math.max(0, y - r) * W + x];
      }
      for (let y = 0; y < H; y++) f[y * W + x] = tmp[y];
    }
  }
}

/** Cut one page into n cells and composite the scattered photo. */
export async function shredPage(pagePng: string, n: number, key: string): Promise<{ jpeg: Buffer; truth: ShredTruth }> {
  const { data: rgb, info } = await sharp(pagePng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const rand = rngOf(key);
  const seeds: [number, number][] = Array.from({ length: n }, () => [rand() * W, rand() * H]);
  const label = voronoiLabels(W, H, seeds);
  // centroids and areas
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const area = new Float64Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = label[y * W + x];
      sx[k] += x + 0.5;
      sy[k] += y + 0.5;
      area[k]++;
    }
  }
  const cells = Array.from({ length: n }, (_, k) => ({ k, centroid: [sx[k] / area[k], sy[k] / area[k]] as [number, number], theta: rand() * 2 * Math.PI, area: area[k] }));
  // coarse rotated masks for packing (10 page px per cell, gap 30 px)
  const g = 10;
  const coarse = cells.map((c) => {
    let R = 0;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) if (label[y * W + x] === c.k) R = Math.max(R, Math.hypot(x - c.centroid[0], y - c.centroid[1]));
    const half = Math.ceil(R / g) + 1;
    const w = 2 * half + 1;
    const occ = new Uint8Array(w * w);
    const cs = Math.cos(-c.theta);
    const sn = Math.sin(-c.theta);
    let a = 0;
    for (let r = 0; r < w; r++) {
      for (let q = 0; q < w; q++) {
        const dx = (q - half) * g;
        const dy = (r - half) * g;
        const px = Math.round(c.centroid[0] + cs * dx - sn * dy);
        const py = Math.round(c.centroid[1] + sn * dx + cs * dy);
        if (px >= 0 && py >= 0 && px < W && py < H && label[py * W + px] === c.k) {
          occ[r * w + q] = 1;
          a++;
        }
      }
    }
    return { w, h: w, occ, area: a, half };
  });
  const pos = pack(coarse, 3);
  // fit the layout to the photo (an orthographic camera framing every piece with a 5% margin)
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  cells.forEach((c, i) => {
    const m = coarse[i];
    for (let r = 0; r < m.h; r++) {
      for (let q = 0; q < m.w; q++) {
        if (!m.occ[r * m.w + q]) continue;
        const x = (pos[i][0] + q - m.half) * g;
        const y = (pos[i][1] + r - m.half) * g;
        minx = Math.min(minx, x);
        maxx = Math.max(maxx, x);
        miny = Math.min(miny, y);
        maxy = Math.max(maxy, y);
      }
    }
  });
  const scale = PHOTO / (1.05 * Math.max(maxx - minx + g, maxy - miny + g));
  const ox = PHOTO / 2 - scale * (minx + maxx) / 2;
  const oy = PHOTO / 2 - scale * (miny + maxy) / 2;
  const truthCells: CellTruth[] = cells.map((c, i) => ({ k: c.k, theta: c.theta, centroid: c.centroid, centre: [ox + scale * pos[i][0] * g, oy + scale * pos[i][1] * g], area: c.area }));

  // render: coverage (2×2 supersampled label test) and colour per piece, shadows under all of them
  const N = PHOTO * PHOTO;
  const out = new Float32Array(3 * N).fill(GROUND);
  const cover = new Float32Array(N);
  const colour = new Float32Array(3 * N);
  const sub = [-0.25, 0.25];
  for (const c of truthCells) {
    const cs = Math.cos(c.theta);
    const sn = Math.sin(c.theta);
    let R = 0;
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) if (label[y * W + x] === c.k) R = Math.max(R, Math.hypot(x - c.centroid[0], y - c.centroid[1]));
    const rad = scale * (R + 6);
    const x0 = Math.max(0, Math.floor(c.centre[0] - rad));
    const x1 = Math.min(PHOTO - 1, Math.ceil(c.centre[0] + rad));
    const y0 = Math.max(0, Math.floor(c.centre[1] - rad));
    const y1 = Math.min(PHOTO - 1, Math.ceil(c.centre[1] + rad));
    // gentle shading: a few long waves across the piece (light falling on paper that is not quite flat)
    const waves = Array.from({ length: 3 }, () => ({ fx: (rand() - 0.5) * 0.006, fy: (rand() - 0.5) * 0.006, ph: rand() * 6.283, amp: 0.012 + 0.012 * rand() }));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        let hits = 0;
        let qx0 = 0;
        let qy0 = 0;
        for (const ddy of sub) {
          for (const ddx of sub) {
            const dx = (px + 0.5 + ddx - c.centre[0]) / scale;
            const dy = (py + 0.5 + ddy - c.centre[1]) / scale;
            const qx = c.centroid[0] + cs * dx + sn * dy;
            const qy = c.centroid[1] - sn * dx + cs * dy;
            const ix = Math.floor(qx);
            const iy = Math.floor(qy);
            if (ix >= 0 && iy >= 0 && ix < W && iy < H && label[iy * W + ix] === c.k) hits++;
          }
        }
        if (!hits) continue;
        const i = py * PHOTO + px;
        cover[i] = hits / 4;
        // bilinear page colour at the pixel centre
        const dx = (px + 0.5 - c.centre[0]) / scale;
        const dy = (py + 0.5 - c.centre[1]) / scale;
        qx0 = c.centroid[0] + cs * dx + sn * dy - 0.5;
        qy0 = c.centroid[1] - sn * dx + cs * dy - 0.5;
        const ix = Math.max(0, Math.min(W - 2, Math.floor(qx0)));
        const iy = Math.max(0, Math.min(H - 2, Math.floor(qy0)));
        const fx = Math.max(0, Math.min(1, qx0 - ix));
        const fy = Math.max(0, Math.min(1, qy0 - iy));
        let light = 1;
        for (const w of waves) light += w.amp * Math.sin(px * w.fx + py * w.fy + w.ph);
        for (let ch = 0; ch < 3; ch++) {
          const a = rgb[3 * (iy * W + ix) + ch];
          const b = rgb[3 * (iy * W + ix + 1) + ch];
          const cc = rgb[3 * ((iy + 1) * W + ix) + ch];
          const d = rgb[3 * ((iy + 1) * W + ix + 1) + ch];
          colour[3 * i + ch] = ((1 - fy) * ((1 - fx) * a + fx * b) + fy * ((1 - fx) * cc + fx * d)) * light * 0.955;
        }
      }
    }
  }
  // drop shadow: the pieces' coverage, blurred and offset, darkens the ground
  const shadow = new Float32Array(cover);
  blur(shadow, PHOTO, PHOTO, 5);
  for (let y = PHOTO - 1; y >= 0; y--) {
    for (let x = PHOTO - 1; x >= 0; x--) {
      const sxp = x - 3;
      const syp = y - 4;
      const s = sxp >= 0 && syp >= 0 ? shadow[syp * PHOTO + sxp] : 0;
      const i = y * PHOTO + x;
      const dark = 1 - 0.35 * Math.min(1, s);
      for (let ch = 0; ch < 3; ch++) out[3 * i + ch] *= dark;
      const a = cover[i];
      if (a > 0) for (let ch = 0; ch < 3; ch++) out[3 * i + ch] = a * colour[3 * i + ch] + (1 - a) * out[3 * i + ch];
    }
  }
  // sensor noise, then a light blur through sharp (lens and the renderer's 0.8 px filter), JPEG
  const bytes = new Uint8Array(3 * N);
  for (let i = 0; i < 3 * N; i++) {
    const u = rand() + rand() + rand() - 1.5;
    bytes[i] = Math.max(0, Math.min(255, Math.round(out[i] + 2.2 * u)));
  }
  const jpeg = await sharp(Buffer.from(bytes.buffer), { raw: { width: PHOTO, height: PHOTO, channels: 3 } }).blur(0.55).jpeg({ quality: 88 }).toBuffer();
  return { jpeg, truth: { page: { width: W, height: H }, pieces: n, scale, seeds, cells: truthCells, photo: { width: PHOTO, height: PHOTO } } };
}

/** The dev split: two documents per domain, chosen before any run and kept out of every reported number. */
export const DEV_DOCS = ["news_en/cd_001", "news_en/cd_002", "news_zh/pd_001", "news_zh/pd_002", "code/py_001", "code/java_001", "table/arxiv_001", "table/arxiv_002"];

async function main() {
  const root = argValue("--root") ?? DEFAULT_ROOT;
  const pieces = (argValue("--pieces") ?? "8,12,16").split(",").map(Number);
  const pages = path.join(root, "replica", "pages");
  const split: Record<string, "dev" | "test"> = {};
  for (const domain of readdirSync(pages).filter((d) => !d.includes("."))) {
    for (const f of readdirSync(path.join(pages, domain)).filter((x) => x.endsWith(".png")).sort()) {
      const name = f.replace(/\.png$/, "");
      split[`${domain}/${name}`] = DEV_DOCS.includes(`${domain}/${name}`) ? "dev" : "test";
      for (const n of pieces) {
        const dir = path.join(root, "replica", `data_${n}`, domain);
        const jpg = path.join(dir, `${name}.jpg`);
        if (existsSync(jpg)) continue;
        mkdirSync(dir, { recursive: true });
        const t0 = Date.now();
        const { jpeg, truth } = await shredPage(path.join(pages, domain, f), n, `${domain}/${name}/${n}`);
        writeFileSync(jpg, jpeg);
        writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(truth));
        console.log(`${domain}/${name} × ${n}: scale ${truth.scale.toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    }
  }
  writeFileSync(path.join(root, "replica", "split.json"), JSON.stringify(split, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
