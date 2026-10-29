// CPU profile of the first seconds of the first screen (phone-sized, 4x CPU throttle): the hottest functions by self time.
//   node scripts/profile-hero.mjs <url> [seconds]
import { chromium } from "@playwright/test";
import fs from "node:fs";
const [url = "http://localhost:3320/", secs = "6"] = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge" });
const ctx = await b.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await p.goto(url);
await p.waitForTimeout(Number(secs) * 1000);
const { profile } = await cdp.send("Profiler.stop");
const dt = profile.timeDeltas;
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
const top = [...self.entries()].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, v] of top) {
  const m = k.match(/ (\S+\.js):(\d+):(\d+)$/);
  let snip = "";
  if (m && process.env.CHUNKS) {
    try {
      const src = fs.readFileSync(`${process.env.CHUNKS}/${m[1]}`, "utf8").split(/\r?\n/)[Number(m[2])] ?? "";
      snip = src.slice(Number(m[3]), Number(m[3]) + 90).replace(/\s+/g, " ");
    } catch {}
  }
  console.log(v.toFixed(0).padStart(6), "ms", k, snip);
}
await b.close();
