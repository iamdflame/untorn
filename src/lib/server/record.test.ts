import { describe, expect, it } from "vitest";
import type { CatalogOut, RunEvent, RunResult } from "@/lib/run/types";
import { catalogRun } from "./catalog";
import type { catalogPage, CallMeta } from "./muse";
import { isoFrom, normalCase, onPage, pageText, tidy, verifyRecord, type RawRecord } from "./record";

const LETTER = `PIERRE CHOUTEAU
ST. LOUIS.

Sept.5, 1903.

Miss Mary Louise Dalton,
Missouri Historical Soey.,
St.Louis.

My dear Miss Dalton:--
' The remainder of Laclede's life was spent in a strug-
gle for existence. He died at the mouth of the Arkansas river while en route from New Orleans
to St.Louis.
Herrn
Gustav R e i m a n n,
[…]ESSED TO "THE SURGEON GENERAL"
Very truly yours,
Pierre Chouteau`;

const raw = (over: Partial<RawRecord> = {}): RawRecord => ({
  kind: "letter",
  date: { quote: "Sept.5, 1903", iso: "1903-09-05" },
  place: { name: "St. Louis", quote: "ST. LOUIS." },
  from: { name: "Pierre Chouteau", quote: "Pierre Chouteau" },
  to: { name: "Mary Louise Dalton", quote: "Miss Mary Louise Dalton" },
  people: [{ name: "Laclede", quote: "Laclede" }],
  places: [{ name: "New Orleans", quote: "New Orleans" }],
  organisations: [{ name: "Missouri Historical Society", quote: "Missouri Historical Soey." }],
  summary: "Pierre Chouteau answers Miss Dalton's inquiries about Laclede.",
  ...over,
});

describe("onPage", () => {
  const page = pageText(LETTER);
  it("finds a quote as whole words, whatever its case, spacing or quote marks", () => {
    expect(onPage("st. louis.", page)).toBe("st. louis");
    expect(onPage("Miss  Mary Louise\nDalton,", page)).toBe("Miss  Mary Louise\nDalton");
    expect(onPage("“THE SURGEON GENERAL”", page)).toBe("THE SURGEON GENERAL");
  });
  it("finds a word broken at a line end", () => {
    expect(onPage("struggle for existence", page)).toBe("struggle for existence");
  });
  it("rejects words that aren't there, parts of words, and anything cut by a gap", () => {
    expect(onPage("Mary Dalton", page)).toBeNull();
    expect(onPage("Orlea", page)).toBeNull();
    expect(onPage("ESSED TO", page)).not.toBeNull();
    expect(onPage("[…]ESSED TO", page)).toBeNull();
    expect(onPage("A", page)).toBeNull();
    expect(onPage("", page)).toBeNull();
  });
});

describe("isoFrom", () => {
  it("keeps an ISO date whose year and day are written in the quote", () => {
    expect(isoFrom("1903-09-05", "Sept.5, 1903")).toBe("1903-09-05");
    expect(isoFrom("1922-05-11", "Berlin, den 11. Mai 1922")).toBe("1922-05-11");
    expect(isoFrom("1922-05", "Mai 1922")).toBe("1922-05");
    expect(isoFrom("1903-09-05", "5.9.03")).toBe("1903-09-05");
  });
  it("drops one the numbers don't bear out, or that isn't a date", () => {
    expect(isoFrom("1904-09-05", "Sept.5, 1903")).toBeNull();
    expect(isoFrom("1903-09-06", "Sept.5, 1903")).toBeNull();
    expect(isoFrom("1903-10-05", "5.9.1903")).toBeNull();
    expect(isoFrom("1903-02-30", "Feb. 30, 1903")).toBeNull();
    expect(isoFrom("1903-09-05", "the fifth of September")).toBeNull();
    expect(isoFrom("Sept 1903", "Sept.5, 1903")).toBeNull();
  });
});

describe("tidy", () => {
  it("closes up a letter-spaced name and a word broken at a line end", () => {
    expect(tidy("Gustav R e i m a n n,")).toBe("Gustav Reimann");
    expect(tidy("Indo-\nchina")).toBe("Indochina");
    expect(tidy("C. W. AYARS")).toBe("C. W. AYARS");
  });
});

describe("normalCase", () => {
  it("puts an all-capitals letterhead name in ordinary capitals, leaving initials and abbreviations", () => {
    expect(normalCase("OFFICE OF THE SURGEON GENERAL")).toBe("Office of the Surgeon General");
    expect(normalCase("DR. GUSTAV STRESEMANN")).toBe("Dr. Gustav Stresemann");
    expect(normalCase("C. W. AYARS")).toBe("C. W. Ayars");
    expect(normalCase("U. S. A.")).toBe("U. S. A.");
    expect(normalCase("MCG")).toBe("MCG");
    expect(normalCase("Mary Louise Dalton")).toBe("Mary Louise Dalton");
  });
});

