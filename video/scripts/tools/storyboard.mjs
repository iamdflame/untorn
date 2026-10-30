// The storyboard sheet: key frames with their beat and the narration line under each.
//   node scripts/tools/storyboard.mjs <stills dir> <keyframes.json> <out.png> [--cols 4] [--w 480]
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const [dir, kfFile, out] = process.argv.slice(2);
const opt = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const cols = Number(opt("cols", 4));
const w = Number(opt("w", 480));
const h = Math.round((w * 9) / 16);
const lab = 64;
const kf = JSON.parse(fs.readFileSync(kfFile, "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wrap = (s, n) => {
  const words = s.split(" ");
  const lines = [""];
  for (const wd of words) {
    if ((lines[lines.length - 1] + " " + wd).trim().length > n) lines.push(wd);
    else lines[lines.length - 1] = (lines[lines.length - 1] + " " + wd).trim();
  }
  return lines.slice(0, 2);
};
const tiles = [];
const rows = Math.ceil(kf.length / cols);
for (let i = 0; i < kf.length; i++) {
  const k = kf[i];
  const f = path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith(`-${String(k.frame).padStart(5, "0")}.png`)));
  const img = await sharp(f).resize(w, h).toBuffer();
  const tc = `${Math.floor(k.t / 60)}:${(k.t % 60).toFixed(1).padStart(4, "0")}`;
  const lines = wrap(k.narration ? `“${k.narration}”` : "", 62);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${lab}"><rect width="100%" height="100%" fill="#16120f"/><text x="8" y="17" font-family="Segoe UI, Arial" font-size="14" font-weight="700" fill="#efe8dc">${esc(tc)}  ${esc(k.label)}</text>${lines.map((l, j) => `<text x="8" y="${36 + j * 16}" font-family="Segoe UI, Arial" font-size="12.5" fill="#b0a99e">${esc(l)}</text>`).join("")}</svg>`;
  const x = (i % cols) * w;
  const y = Math.floor(i / cols) * (h + lab);
  tiles.push({ input: img, left: x, top: y }, { input: Buffer.from(svg), left: x, top: y + h });
}
await sharp({ create: { width: cols * w, height: rows * (h + lab), channels: 3, background: "#16120f" } }).composite(tiles).png().toFile(out);
console.log(out);
