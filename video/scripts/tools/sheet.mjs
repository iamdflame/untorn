// Contact sheet: tiles images (in name order) into a grid with a timecode under each.
//   node scripts/tools/sheet.mjs <dir|files...> <out.png> [--cols 4] [--w 480] [--fps 30]
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const out = pos.pop();
let files = [];
for (const p of pos) {
  if (fs.statSync(p).isDirectory()) files.push(...fs.readdirSync(p).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => path.join(p, f)));
  else files.push(p);
}
const cols = Number(opt("cols", 4));
const w = Number(opt("w", 480));
const h = Math.round((w * 9) / 16);
const fps = Number(opt("fps", 30));
const lab = 26;
const rows = Math.ceil(files.length / cols);
const tiles = [];
for (let i = 0; i < files.length; i++) {
  const m = path.basename(files[i]).match(/(\d+)\.(png|jpe?g)$/i);
  const f = m ? Number(m[1]) : i;
  const tc = `${Math.floor(f / fps / 60)}:${String(Math.floor((f / fps) % 60)).padStart(2, "0")}.${String(Math.round(((f / fps) % 1) * 100)).padStart(2, "0")}  f${f}`;
  const img = await sharp(files[i]).resize(w, h, { fit: "cover" }).toBuffer();
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${lab}"><rect width="100%" height="100%" fill="#16120f"/><text x="8" y="18" font-family="Consolas, monospace" font-size="15" fill="#d8d2c6">${tc}</text></svg>`);
  tiles.push({ input: img, left: (i % cols) * w, top: Math.floor(i / cols) * (h + lab) });
  tiles.push({ input: label, left: (i % cols) * w, top: Math.floor(i / cols) * (h + lab) + h });
}
await sharp({ create: { width: cols * w, height: rows * (h + lab), channels: 3, background: "#16120f" } }).composite(tiles).png().toFile(out);
console.log(out, files.length, "frames");
