// Shared capture helpers: a branded Chrome (the same major as Playwright's Chromium), 2x density, and the hero's own
// clock hook (window.untorn.seek) so every frame is drawn at an exact time instead of whenever a screenshot lands.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export const APP = process.env.APP_URL ?? "http://localhost:3470";
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
export const CAPTURE = path.join(ROOT, "capture");

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function launch() {
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
}

/** A laptop: 1920x1080 CSS px at 2x, so footage is 3840x2160 and can be framed in at up to 2x without losing a pixel. */
export async function laptop(browser, { width = 1920, height = 1080, dsf = 2 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    locale: "en-GB",
    timezoneId: "UTC",
  });
  return ctx;
}

/** Wait until the hero engine has its photo, cut-outs and scene, and the fonts are in. */
export async function heroReady(page, { timeout = 60000 } = {}) {
  await page.waitForFunction(
    () => {
      const u = window.untorn;
      if (!u) return false;
      const s = u.state();
      return s.cutsReady && s.assembled && document.fonts.status === "loaded";
    },
    null,
    { timeout, polling: 100 },
  );
}

/** Draw the hero at time t (seconds) and wait until it has painted. The engine pauses on seek; the play icon is put
 * back to the playing state, which is what a viewer sees while the recording plays. */
export async function heroAt(page, t) {
  await page.evaluate(async (tt) => {
    window.untorn.seek(tt);
    document.querySelector(".hero")?.classList.remove("paused");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    document.querySelector(".hero")?.classList.remove("paused");
  }, t);
}

export async function shot(page, file, opts = {}) {
  ensureDir(path.dirname(file));
  const type = file.endsWith(".png") ? "png" : "jpeg";
  await page.screenshot({ path: file, type, ...(type === "jpeg" ? { quality: opts.quality ?? 94 } : {}), clip: opts.clip, animations: "allow", caret: "initial", scale: "device" });
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
