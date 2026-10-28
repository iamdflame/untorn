// Shoot the design: desktop 1440×900 and phone 390×844 at fixed moments of the hero (seeked deterministically through
// window.untorn), plus the result, /c/<code>, /accuracy and 404. Usage:
//   node scripts/shoot-design.mjs <baseUrl> <outDir> <prefix> [desk|phone|both] [only,comma,list]
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [base = "http://localhost:3311", out = ".", prefix = "s", which = "both", onlyArg = ""] = process.argv.slice(2);
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
fs.mkdirSync(out, { recursive: true });
const want = (n) => !only || only.has(n);
const errors = [];

async function shootHero(page, tag) {
  const shot = (n) => page.screenshot({ path: path.join(out, `${prefix}-${tag}-${n}.png`) });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  // first paint: the photo before any script work
  await page.waitForTimeout(500);
  if (want("hero-0.5s")) await shot("hero-0.5s");
  await page.waitForFunction(() => window.untorn && window.untorn.state().assembled && window.untorn.state().cutsReady, null, { timeout: 30000 });
  const T = await page.evaluate(() => window.untorn.T);
  const st = await page.evaluate(() => window.untorn.state());
  const seek = async (t, n, wait = 250) => {
    await page.evaluate((v) => window.untorn.seek(v), t);
    await page.waitForTimeout(wait);
    if (want(n)) await shot(n);
  };
  await seek(1.6, "hero-trace");
  await seek(3.0, "hero-3s");
  await seek(T.stepT[1] + 0.9, "hero-step1");
  const beats = await page.evaluate(() => window.untorn.beats && window.untorn.beats());
  if (beats && beats.length) await seek(beats[0].t0 + 1.0, "hero-read");
  if (T.cl0 > 0) {
    await seek(T.cl0 + 0.9, "hero-climax-open");
    await seek(T.cl0 + 2.6, "hero-climax");
  }
  await seek(T.whole + 0.6, "hero-whole");
  if (T.tw1 > T.tw0) {
    await seek(T.tw0 + 2.2, "hero-twins-ask");
    await seek(T.tw1 - 0.8, "hero-twins");
  }
  await seek(T.end, "hero-end");
  await page.evaluate(() => window.untorn.J(1));
  await page.waitForTimeout(900);
  if (want("hero-joinmap")) await shot("hero-joinmap");
  await page.evaluate(() => window.untorn.J(0));
  if (want("result")) {
    await page.evaluate(() => document.getElementById("result").scrollIntoView());
    await page.waitForTimeout(1200);
    await shot("result");
  }
  if (want("full")) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${prefix}-${tag}-full.png`), fullPage: true });
  }
  return st;
}

async function run(tag, ctxOpts) {
  const browser = await chromium.launch({ channel: process.env.SHOOT_CHANNEL || "msedge" });
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${tag} console: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e}`));
  const st = await shootHero(page, tag);
  if (want("accuracy")) {
    await page.goto(base + "/accuracy");
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, `${prefix}-${tag}-accuracy.png`) });
    await page.screenshot({ path: path.join(out, `${prefix}-${tag}-accuracy-full.png`), fullPage: true });
  }
  if (want("404")) {
    await page.goto(base + "/no-such-page");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${prefix}-${tag}-404.png`) });
  }
  if (want("capture")) {
    await page.goto(base + "/c/ABCDEF");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${prefix}-${tag}-capture.png`) });
  }
  if (want("reduced")) {
    const rctx = await browser.newContext({ ...ctxOpts, reducedMotion: "reduce" });
    const rp = await rctx.newPage();
    rp.on("pageerror", (e) => errors.push(`${tag} reduced pageerror: ${e}`));
    await rp.goto(base + "/");
    await rp.waitForFunction(() => window.untorn && window.untorn.state().cutsReady, null, { timeout: 30000 });
    await rp.waitForTimeout(800);
    await rp.screenshot({ path: path.join(out, `${prefix}-${tag}-reduced.png`) });
    await rctx.close();
  }
  await browser.close();
  return st;
}

const res = {};
if (which === "both" || which === "desk") res.desk = await run("desk", { viewport: { width: 1440, height: 900 } });
if (which === "both" || which === "phone") res.phone = await run("phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
console.log(JSON.stringify(res));
console.log(errors.length ? errors.join("\n") : "no console errors");
