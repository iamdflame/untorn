// Phase 1 of the golden path: ONE real live run, phone to laptop, on the local production build. The laptop page's
// fetch is wrapped so every streamed run event is logged with its arrival time; the phone's screens are captured at
// 3x; reference frames of the laptop are taken in real time. Costs one live run (about $0.15 of the Meta budget).
//   node scripts/capture/golden-live.mjs [sample photo]   ->  capture/golden/
import fs from "node:fs";
import path from "node:path";
import { devices } from "playwright";
import { APP, CAPTURE, ensureDir, heroReady, launch, laptop, shot, writeJson } from "./lib.mjs";

const photo = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../../../data/samples/chouteau-1903/photo.jpg"));
const OUT = ensureDir(path.join(CAPTURE, "golden"));
const REF = ensureDir(path.join(OUT, "live-ref"));
const PHONE = ensureDir(path.join(OUT, "phone"));

const LOGGER = () => {
  const of = window.fetch.bind(window);
  window.__runLog = [];
  window.__runMeta = {};
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const res = await of(input, init);
    if (url.includes("/api/sessions") && (init?.method ?? "GET") === "POST") {
      res.clone().json().then((j) => (window.__runMeta.session = { at: performance.now(), body: j }));
    }
    if (url.includes("/api/sessions/") && (init?.method ?? "GET") === "GET") {
      res.clone().json().then((j) => (window.__runMeta.polls = [...(window.__runMeta.polls ?? []), { at: performance.now(), body: j }]));
    }
    if (url.endsWith("/api/runs") && init?.method === "POST" && res.body) {
      const [a, b] = res.body.tee();
      window.__runMeta.runStart = performance.now();
      window.__runMeta.request = typeof init.body === "string" ? init.body : null;
      (async () => {
        const reader = b.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) window.__runLog.push({ at: performance.now(), line });
          }
        }
        window.__runMeta.runEnd = performance.now();
      })();
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
};

const browser = await launch();
const lap = await laptop(browser);
await lap.addInitScript(LOGGER);
const page = await lap.newPage();
page.on("console", (m) => m.type() === "error" && console.log("laptop console:", m.text()));
await page.goto(APP + "/", { waitUntil: "load" });
await heroReady(page);
await page.waitForTimeout(800);
await shot(page, path.join(OUT, "laptop-00-hero.png"));

// "Tear your own": the section with the phone option
await page.locator("#tear").scrollIntoViewIfNeeded();
await page.evaluate(() => document.getElementById("tear").scrollIntoView({ block: "start" }));
await page.waitForTimeout(700);
await shot(page, path.join(OUT, "laptop-01-tear.png"));
await page.getByRole("button", { name: "Show a QR code" }).click();
await page.locator(".qr svg").waitFor({ timeout: 20000 });
await page.waitForTimeout(400);
await shot(page, path.join(OUT, "laptop-02-qr.png"));
const code = (await page.locator(".tear .code").first().textContent()).trim();
console.log("session code", code);

// the phone
const ph = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 }, colorScheme: "dark", locale: "en-GB", timezoneId: "UTC" });
const phone = await ph.newPage();
await phone.goto(`${APP}/c/${code}`, { waitUntil: "load" });
await phone.getByText("One photo of the torn pieces").waitFor({ timeout: 20000 });
await phone.waitForTimeout(400);
await phone.screenshot({ path: path.join(PHONE, "phone-1-guide.png") });
await phone.locator('input[type="file"]').setInputFiles(photo);
await phone.getByText("Check the photo").waitFor({ timeout: 20000 });
await phone.waitForTimeout(600);
await phone.screenshot({ path: path.join(PHONE, "phone-2-check.png") });
const sendAt = Date.now();
await phone.getByRole("button", { name: "Send to the laptop" }).click();
try {
  await phone.getByText("Sending…").waitFor({ timeout: 3000 });
  await phone.screenshot({ path: path.join(PHONE, "phone-3-sending.png") });
} catch {}
await phone.getByRole("heading", { name: "Sent" }).waitFor({ timeout: 60000 });
await phone.waitForTimeout(300);
await phone.screenshot({ path: path.join(PHONE, "phone-4-sent.png") });
console.log("sent in", Date.now() - sendAt, "ms");

// the laptop picks it up and runs live: reference frames in real time until done
const t0 = Date.now();
let n = 0;
for (;;) {
  const st = await page.evaluate(() => ({ end: window.__runMeta.runEnd ?? null, n: window.__runLog.length }));
  await shot(page, path.join(REF, `ref-${String(n++).padStart(4, "0")}.jpg`), { quality: 80 });
  if (st.end && Date.now() - t0 > 3000) break;
  if (Date.now() - t0 > 240000) {
    console.log("timeout waiting for the run");
    break;
  }
  await page.waitForTimeout(250);
}
// let the transcript type in and the page settle
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(500);
  await shot(page, path.join(REF, `ref-${String(n++).padStart(4, "0")}.jpg`), { quality: 80 });
}
const log = await page.evaluate(() => ({ events: window.__runLog, meta: window.__runMeta }));
const done = log.events.map((e) => JSON.parse(e.line)).find((e) => e.type === "done");
writeJson(path.join(OUT, "run-events.json"), { code, photo: path.basename(photo), ...log, runId: done?.result?.runId ?? null });
console.log("events", log.events.length, "runId", done?.result?.runId, "total ms", done?.result?.timings?.total, "cost", JSON.stringify(done?.result?.cost));

// the result below the hero, in the real page (reference stills at 2x)
await page.evaluate(() => document.getElementById("result")?.scrollIntoView({ block: "start" }));
await page.waitForTimeout(2500);
await shot(page, path.join(OUT, "laptop-10-result.png"));
await page.evaluate(() => document.querySelector(".key")?.scrollIntoView({ block: "start" }));
await page.waitForTimeout(1500);
await shot(page, path.join(OUT, "laptop-11-joinmap.png"));
await browser.close();
fs.writeFileSync(path.join(OUT, "DONE"), new Date().toISOString());
