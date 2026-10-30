// Rectilinear views out of an equirectangular 360° photo (bicubic sampling), for the archive shots.
//   node scripts/assets/reproject.mjs <equirect.jpg> <out.jpg> <yaw°> <pitch°> <hfov°> [width height]
// yaw 0 = the panorama's centre column, positive to the right; pitch positive = looking down.
import sharp from "sharp";

export async function reproject(src, out, { yaw, pitch, hfov, width = 3840, height = 2160, quality = 93 }) {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const Ws = info.width;
  const Hs = info.height;
  const px = (x, y, c) => {
    x = ((x % Ws) + Ws) % Ws;
    y = Math.max(0, Math.min(Hs - 1, y));
    return data[(y * Ws + x) * 3 + c];
  };
  // Catmull-Rom weights
  const w4 = (t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
  };
  const out3 = Buffer.alloc(width * height * 3);
  const f = width / 2 / Math.tan(((hfov / 2) * Math.PI) / 180);
  const cp = Math.cos((pitch * Math.PI) / 180);
  const sp = Math.sin((pitch * Math.PI) / 180);
  const cy = Math.cos((yaw * Math.PI) / 180);
  const sy = Math.sin((yaw * Math.PI) / 180);
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const x = (u + 0.5 - width / 2) / f;
      const y = (v + 0.5 - height / 2) / f;
      // pitch about x (looking down), then yaw about y
      const y1 = y * cp + sp;
      const z1 = -y * sp + cp;
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy;
      const n = Math.hypot(x2, y1, z2);
      const lon = Math.atan2(x2, z2);
      const lat = Math.asin(y1 / n);
      const sx = (0.5 + lon / (2 * Math.PI)) * Ws - 0.5;
      const syy = (0.5 + lat / Math.PI) * Hs - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(syy);
      const wx = w4(sx - ix);
      const wy = w4(syy - iy);
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let j = 0; j < 4; j++) {
          let row = 0;
          for (let i = 0; i < 4; i++) row += wx[i] * px(ix - 1 + i, iy - 1 + j, c);
          acc += wy[j] * row;
        }
        out3[(v * width + u) * 3 + c] = Math.max(0, Math.min(255, Math.round(acc)));
      }
    }
  await sharp(out3, { raw: { width, height, channels: 3 } }).jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true }).toFile(out);
  return out;
}

if (process.argv[1]?.endsWith("reproject.mjs")) {
  const [src, out, yaw, pitch, hfov, w, h] = process.argv.slice(2);
  await reproject(src, out, { yaw: Number(yaw), pitch: Number(pitch), hfov: Number(hfov), width: Number(w ?? 3840), height: Number(h ?? 2160) });
  console.log("wrote", out);
}
