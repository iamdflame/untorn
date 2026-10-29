// Print the LCP entries a phone-sized viewport sees: node scripts/lcp-probe.mjs <url>
import { chromium } from "@playwright/test";
const b = await chromium.launch({ channel: "msedge" });
const p = await (await b.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true })).newPage();
await p.addInitScript(() => {
  window.__lcp = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lcp.push({ t: Math.round(e.startTime), r: Math.round(e.renderTime), l: Math.round(e.loadTime), size: e.size, el: e.element ? e.element.tagName + "." + e.element.className : null, url: e.url }))).observe({ type: "largest-contentful-paint", buffered: true });
});
await p.goto(process.argv[2] || "http://localhost:3320/");
await p.waitForTimeout(Number(process.argv[3] || 6000));
console.log(JSON.stringify(await p.evaluate(() => window.__lcp), null, 1));
await b.close();
