// Shoot a live run of the sample on the first screen (spends one real run, about $0.15):
//   node scripts/shoot-live.mjs <baseUrl> <outDir> <prefix> [desk|phone]
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [base = "http://localhost:3311", out = ".", prefix = "live", which = "desk"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const opts = which === "phone" ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } };
const browser = await chromium.launch({ channel: process.env.SHOOT_CHANNEL || "msedge" });
const page = await (await browser.newContext(opts)).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/");
await page.waitForFunction(() => window.untorn && window.untorn.state().assembled, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const t0 = Date.now();
await page.evaluate(() => [...document.querySelectorAll(".honest button")].find((b) => b.textContent.includes("Run it live")).click());
const shot = (n) => page.screenshot({ path: path.join(out, `${prefix}-${which}-${n}.png`) });
const phases = new Set();
let lastShot = 0;
for (;;) {
  const ph = await page.evaluate(() => document.querySelector(".hero").dataset.phase + "|" + (document.querySelector(".status")?.textContent ?? ""));
  const [phase] = ph.split("|");
  const s = (Date.now() - t0) / 1000;
  if (!phases.has(phase)) {
    phases.add(phase);
    console.log(`${s.toFixed(1)} s: ${ph}`);
    await page.waitForTimeout(phase === "assembling" ? 1200 : 300);
    await shot(`${String(phases.size).padStart(2, "0")}-${phase}`);
  } else if (s - lastShot > 4) {
    lastShot = s;
    await shot(`t${Math.round(s).toString().padStart(3, "0")}`);
    console.log(`${s.toFixed(1)} s: ${ph}`);
  }
  const done = await page.evaluate(() => !!document.querySelector(".result .key-list"));
  const err = await page.evaluate(() => !!document.querySelector(".error-panel"));
  if (done && phases.has("whole")) {
    await page.waitForTimeout(4000);
    await shot("99-end");
    await page.evaluate(() => document.getElementById("result").scrollIntoView());
    await page.waitForTimeout(1500);
    await shot("99-result");
    break;
  }
  if (err) {
    await shot("98-error");
    break;
  }
  if (s > 150) break;
  await page.waitForTimeout(500);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(errors.length ? errors.join("\n") : "no console errors");
await browser.close();
