// The judge's path (BLUEPRINT §2): the first screen plays a recorded run, "Run it live" runs the real pipeline on the
// same photo, the phone handoff starts a run on the laptop, bad input gets a designed error, and any run replays.

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

const SAMPLE = path.join(__dirname, "..", "data", "samples", "chouteau-1903", "photo.jpg");
// the first screen plays the manifest's default sample: its own transcript's first line must come back
const MANIFEST = JSON.parse(readFileSync(path.join(__dirname, "..", "public", "samples", "manifest.json"), "utf8")) as {
  default: string;
  samples: Record<string, { recorded: string }>;
};
const DEFAULT_RUN = JSON.parse(readFileSync(path.join(__dirname, "..", "public", MANIFEST.samples[MANIFEST.default].recorded), "utf8")) as {
  transcripts: { text: string }[];
};
const FIRST_LINE = DEFAULT_RUN.transcripts[0].text.split("\n")[0].trim();
const LIVE = !!process.env.E2E_LIVE;
const SHOTS = process.env.E2E_SHOTS;

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const shot = async (page: Page, name: string, fullPage = false) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
};

test("first screen: the recorded run plays, labelled, and ends in a rebuilt, read page", async ({ page }) => {
  const errors = watchErrors(page);
  const t0 = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".hero-photo")).toBeVisible();
  const firstPaintMs = Date.now() - t0;
  console.log(`first screen visible in ${firstPaintMs} ms`);
  expect(firstPaintMs).toBeLessThan(3000);
  await expect(page.locator(".honest")).toContainText("recorded run");
  await expect(page.getByRole("button", { name: "Run it live" })).toBeEnabled();
  await expect(page.locator('.hero[data-phase="outlined"], .hero[data-phase="assembling"]').first()).toBeVisible({ timeout: 8000 });
  await shot(page, "01-first-screen-outlines");
  await expect(page.locator(".rd-word")).toHaveText(/\w/, { timeout: 15000 });
  await shot(page, "02-first-screen-reading");
  await expect(page.locator('.hero[data-phase="whole"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".r-tx")).toContainText(FIRST_LINE, { ignoreCase: true, timeout: 15000 });
  await expect(page.locator(".key-list li:not(.key-sub)")).not.toHaveCount(0);
  await shot(page, "03-first-screen-whole", true);
  expect(errors).toEqual([]);
});

test("reduced motion shows the finished reconstruction as a still", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator('.hero.paused[data-phase="whole"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tx")).toBeVisible();
  await ctx.close();
});

test("a file that is not a photo gets a plain error with a way out", async ({ page }) => {
  await page.goto("/");
  await page.locator('.tear-drop input[type="file"]').setInputFiles({ name: "notes.jpg", mimeType: "image/jpeg", buffer: Buffer.from("this is not an image, just text pretending") });
  const alert = page.locator(".error-panel");
  await expect(alert).toBeVisible({ timeout: 15000 });
  await expect(alert).toContainText(/photo|image|open/i);
  await expect(alert.getByRole("button").first()).toBeVisible();
  await shot(page, "04-error-not-a-photo");
});

test("phone handoff: QR code, the phone sends a photo, the laptop starts the run", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Show a QR code" }).click();
  const codeEl = page.locator(".tear-phone .code");
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent())!.trim();
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  await expect(page.locator(".qr svg")).toBeVisible();
  await shot(page, "05-qr");

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.goto(`/c/${code}`);
  await expect(p.getByText("Photos are deleted within 24 hours and never used for training.")).toBeVisible();
  await expect(p.locator('input[type="file"][capture="environment"]')).toHaveCount(1);
  await shot(p, "06-phone-guide");
  await p.locator('input[type="file"]').setInputFiles(SAMPLE);
  await shot(p, "07-phone-check");
  await p.getByRole("button", { name: "Send to the laptop" }).click();
  await expect(p.getByRole("heading", { name: "Sent" })).toBeVisible({ timeout: 20000 });
  await shot(p, "08-phone-sent");
  await phone.close();

  // the laptop picks it up within a couple of polls and starts a live run
  const t0 = Date.now();
  await expect(page.locator('.hero[data-mode="live"]')).toBeVisible({ timeout: 6000 });
  console.log(`laptop picked up the phone photo in ${Date.now() - t0} ms`);
  if (!LIVE) return; // stop here without spending on models
  await expect(page.locator(".result .key-list")).toBeVisible({ timeout: 120000 });
  await shot(page, "08b-phone-run-done", true);
});

test("run it live: the real pipeline on the same photo, then its permalink replays", async ({ page }) => {
  test.skip(!LIVE, "set E2E_LIVE=1 to spend one real run (about $0.15)");
  test.setTimeout(150_000);
  const errors = watchErrors(page);
  await page.goto("/");
  const t0 = Date.now();
  await page.getByRole("button", { name: "Run it live" }).click();
  await expect(page.locator(".honest")).toContainText("Live run");
  await expect(page.locator(".status")).toContainText("SAM 3.1", { timeout: 5000 });
  const firstStageMs = Date.now() - t0;
  await expect(page.locator('.hero[data-phase="outlined"], .hero[data-phase="reading"]').first()).toBeVisible({ timeout: 30000 });
  await shot(page, "09-live-outlines");
  await expect(page.locator(".rd-word, .rd-note").first()).toHaveText(/\w/, { timeout: 40000 });
  await shot(page, "10-live-reading");
  await expect(page.locator(".result .key-list")).toBeVisible({ timeout: 120000 });
  const liveMs = Date.now() - t0;
  await shot(page, "11-live-done", true);
  console.log(`live run: first stage ${firstStageMs} ms, done ${liveMs} ms`);
  const href = await page.getByRole("link", { name: "Permalink" }).getAttribute("href");
  expect(href).toMatch(/^\/r\/[a-z0-9]+$/);
  await page.goto(href!);
  await expect(page.locator('.hero[data-phase="assembling"], .hero[data-phase="whole"]').first()).toBeVisible({ timeout: 30000 });
  await shot(page, "12-permalink");
  expect(errors).toEqual([]);
});

test("unknown runs and pages are a designed 404", async ({ page }) => {
  await page.goto("/r/doesnotexist1");
  await expect(page.locator(".error-panel")).toContainText("Nothing here");
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
});

test("accuracy page and health endpoint", async ({ page, request }) => {
  await page.goto("/accuracy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How accurate is it?");
  const h = await request.get("/api/health");
  expect(h.ok()).toBe(true);
  expect(await h.json()).toMatchObject({ ok: true, modelKey: true });
});
