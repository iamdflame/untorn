// The app's own accuracy page (a page view, no model calls): full-page screenshots at 2x, plus one viewport frame per
// section heading, so the film can show the ShredBench numbers where the product publishes them.
//   APP_URL=https://untorn.vercel.app node scripts/capture/accuracy.mjs   ->  capture/accuracy/
import path from "node:path";
import { APP, CAPTURE, ensureDir, launch, laptop, shot, writeJson } from "./lib.mjs";

const OUT = ensureDir(path.join(CAPTURE, "accuracy"));
const browser = await launch();
const ctx = await laptop(browser);
const page = await ctx.newPage();
await page.goto(`${APP}/accuracy`, { waitUntil: "networkidle", timeout: 60000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
await shot(page, path.join(OUT, "full.png"), {});
await page.screenshot({ path: path.join(OUT, "full-page.jpg"), type: "jpeg", quality: 92, fullPage: true, scale: "device" });

// where each heading sits, and a viewport frame scrolled to it
const heads = await page.evaluate(() =>
  [...document.querySelectorAll("h1, h2, h3")].map((h) => ({ tag: h.tagName, text: h.textContent?.trim() ?? "", y: h.getBoundingClientRect().top + window.scrollY })),
);
writeJson(path.join(OUT, "headings.json"), heads);
let i = 0;
for (const h of heads) {
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 120)), h.y);
  await page.waitForTimeout(400);
  await shot(page, path.join(OUT, `sec-${String(i++).padStart(2, "0")}.jpg`), {});
}
await browser.close();
console.log(heads.map((h) => `${h.tag} ${Math.round(h.y)} ${h.text}`).join("\n"));
