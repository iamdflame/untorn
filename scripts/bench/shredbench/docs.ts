// Ground-truth documents for our ShredBench replica, in ShredBench's four domains and in their markdown formats:
//   news (en, zh)  "# News Article {k}\n**Date:** {date}\n\n" + paragraphs (each over 20 chars) joined by blank lines,
//                  800–2,500 characters of text;
//   code           "```{python|cpp|java}\n" + a whole source file of 1,000–4,000 characters + "\n```";
//   table          one HTML table (ShredBench converts arXiv cs.CL LaTeX tables with pandoc; we convert arXiv's
//                  LaTeXML HTML renderings with our own code, so the markup is plainer than theirs).
// Sources (all public): ShredBench's own 7 ground-truth files that have no published render (their exact text), then
// their own news sources (China Daily for English, People's Daily for Chinese), the local CPython standard library
// (PSF), C++ and Java files from permissively licensed GitHub repositories, and arXiv cs.CL papers' HTML. Every
// request carries a generic User-Agent and nothing else.
//
//   pnpm tsx scripts/bench/shredbench/docs.ts [--root DIR] [--per 18]
// Writes <root>/replica/docs/<domain>/<name>.md and <root>/replica/docs/sources.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { argValue, DEFAULT_ROOT } from "../../eval/shredbench/args";

const UA = { "User-Agent": "research-script/1.0" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Source = { domain: string; name: string; source: string; license: string; chars: number };

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(2000 * attempt);
  }
}

async function getText(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch {
      // a reset or timeout: try again
    }
    await sleep(2000 * attempt);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// News: ShredBench's own sources, China Daily (English) and People's Daily (Chinese), read the way their crawler
// reads them: every <p> of the article body, kept when longer than 20 characters (People's Daily: and not the editor
// line), joined by blank lines; 800–2,500 characters.

const stripTags = (s: string) => decode(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/[ \t\u00a0]+/g, " ").trim();

/** The inner HTML of the first element opening with `open` (a <div …> tag), nesting-aware. */
function element(html: string, open: RegExp): string | null {
  const m = open.exec(html);
  if (!m) return null;
  let depth = 1;
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = m.index + m[0].length;
  let t: RegExpExecArray | null;
  while ((t = re.exec(html))) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (!depth) return html.slice(m.index + m[0].length, t.index);
  }
  return null;
}

const paragraphsOf = (body: string, skip?: RegExp) =>
  [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => stripTags(p[1])).filter((t) => [...t].length > 20 && !(skip && skip.test(t)));

async function fetchDecoded(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const head = new TextDecoder("latin1").decode(bytes.slice(0, 2048));
      const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
      return new TextDecoder(/gb/i.test(charset) ? "gbk" : "utf-8").decode(bytes);
    } catch {
      await sleep(1500 * attempt);
    }
  }
  return null;
}

async function chinaDaily(want: number, startIndex: number): Promise<{ md: string; source: string }[]> {
  const links = new Set<string>();
  for (const section of ["china", "world", "business", "opinion"]) {
    const page = await fetchDecoded(`https://www.chinadaily.com.cn/${section}`);
    for (const m of (page ?? "").matchAll(/\/\/www\.chinadaily\.com\.cn\/a\/(20\d{4})\/(\d{2})\/WS[0-9a-f]+\.html/g)) links.add(`https:${m[0]}`);
    await sleep(500);
  }
  const out: { md: string; source: string }[] = [];
  let k = startIndex;
  for (const url of [...links].sort().reverse()) {
    if (out.length >= want) break;
    const html = await fetchDecoded(url);
    await sleep(500);
    const body = html && element(html, /<div id="Content">/i);
    if (!body) continue;
    const content = paragraphsOf(body).join("\n\n");
    const n = [...content].length;
    if (n < 800 || n > 2500) continue;
    const d = /\/a\/(20\d{2})(\d{2})\/(\d{2})\//.exec(url)!;
    out.push({ md: `# News Article ${k}\n**Date:** ${d[1]}-${d[2]}-${d[3]}\n\n${content}`, source: url });
    k++;
  }
  return out;
}