describe("verifyRecord", () => {
  it("keeps every field that quotes the page, with its normal name", () => {
    const { record, dropped } = verifyRecord(raw(), LETTER);
    expect(dropped).toBe(0);
    expect(record.date).toEqual({ quote: "Sept.5, 1903", iso: "1903-09-05" });
    expect(record.place).toEqual({ name: "St. Louis", quote: "ST. LOUIS" });
    expect(record.to?.name).toBe("Mary Louise Dalton");
    expect(record.people.map((p) => p.name)).toEqual(["Laclede"]);
  });
  it("leaves out and counts what the page doesn't say", () => {
    const { record, dropped } = verifyRecord(
      raw({ to: { name: "Mary Dalton", quote: "Mary Dalton" }, people: [{ name: "Auguste Chouteau", quote: "Auguste Chouteau" }, { name: "Laclede", quote: "Laclede" }] }),
      LETTER,
    );
    expect(record.to).toBeNull();
    expect(record.people.map((p) => p.name)).toEqual(["Laclede"]);
    expect(dropped).toBe(2);
  });
  it("shows the page's own words when the name adds to them", () => {
    const { record } = verifyRecord(raw({ organisations: [{ name: "Missouri Historical Society", quote: "Missouri Historical Soey." }] }), LETTER);
    expect(record.organisations[0].name).toBe("Missouri Historical Soey");
    const spaced = verifyRecord(raw({ to: { name: "Gustav Reimann", quote: "Gustav R e i m a n n" } }), LETTER).record;
    expect(spaced.to?.name).toBe("Gustav Reimann");
  });
  it("empty fields stay empty, a duplicate of the sender is not listed again, an unknown kind is other", () => {
    const { record, dropped } = verifyRecord(
      raw({ kind: "dossier", date: { quote: "", iso: "" }, to: { name: "", quote: "" }, people: [{ name: "Pierre Chouteau", quote: "PIERRE CHOUTEAU" }] }),
      LETTER,
    );
    expect(dropped).toBe(0);
    expect(record.date).toBeNull();
    expect(record.to).toBeNull();
    expect(record.people).toEqual([]);
    expect(record.kind).toBe("other");
  });
  it("a date whose ISO form the quote contradicts keeps the words, not the ISO", () => {
    const { record } = verifyRecord(raw({ date: { quote: "Sept.5, 1903", iso: "1930-09-05" } }), LETTER);
    expect(record.date).toEqual({ quote: "Sept.5, 1903", iso: null });
  });
});

const meta = (costUsd: number): CallMeta => ({
  fn: "catalogPage",
  model: "muse-wonder-1.0",
  effort: "minimal",
  promptVersion: "test",
  attempts: 1,
  ms: 6400,
  lastAttemptMs: 6400,
  usage: { inputTokens: 900, cachedTokens: 0, outputTokens: 300, reasoningTokens: 0 },
  costUsd,
  responseId: null,
  lanes: 1,
});

const run = (texts: string[]): RunResult =>
  ({
    version: 1,
    runId: "r1",
    createdAt: "2026-11-03T00:00:00.000Z",
    source: "upload",
    photo: { url: null, width: 1, height: 1 },
    pieces: [],
    candidates: [],
    asks: [],
    reads: [],
    joins: [],
    pages: [],
    unplaced: [],
    transcripts: texts.map((text, i) => ({ page: `page-${i}`, ok: true, text, language: "en", uncertain: [], translation: null })),
    warnings: [],
    timings: { total: 1000 },
    cost: { usd: 0.1, samCalls: 2, museCalls: 10 },
    timeline: [],
  }) as RunResult;

describe("catalogRun", () => {
  it("streams pending then done records, checks their quotes, stores the result and counts the spend", async () => {
    const events: RunEvent[] = [];
    const stored: string[] = [];
    const meter = { usd: 0 };
    const fake = (async () => ({ ok: true, value: raw({ to: { name: "Nobody", quote: "Nobody Here" } }), meta: meta(0.015) })) as unknown as typeof catalogPage;
    const out = await catalogRun(run([LETTER, "  […]  "]), { catalogPage: fake, putAsset: async (_n, b) => (stored.push(new TextDecoder().decode(b)), "u") }, { meter, emit: (e) => events.push(e), t: () => 5 });
    expect(events.map((e) => (e.type === "catalog" ? e.catalog.status : e.type))).toEqual(["pending", "done"]);
    const c = out.catalogs![0];
    expect(c).toMatchObject({ page: "page-0", status: "done", model: "muse-wonder-1.0", dropped: 1 });
    expect(c.record?.to).toBeNull();
    expect(c.record?.from?.name).toBe("Pierre Chouteau");
    expect(out.cost.usd).toBe(0.115);
    expect(out.cost.museCalls).toBe(11);
    expect(meter.usd).toBeCloseTo(0.015);
    expect((JSON.parse(stored[0]) as RunResult).catalogs?.[0].status).toBe("done");
  });
  it("a failed call is a failed record, never a thrown error; a run with no text asks nothing", async () => {
    const fail = (async () => ({ ok: false, error: { code: "timeout", message: "slow", status: null, retryable: true }, meta: meta(0) })) as unknown as typeof catalogPage;
    const events: RunEvent[] = [];
    const out = await catalogRun(run([LETTER]), { catalogPage: fail, putAsset: async () => null }, { emit: (e) => events.push(e), t: () => 0 });
    expect((events.at(-1) as { catalog: CatalogOut }).catalog).toMatchObject({ status: "failed", error: "timeout", record: null });
    expect(out.catalogs?.[0].status).toBe("failed");
    const none = await catalogRun(run(["[…]"]), { catalogPage: fail, putAsset: async () => null }, { emit: (e) => events.push(e), t: () => 0 });
    expect(none.catalogs).toBeUndefined();
  });
});
