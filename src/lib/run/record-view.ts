// How an archive record reads: its labels, its date in words, a title built only from checked fields, and the record
// as Dublin Core (oai_dc), the element set archives exchange item records in. Pure: the result page and tests use it.

import type { CatalogOut, PageRecord, RecordKind, RunResult, SpokenNote } from "./types";

export const KIND_LABEL: Record<RecordKind, string> = {
  letter: "Letter",
  telegram: "Telegram",
  memo: "Memo",
  report: "Report",
  form: "Form",
  list: "List",
  receipt: "Receipt",
  minutes: "Minutes",
  notes: "Notes",
  article: "Article",
  other: "Document",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "1927-04-08" → "8 April 1927"; "1927-04" → "April 1927"; "1927" → "1927". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!m) return String(y);
  return d ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`;
}

/** The record's date in words: from its ISO form when the quote bore one out, else as written. */
export const recordDate = (r: PageRecord) => (r.date ? (r.date.iso ? longDate(r.date.iso) : r.date.quote) : null);

/** "Letter from Franklin D. Roosevelt to Julian, 8 April 1927": every part a checked field, none guessed. */
export function recordTitle(r: PageRecord): string {
  const date = recordDate(r);
  return `${KIND_LABEL[r.kind]}${r.from ? ` from ${r.from.name}` : ""}${r.to ? ` to ${r.to.name}` : ""}${date ? `, ${date}` : ""}`;
}

/** Whether a name differs from the words it rests on in more than case and punctuation (then both are shown). */
export function differsFromQuote(name: string, quote: string): boolean {
  const k = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return k(name) !== k(quote);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The record as an oai_dc XML document. `link`: where the rebuilt run can be seen (a permalink or sample URL);
 * `note`: the archivist's spoken provenance note, if one was given.
 */
export function dublinCore(result: RunResult, c: CatalogOut, link: string | null, note: SpokenNote | null = null): string {
  const r = c.record!;
  const tr = result.transcripts.find((t) => t.page === c.page);
  const page = result.pages.find((p) => p.id === c.page);
  const el = (name: string, value: string | null | undefined) => (value ? [`  <dc:${name}>${xml(value)}</dc:${name}>`] : []);
  const describe = [
    r.summary ? `${r.summary} (Summary by Muse Wonder.)` : "",
    r.to ? `Addressed to ${r.to.name}.` : "",
    r.place ? `Written at ${r.place.name}.` : "",
    note ? `Where it was found, as the archivist said it (written down by Muse Voice Transcribe): ${note.text}` : "",
    `Rebuilt by Untorn from ${page?.pieces.length ?? "its"} torn pieces in one photo; transcript by Muse Spark; this record by Muse Wonder, every name and date quoted from the page and checked against it.`,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">`,
    ...el("title", recordTitle(r)),
    ...el("creator", r.from?.name),
    ...el("date", r.date ? (r.date.iso ?? r.date.quote) : null),
    ...el("type", "Text"),
    ...el("type", KIND_LABEL[r.kind]),
    ...el("format", "image/png"),
    ...el("language", tr && tr.language !== "und" ? tr.language : null),
    ...[...r.people, ...r.organisations].flatMap((f) => el("subject", f.name)),
    ...[r.place, ...r.places].flatMap((f) => (f ? el("coverage", f.name) : [])),
    ...el("description", describe),
    ...el("identifier", link),
    `</oai_dc:dc>`,
    ``,
  ].join("\n");
}
