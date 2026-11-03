// The archive record for a rebuilt page: what Muse wrote, kept only where its words are on the page.
// Every field quotes the transcript, and code checks each quote against the text (case, accents, spacing and quote
// marks aside; a quote must match whole words). A name must be the quote's own words, or the quote stands in for it;
// a date's ISO form must agree with the numbers written. What fails is left out and counted, never shown.
// Pure (no imports beyond types and the gap marker): tests and the bench scripts load it.

import type { PageRecord, RecordField, RecordKind } from "@/lib/run/types";
import { GAP, RECORD_KINDS } from "./prompts";

export type RawNamed = { name: string; quote: string };
/** The model's answer, shaped by CATALOG_SCHEMA. */
export type RawRecord = {
  kind: string;
  date: { quote: string; iso: string };
  place: RawNamed;
  from: RawNamed;
  to: RawNamed;
  people: RawNamed[];
  places: RawNamed[];
  organisations: RawNamed[];
  summary: string;
};

/** Most names kept per list. */
const MAX_NAMES = 12;
const MAX_SUMMARY = 360;

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
/** Case, accents, quote styles, dashes and runs of white space don't count; the gap marker has one spelling. */
const flat = (s: string) =>
  fold(s.replace(/\[\s*(?:\.\s*\.\s*\.|…)\s*\]/g, GAP))
    .replace(/[‘’‚‛ʼ`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
const EDGE = /^[\s,.;:!?'"‘’“”„«»()[\]{}*_-]+|[\s,.;:!?'"‘’“”„«»()[\]{}*_-]+$/g;
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const tokens = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** The transcript in the forms a quote is looked up in: as read, and with words broken across a line ("strug-\ngle")
 *  joined again. */
export function pageText(transcript: string): string[] {
  const joined = transcript.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, "$1$2");
  return [...new Set([flat(transcript), flat(joined)])];
}

/** The quote with its outer punctuation trimmed, when it is on the page as whole words; null when it isn't. */
export function onPage(quote: string, page: string[]): string | null {
  // a name or date cut by a gap is not on the page
  if (/[[\]…]|\.\.\./.test(quote)) return null;
  const q = quote.trim().replace(EDGE, "");
  if (tokens(q).join("").length < 2) return null;
  const nq = flat(q);
  for (const hay of page) {
    for (let i = hay.indexOf(nq); i >= 0; i = hay.indexOf(nq, i + 1)) {
      if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + nq.length])) return q;
    }
  }
  return null;
}

/** A name as one line: a word broken at a line end joined ("Indo-\nchina"), a letter-spaced word closed up
 *  ("R e i m a n n", German emphasis), runs of white space single. */
export const tidy = (s: string) =>
  s
    .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, "$1$2")
    .replace(/(?<![\p{L}\p{N}])\p{L}(?: \p{L}){2,}(?![\p{L}\p{N}])/gu, (m) => m.replace(/ /g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE, "");

const SMALL_WORDS = new Set(["and", "of", "the", "for", "to", "in", "on", "at", "de", "des", "du", "la", "le", "et", "von", "van", "der", "den", "die", "und", "da", "di", "y"]);

/** An all-capitals letterhead name in ordinary capitals ("OFFICE OF THE SURGEON GENERAL" → "Office of the Surgeon
 *  General"); initials and short all-capital names (likely abbreviations) stay as written. */
export function normalCase(name: string): string {
  if (/\p{Ll}/u.test(name) || !(name.match(/\p{L}+/gu) ?? []).some((w) => w.length >= 4)) return name;
  let first = true;
  return name.replace(/\p{L}+/gu, (w) => {
    const lower = w.toLowerCase();
    const out = w.length === 1 ? w : !first && SMALL_WORDS.has(lower) ? lower : w[0] + lower.slice(1);
    first = false;
    return out;
  });
}

/** The name when every word of it is in the quote (ordinary capitals for an all-caps letterhead are fine); else the
 *  quote itself, so the record never says more than the page. */
function nameFrom(name: string, quote: string): string {
  const q = tidy(quote);
  const n = tidy(name);
  if (!n) return normalCase(q);
  const have = new Set(tokens(q));
  return normalCase(tokens(n).every((t) => have.has(t)) ? n : q);
}

function field(raw: RawNamed | undefined, page: string[], miss: () => void): RecordField | null {
  if (!raw || (!raw.quote.trim() && !raw.name.trim())) return null;
  const quote = onPage(raw.quote, page);
  if (!quote) {
    miss();
    return null;
  }
  return { name: nameFrom(raw.name, quote), quote };
}

/** ISO 8601 (YYYY, YYYY-MM or YYYY-MM-DD) when it is a real date whose year, and day if given, are numbers in the
 *  quote (and its month too when the date is written all in numbers); null otherwise. */
export function isoFrom(iso: string, quote: string): string | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null];
  if (mo !== null && (mo < 1 || mo > 12)) return null;
  if (d !== null && (d < 1 || d > new Date(Date.UTC(y, mo!, 0)).getUTCDate())) return null;
  const nums = (quote.match(/\d+/g) ?? []).map(Number);
  const years = (quote.match(/\d{4}/g) ?? []).map(Number);
  if (years.length ? !years.includes(y) : !nums.includes(y % 100)) return null;
  if (d !== null && !nums.includes(d)) return null;
  if (mo !== null && nums.length >= 3 && !nums.includes(mo)) return null;
  return m[0];
}

/** Check a raw record against the page's transcript: the record with only what the page bears out, and how many of
 *  the fields Muse filled in were left out for not quoting it. */
export function verifyRecord(raw: RawRecord, transcript: string): { record: PageRecord; dropped: number } {
  const page = pageText(transcript);
  let dropped = 0;
  const miss = () => void dropped++;

  let date: PageRecord["date"] = null;
  if (raw.date.quote.trim() || raw.date.iso.trim()) {
    const quote = onPage(raw.date.quote, page);
    if (quote) date = { quote, iso: isoFrom(raw.date.iso, quote) };
    else miss();
  }
  const place = field(raw.place, page, miss);
  const from = field(raw.from, page, miss);
  const to = field(raw.to, page, miss);

  const list = (xs: RawNamed[], skip: (RecordField | null)[]) => {
    const seen = new Set(skip.filter((f): f is RecordField => !!f).map((f) => flat(f.name)));
    const out: RecordField[] = [];
    for (const x of xs) {
      const f = field(x, page, miss);
      if (!f || seen.has(flat(f.name))) continue;
      seen.add(flat(f.name));
      if (out.length < MAX_NAMES) out.push(f);
    }
    return out;
  };
  const people = list(raw.people, [from, to]);
  const places = list(raw.places, [place]);
  const organisations = list(raw.organisations, [from, to]);

  let summary = raw.summary.replace(/\s+/g, " ").trim();
  if (summary.length > MAX_SUMMARY) {
    const cut = summary.lastIndexOf(" ", MAX_SUMMARY - 1);
    summary = summary.slice(0, cut > 0 ? cut : MAX_SUMMARY - 1).replace(/[\s,;:.]+$/, "") + "…";
  }
  const kind: RecordKind = (RECORD_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as RecordKind) : "other";
  return { record: { kind, date, place, from, to, people, places, organisations, summary }, dropped };
}
