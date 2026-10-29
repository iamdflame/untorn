// Print the sharpness measure (intake.ts) of photos, with blurred copies, to calibrate the blur warning:
//   pnpm tsx scripts/sharpness.ts <photo...>
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { decodePhoto } from "../src/lib/server/images";
import { sharpness } from "../src/lib/server/intake";

async function main() {
  for (const f of process.argv.slice(2)) {
    const bytes = new Uint8Array(readFileSync(f));
    const row: string[] = [f.split(/[\/]/).pop()!];
    for (const sigma of [0, 1, 2, 4]) {
      const b = sigma ? new Uint8Array(await sharp(bytes).blur(sigma).jpeg().toBuffer()) : bytes;
      const p = await decodePhoto(b);
      row.push(`σ${sigma}=${(await sharpness(p.rgb)).toFixed(1)}`);
    }
    console.log(row.join("  "));
  }
}
main();
