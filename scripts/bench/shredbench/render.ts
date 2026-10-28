// Render the replica's ground-truth documents as ShredBench describes: "raw text/code/tables are rendered into
// high-resolution images (1600px width) using a headless Chrome browser". Our own Markdown→HTML conversion (headings,
// bold, paragraphs with line breaks kept, fenced code, raw HTML tables) and a page style with ShredBench's values
// (1600 px wide, 60 px padding, 28 px Times New Roman / SimSun, line height 1.6, warm white paper, 1 px table rules).
// Differences, stated: no MathJax (a "$" stays a dollar sign) and no paper-noise texture.
//
//   pnpm tsx scripts/bench/shredbench/render.ts [--root DIR]     → <root>/replica/pages/<domain>/<name>.png
// Uses the machine's installed Chrome through Playwright (no browser download).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { argValue, DEFAULT_ROOT } from "../../eval/shredbench/args";

export const PAGE_WIDTH = 1600;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

/** The Markdown our documents use, as HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>\n")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code class="language-${fence[1]}">${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*<table/i.test(line)) {
      flush();
      const html: string[] = [];
      for (; i < lines.length; i++) {
        html.push(lines[i]);
        if (/<\/table>\s*$/i.test(lines[i])) break;
      }
      out.push(html.join("\n"));
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out.join("\n");
}

export function pageHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body { width: ${PAGE_WIDTH}px; margin: 0; padding: 60px; box-sizing: border-box; background: #fdfbf7;
  font-family: 'Times New Roman', 'SimSun', serif; color: #111; font-size: 28px; line-height: 1.6; }
h1 { font-size: 2.2em; border-bottom: 3px solid #333; padding-bottom: 20px; margin-bottom: 40px; text-align: center; }
h2 { font-size: 1.8em; border-bottom: 1px solid #aaa; margin-top: 50px; padding-bottom: 10px; }
h3 { font-size: 1.4em; font-weight: bold; margin-top: 30px; }
p { margin-bottom: 20px; text-align: justify; }
pre { background: #eee; padding: 20px; border-radius: 5px; overflow-x: auto; font-family: monospace; }
code { font-family: monospace; }
table { border-collapse: collapse; width: 100%; margin: 30px 0; }
th, td { border: 1px solid #999; padding: 12px; text-align: left; }
th { background-color: #eee; font-weight: bold; }
</style></head><body>
${body}
</body></html>`;
}

async function main() {
  const root = argValue("--root") ?? DEFAULT_ROOT;
  const docs = path.join(root, "replica", "docs");
  // the machine's own Chrome (headless), as ShredBench used; Edge when Chrome is missing. Nothing is downloaded.
  const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
  const page = await browser.newPage({ viewport: { width: PAGE_WIDTH, height: 1000 }, deviceScaleFactor: 1 });
  let n = 0;
  for (const domain of readdirSync(docs).filter((d) => !d.includes("."))) {
    for (const f of readdirSync(path.join(docs, domain)).filter((x) => x.endsWith(".md")).sort()) {
      const out = path.join(root, "replica", "pages", domain, f.replace(/\.md$/, ".png"));
      if (existsSync(out)) continue;
      mkdirSync(path.dirname(out), { recursive: true });
      await page.setContent(pageHtml(markdownToHtml(readFileSync(path.join(docs, domain, f), "utf8"))), { waitUntil: "load" });
      // like ShredBench: the page is as tall as its content plus 100 px, at least 1,000 px
      const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.body.offsetHeight, 1000));
      await page.setViewportSize({ width: PAGE_WIDTH, height: height + 100 });
      await page.screenshot({ path: out, fullPage: false });
      n++;
    }
  }
  await browser.close();
  console.log(`rendered ${n} pages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
