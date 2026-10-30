// Phase 2 of the golden path: the recorded live run, re-played through the app's own live code path under a
// controlled clock, so every frame is a crisp 3840x2160 screenshot at an exact time. The session and run responses
// are the ones the real run produced (run-events.json), delivered at their real arrival times; the one long wait
// (a slow read) is shortened, and the real elapsed time of every frame is logged so the film can show it.
//   node scripts/capture/golden-replay.mjs [segment]   segments: tear, live, result (default: all)
import fs from "node:fs";
import path from "node:path";
import { APP, CAPTURE, ensureDir, heroReady, launch, laptop, writeJson } from "./lib.mjs";

const OUT = ensureDir(path.join(CAPTURE, process.env.GOLDEN_DIR ?? "golden"));
const rec = JSON.parse(fs.readFileSync(path.join(OUT, "run-events.json"), "utf8"));
const STEP = 32; // ms of page time per frame: two of the page's 16 ms animation frames (played at 30 fps: 4 % slower)
const want = process.argv[2] ?? "all";

// the run's events on its own clock (ms after the request), with the long wait shortened
const t0 = rec.meta.runStart;
const raw = rec.events.map((e) => ({ at: e.at - t0, line: e.line }));
const MAX_GAP = 2500;
// gaps are measured between real events (ticks every 5 s carry nothing but "still working"); only the long wait
// after the reading stage got going is shortened, and the ticks inside it are dropped
const real = raw.filter((e) => JSON.parse(e.line).type !== "tick");
const cuts = [];
for (let i = 1; i < real.length; i++) {
  const gap = real[i].at - real[i - 1].at;
  if (gap > MAX_GAP && real[i - 1].at > 15000) cuts.push({ realFrom: real[i - 1].at, realTo: real[i].at, cutMs: gap - MAX_GAP });
}
const shiftAt = (at) => cuts.reduce((n, c) => n + (at >= c.realTo ? c.cutMs : 0), 0);
const inCut = (at) => cuts.some((c) => at > c.realFrom && at < c.realTo);
const evs = raw.filter((e) => !(JSON.parse(e.line).type === "tick" && inCut(e.at))).map((e) => ({ at: e.at - shiftAt(e.at), real: e.at, line: e.line }));

const STUB = ({ evs, session, photoId, pollsBeforePhoto }) => {
  window.__fake = { evs, session, photoId, pollsBeforePhoto, polls: 0, runAt: null };
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const F = window.__fake;
    if (url.endsWith("/api/sessions") && method === "POST") return new Response(JSON.stringify(F.session), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes(`/api/sessions/${F.session.code}`) && method === "GET") {
      F.polls++;
      const body = F.polls > F.pollsBeforePhoto ? { ...F.session, status: "photo", photoId: F.photoId } : { ...F.session, status: "waiting" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/runs") && method === "POST") {
      F.runAt = performance.now();
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctrl) {
          let left = F.evs.length;
          for (const e of F.evs)
            setTimeout(() => {
              ctrl.enqueue(enc.encode(e.line + "\n"));
              if (--left === 0) ctrl.close();
            }, e.at);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    return of(input, init);
  };
  // instant scrolling: the capture moves the page itself, frame by frame
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    return siv.call(this, typeof arg === "object" ? { ...arg, behavior: "auto" } : arg);
  };
  // CSS animations and transitions follow the page clock
  const seen = new WeakMap();
  window.__syncAnims = () => {
    const now = performance.now();
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) seen.set(a, now);
      try {
        a.pause();
        a.currentTime = now - seen.get(a);
      } catch {}
    }
  };
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    s.textContent = "html{scroll-behavior:auto!important}";
    document.head.appendChild(s);
  });
};

const browser = await launch();
const ctx = await laptop(browser);
await ctx.addInitScript(STUB, { evs, session: rec.meta.session.body, photoId: rec.meta.polls.at(-1).body.photoId, pollsBeforePhoto: 1 });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.clock.install({ time: new Date("2026-10-30T09:00:00Z") });
await page.goto(APP + "/", { waitUntil: "load" });
await heroReady(page);
await page.evaluate(() => document.getElementById("tear").scrollIntoView({ block: "start" }));
await page.waitForTimeout(500);
await page.clock.pauseAt(new Date(Date.parse("2026-10-30T09:00:00Z") + 60_000));

let frameNo = 0;
const log = [];
async function frame(dir, extra = {}) {
  await page.clock.runFor(STEP);
  await page.evaluate(() => window.__syncAnims());
  const f = path.join(dir, `f${String(frameNo).padStart(5, "0")}.jpg`);
  await page.screenshot({ path: f, type: "jpeg", quality: 92, scale: "device" });
  const st = await page.evaluate(() => ({ now: performance.now(), runAt: window.__fake.runAt, y: scrollY }));
  log.push({ frame: frameNo, file: path.basename(f), seg: path.basename(dir), pageNow: st.now, runMs: st.runAt != null ? st.now - st.runAt : null, scrollY: st.y, ...extra });
  frameNo++;
}

// 1 · the tear section: the button, the QR code appears, the phone's photo lands
const TEAR = ensureDir(path.join(OUT, "seq-tear"));
if (want === "all" || want === "tear") {
  for (let i = 0; i < 20; i++) await frame(TEAR);
  await page.getByRole("button", { name: "Show a QR code" }).click();
  for (let i = 0; i < 110; i++) await frame(TEAR); // ~3.5 s: the code waits; the first poll says "waiting", the next brings the photo
}

// 2 · the live run in the hero (the app jumps to the top when the photo arrives)
const LIVE = ensureDir(path.join(OUT, "seq-live"));
if (want === "all" || want === "live") {
  let doneSeen = null;
  for (let i = 0; i < 2600; i++) {
    await frame(LIVE);
    const s = await page.evaluate(() => ({ status: document.querySelector(".honest")?.textContent ?? "", t: window.untorn?.state().t ?? 0, end: window.untorn?.T.end ?? 1e9 }));
    if (!doneSeen && /photo to page/.test(s.status)) doneSeen = frameNo;
    // after "done", let the assembly, the climax and the transcript play out to the engine's own end, then hold 1.5 s
    if (doneSeen && s.t >= s.end) {
      for (let k = 0; k < 47; k++) await frame(LIVE);
      break;
    }
    if (process.env.LIMIT && frameNo > Number(process.env.LIMIT)) break;
  }
}

// 3 · the result below: an eased scroll to the rebuilt page and transcript, a hold, then on to the join map
const RES = ensureDir(path.join(OUT, "seq-result"));
if (want === "all" || want === "result") {
  const y0 = await page.evaluate(() => scrollY);
  const yRes = await page.evaluate(() => document.getElementById("result").getBoundingClientRect().top + scrollY);
  const yKey = await page.evaluate(() => (document.querySelector(".key")?.getBoundingClientRect().top ?? 0) + scrollY - 40);
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const scrollTo = async (from, to, n) => {
    for (let i = 1; i <= n; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + (to - from) * ease(i / n)));
      await frame(RES);
    }
  };
  await scrollTo(y0, yRes, 45);
  for (let i = 0; i < 120; i++) await frame(RES);
  await scrollTo(yRes, yKey, 50);
  for (let i = 0; i < 120; i++) await frame(RES);
}

writeJson(path.join(OUT, "replay-log.json"), { step: STEP, cuts, frames: log });
console.log("frames", frameNo, "cuts", JSON.stringify(cuts));
await browser.close();
