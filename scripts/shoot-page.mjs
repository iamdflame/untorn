// Shoot one page at desktop and phone, optionally seeking the hero: node scripts/shoot-page.mjs <url> <outDir> <prefix> [seekToEnd]
import { chromium } from "@playwright/test";
import path from "node:path";
const [url, out = ".", prefix = "page", seekEnd = ""] = process.argv.slice(2);
const b = await chromium.launch({ channel: process.env.SHOOT_CHANNEL || "msedge" });
const errors = [];
for (const [tag, opts] of [["desk", { viewport: { width: 1440, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
  const p = await (await b.newContext(opts)).newPage();
  p.on("pageerror", (e) => errors.push(`${tag}: ${e}`));
  p.on("console", (m) => m.type() === "error" && errors.push(`${tag}: ${m.text()}`));
  await p.goto(url);
  await p.waitForTimeout(2500);
  if (seekEnd) {
    await p.waitForFunction(() => window.untorn && window.untorn.state().assembled && window.untorn.state().cutsReady, null, { timeout: 30000 });
    const T = await p.evaluate(() => window.untorn.T);
    for (const [n, t] of [["mid", T.stepT[Math.floor(T.stepT.length / 2)] + 0.8], ["end", T.end]]) {
      await p.evaluate((v) => window.untorn.seek(v), t);
      await p.waitForTimeout(400);
      await p.screenshot({ path: path.join(out, `${prefix}-${tag}-${n}.png`) });
    }
  } else await p.screenshot({ path: path.join(out, `${prefix}-${tag}.png`) });
}
console.log(errors.length ? errors.join("\n") : "no console errors");
await b.close();
