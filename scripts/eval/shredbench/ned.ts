// ShredBench's text metric, re-implemented exactly as their metric.py computes it (calculate_metrics → "cer", which
// the README reports as NED): Levenshtein distance between prediction and ground truth, divided by the longer one's
// length, both files read as UTF-8 text with Python's universal newlines and then str.strip()-ed. Lower is better.
//
// Python semantics that matter here:
// - len() and Levenshtein.distance() count code points, not UTF-16 units (one emoji is 1, not 2);
// - open(..., "r") turns "\r\n" and "\r" into "\n" before anything else sees the text;
// - str.strip() removes the str.isspace() set below (it keeps U+FEFF and U+200B, unlike JavaScript's trim()).

const PY_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Code points of a string (what Python indexes and counts). */
export const codePoints = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!);

/** Python's str.strip() with no arguments. Every space in the set is a single UTF-16 unit, so units suffice. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** What their read_file() returns for a file's decoded contents: universal newlines, then strip. */
export function readText(raw: string): string {
  return pyStrip(raw.replace(/\r\n?/g, "\n"));
}

/** Levenshtein distance over code points (unit costs), two rows of Int32Array. */
export function levenshtein(a: string | number[], b: string | number[]): number {
  let s = typeof a === "string" ? codePoints(a) : a;
  let t = typeof b === "string" ? codePoints(b) : b;
  if (s.length < t.length) [s, t] = [t, s];
  const m = t.length;
  if (!m) return s.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    const si = s[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (si === t[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/** NED of two already-read texts (apply readText first when they come from files). 0 when both are empty. */
export function ned(pred: string, gt: string): number {
  const p = codePoints(pred);
  const g = codePoints(gt);
  const maxLen = Math.max(p.length, g.length);
  return maxLen ? levenshtein(p, g) / maxLen : 0;
}

/** NED of two raw file contents, exactly as metric.py scores a prediction file against its ground-truth file. */
export function nedFiles(predRaw: string, gtRaw: string): number {
  return ned(readText(predRaw), readText(gtRaw));
}