async function peoplesDaily(want: number, startIndex: number): Promise<{ md: string; source: string }[]> {
  const index = await getJson<{ items: { url: string; date: string }[] }>(`http://news.people.com.cn/210801/211150/index.js?_=${Date.now()}`);
  const seen = new Set<string>();
  const out: { md: string; source: string }[] = [];
  let k = startIndex;
  for (const item of index.items) {
    if (out.length >= want) break;
    const url = item.url.startsWith("/") ? `http://paper.people.com.cn${item.url}` : item.url.startsWith("http") ? item.url : `http://news.people.com.cn${item.url}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await fetchDecoded(url);
    await sleep(300);
    if (!html) continue;
    const body =
      element(html, /<div[^>]*class="rm_txt_con[^"]*"[^>]*>/i) ??
      element(html, /<div[^>]*class="rm_txt[^"]*"[^>]*>/i) ??
      element(html, /<div[^>]*class="layout w1000 txt_con"[^>]*>/i) ??
      element(html, /<div[^>]*class="col col-1 fl"[^>]*>/i);
    if (!body) continue;
    const content = paragraphsOf(body, /责任编辑/).join("\n\n");
    const n = [...content].length;
    if (n < 800 || n > 2500) continue;
    out.push({ md: `# News Article ${k}\n**Date:** ${item.date.slice(0, 10)}\n\n${content}`, source: url });
    k++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Code: whole files of 1,000–4,000 characters without tabs.

const PY_LIB = path.join(path.dirname(process.execPath), "..", "..", "..", "Programs", "Python", "Python312", "Lib");

function pythonFiles(want: number): { content: string; source: string }[] {
  const dirs = [process.env.PYTHON_LIB, PY_LIB, "C:/Users/Dflame/AppData/Local/Programs/Python/Python312/Lib"].filter((d): d is string => !!d && existsSync(d));
  if (!dirs.length) return [];
  const dir = dirs[0];
  const files = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  const out: { content: string; source: string }[] = [];
  for (const f of files) {
    const content = readFileSync(path.join(dir, f), "utf8").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (content.length < 1000 || content.length > 4000 || content.includes("\t")) continue;
    out.push({ content, source: `CPython 3.12 Lib/${f}` });
  }
  // spread over the alphabet rather than taking the first few
  const step = Math.max(1, Math.floor(out.length / want));
  return out.filter((_, i) => i % step === 0).slice(0, want);
}

async function githubFiles(repo: string, ref: string, ext: RegExp, want: number): Promise<{ content: string; source: string }[]> {
  const tree = await getJson<{ tree: { path: string; type: string; size?: number }[] }>(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
  const cands = tree.tree.filter((t) => t.type === "blob" && ext.test(t.path) && (t.size ?? 0) >= 1000 && (t.size ?? 0) <= 4000).sort((a, b) => a.path.localeCompare(b.path));
  const step = Math.max(1, Math.floor(cands.length / (3 * want)));
  const out: { content: string; source: string }[] = [];
  for (let i = 0; i < cands.length && out.length < want; i += step) {
    const raw = await getText(`https://raw.githubusercontent.com/${repo}/${ref}/${cands[i].path}`);
    if (!raw) continue;
    const content = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (content.length < 1000 || content.length > 4000 || content.includes("\t")) continue;
    out.push({ content, source: `github.com/${repo}@${ref}/${cands[i].path}` });
    await sleep(150);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tables: arXiv's LaTeXML HTML, reduced to plain rows and cells by our own parser.

function decode(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LATEX_SYMBOLS: Record<string, string> = {
  pm: "±", times: "×", uparrow: "↑", downarrow: "↓", rightarrow: "→", leftarrow: "←", cdot: "·", sim: "~", leq: "≤", geq: "≥",
  le: "≤", ge: "≥", approx: "≈", infty: "∞", checkmark: "✓", dagger: "†", ddagger: "‡", ast: "*", star: "⋆", circ: "∘",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", lambda: "λ", mu: "μ", sigma: "σ", tau: "τ", theta: "θ", Delta: "Δ",
  "%": "%", _: "_", "&": "&", "#": "#", $: "$", ",": " ", ";": " ", ":": " ", "!": "", " ": " ", textasciitilde: "~",
};

/** Simple LaTeX math (LaTeXML's alttext) as plain text, or null when it holds anything beyond symbols and styling. */
function mathText(tex: string): string | null {
  let s = tex.replace(/\\(?:mathbf|mathrm|textbf|textit|text|mathit|mathsf|mathtt|boldsymbol|bm|underline|emph)\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\([A-Za-z]+|[%_&#$,;:! ])/g, (m, name: string) => (name in LATEX_SYMBOLS ? LATEX_SYMBOLS[name] : m));
  s = s.replace(/[\^_]\{([^{}]*)\}/g, "$1").replace(/[\^_](\w)/g, "$1").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return s.includes("\\") ? null : s;
}

/** One plain HTML table from a LaTeXML table, or null when it holds hard math, images or nesting, or is too small. */
export function plainTable(html: string): string | null {
  if (/<img|<svg|<table[\s\S]*<table/i.test(html.slice(6))) return null;
  // simple math (numbers with ±, arrows, bold) becomes its text; anything harder rejects the table
  let mathOk = true;
  html = html.replace(/<math\b[^>]*alttext="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi, (_, alt: string) => {
    const t = mathText(decode(alt));
    if (t === null) mathOk = false;
    return t ?? "";
  });
  if (!mathOk || /<math/i.test(html)) return null;
  const rows: string[] = [];
  let cols = 0;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = rowRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let c: RegExpExecArray | null;
    let width = 0;
    while ((c = cellRe.exec(m[1]))) {
      const attrs = c[2];
      const text = decode(c[3].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      const colspan = /colspan="(\d+)"/.exec(attrs)?.[1];
      const rowspan = /rowspan="(\d+)"/.exec(attrs)?.[1];
      const tag = first || c[1].toLowerCase() === "th" ? "th" : "td";
      const span = `${colspan && colspan !== "1" ? ` colspan="${colspan}"` : ""}${rowspan && rowspan !== "1" ? ` rowspan="${rowspan}"` : ""}`;
      cells.push(`<${tag}${span}>${escapeHtml(text)}</${tag}>`);
      width += Number(colspan ?? 1);
    }
    if (!cells.length) continue;
    cols = Math.max(cols, width);
    rows.push(`<tr>${cells.join("")}</tr>`);
    first = false;
  }
  if (rows.length < 4 || rows.length > 16 || cols < 3 || cols > 8) return null;
  const out = `<table>\n${rows.join("\n")}\n</table>`;
  const text = out.replace(/<[^>]+>/g, "");
  if (text.length < 60 || out.length > 6000) return null;
  return out;
}

async function arxivTables(want: number): Promise<{ content: string; source: string }[]> {
  const feed = await getText(`https://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=${4 * want}`);
  const ids = [...(feed ?? "").matchAll(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/g)].map((x) => x[1]);
  const out: { content: string; source: string }[] = [];
  for (const id of ids) {
    if (out.length >= want) break;
    await sleep(3000); // arXiv asks automated clients for one request every few seconds
    const page = await getText(`https://arxiv.org/html/${id}`);
    if (!page) continue;
    const tables = [...page.matchAll(/<table[^>]*class="ltx_tabular[^"]*"[^>]*>[\s\S]*?<\/table>/g)].map((t) => plainTable(t[0])).filter((t): t is string => !!t);
    // one table per paper, the first usable one
    if (tables.length) out.push({ content: tables[0], source: `https://arxiv.org/html/${id}` });
    console.log(`arXiv ${id}: ${tables.length} usable table(s), ${out.length}/${want}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const root = path.join(argValue("--root") ?? DEFAULT_ROOT, "replica", "docs");
  const per = Number(argValue("--per") ?? 18);
  const only = argValue("--domains")?.split(",");
  const want = (d: string) => !only || only.includes(d);
  // keep what earlier runs fetched for the domains not asked for now
  const sourcesFile = path.join(root, "sources.json");
  const sources: Source[] = existsSync(sourcesFile) ? (JSON.parse(readFileSync(sourcesFile, "utf8")) as Source[]).filter((x) => !want(x.domain)) : [];
  const save = (domain: string, name: string, md: string, source: string, license: string) => {
    const dir = path.join(root, domain);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.md`), md);
    sources.push({ domain, name, source, license, chars: [...md].length });
  };

  // news_en: ShredBench's own ground truth for documents whose render is not published, then Wikinews
  const official = path.join(argValue("--root") ?? DEFAULT_ROOT, "official", "my_dataset");
  const rendered = new Set(["news_008", "news_031", "news_041"]);
  let en = 0;
  if (want("news_en") && existsSync(official)) {
    for (const f of readdirSync(official).filter((x) => x.endsWith(".md")).sort()) {
      const name = f.replace(/\.md$/, "");
      if (rendered.has(name)) continue;
      save("news_en", `sb_${name}`, readFileSync(path.join(official, f), "utf8"), "ShredBench my_dataset (their ground truth, no published render)", "Apache-2.0 (ShredBench repository)");
      en++;
    }
  }
  if (want("news_en")) for (const [i, a] of (await chinaDaily(per - en, 101)).entries()) save("news_en", `cd_${String(i + 1).padStart(3, "0")}`, a.md, a.source, "China Daily (ShredBench's English source; evaluation use only)");
  console.log(`news_en: ${sources.filter((s) => s.domain === "news_en").length}`);
  if (want("news_zh")) for (const [i, a] of (await peoplesDaily(per, 1)).entries()) save("news_zh", `pd_${String(i + 1).padStart(3, "0")}`, a.md, a.source, "People's Daily (ShredBench's Chinese source; evaluation use only)");
  console.log(`news_zh: ${sources.filter((s) => s.domain === "news_zh").length}`);

  // code: a third each of Python, C++ and Java
  const third = Math.ceil(per / 3);
  if (want("code")) {
  for (const [i, f] of pythonFiles(third).entries()) save("code", `py_${String(i + 1).padStart(3, "0")}`, "```python\n" + f.content + "\n```", f.source, "PSF-2.0");
  const cpp = [...(await githubFiles("google/googletest", "v1.15.2", /\.(cc|h)$/, Math.ceil(third / 2))), ...(await githubFiles("fmtlib/fmt", "11.0.2", /\.(cc|h)$/, third))].slice(0, third);
  for (const [i, f] of cpp.entries()) save("code", `cpp_${String(i + 1).padStart(3, "0")}`, "```cpp\n" + f.content + "\n```", f.source, f.source.includes("googletest") ? "BSD-3-Clause" : "MIT");
  const java = await githubFiles("google/gson", "gson-parent-2.11.0", /\.java$/, per - 2 * third);
  for (const [i, f] of java.entries()) save("code", `java_${String(i + 1).padStart(3, "0")}`, "```java\n" + f.content + "\n```", f.source, "Apache-2.0");
  console.log(`code: ${sources.filter((s) => s.domain === "code").length}`);
  }

  if (want("table")) for (const [i, t] of (await arxivTables(per)).entries()) save("table", `arxiv_${String(i + 1).padStart(3, "0")}`, t.content, t.source, "arXiv (per paper; used for evaluation only)");
  console.log(`table: ${sources.filter((s) => s.domain === "table").length}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(sourcesFile, JSON.stringify(sources, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
