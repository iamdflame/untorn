import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderScene, SCENE_PIECES } from "./__fixtures__/scene";
import { evaluateMasks } from "./mask-eval";
import { findPaper } from "./paper";

async function rgbOf(image: Uint8Array | Buffer) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}
const svg = (body: string, bg: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`);

describe("findPaper", () => {
  it("finds each piece of paper on the darker desk, its typed lines and all", async () => {
    const pf = findPaper(await rgbOf(await renderScene()));
    expect(pf.masks).toHaveLength(3);
    expect(pf.split).toBeGreaterThan(10);
    const ev = evaluateMasks(SCENE_PIECES.map((p, piece) => ({ piece, photo_polygon: p })), pf.masks).summary;
    expect(ev.detected).toBe(3);
    expect(ev.meanIoU).toBeGreaterThan(0.9);
  });

  it("keeps two pieces a few pixels apart as two pieces", async () => {
    const pf = findPaper(await rgbOf(await sharp(svg('<rect x="40" y="60" width="150" height="160" fill="#efe9da"/><rect x="194" y="60" width="150" height="160" fill="#efe9da"/>', "#2a2522")).png().toBuffer()));
    expect(pf.masks).toHaveLength(2);
  });

  it("finds nothing on a table about as light as the paper", async () => {
    const pf = findPaper(await rgbOf(await sharp(svg('<rect x="60" y="60" width="200" height="150" fill="#f2efe6"/>', "#eeebe2")).png().toBuffer()));
    expect(pf.masks).toEqual([]);
    expect(pf.split).toBeNull();
  });
});
