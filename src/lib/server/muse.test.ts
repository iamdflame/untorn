import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  chooseContinuation,
  costUsd,
  extractOutputText,
  normaliseGroups,
  pageOrientation,
  readPage,
  sortFragments,
  translate,
  verifySeam,
  type AttemptLog,
  type MuseOptions,
} from "./muse";
import { GAP } from "./prompts";

// Real responses (reasoning payload trimmed): verifySeam on spike cw1 item 00 (a true join); the live smoke run's
// chooseContinuation (cw3 trial 00, truth B), readPage (the letter with a piece cut away), translate and
// sortFragments (Muse Wonder, 2 typed + 2 handwritten crops).
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}.response.json`, import.meta.url), "utf8");
const recorded = fixture("muse-seam");

const img = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: "image/jpeg" as const };

type Step = Response | Error | "hang";
function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }
    if (step instanceof Error) throw step;
    return step.clone();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const answer = (obj: unknown, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: "resp_test",
      status: "completed",
      output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }],
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 900 } },
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const httpError = (status: number, message = "nope", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message, code: null } }), { status, headers });

function opts(extra: Partial<MuseOptions> = {}) {
  const logs: AttemptLog[] = [];
  const sleeps: number[] = [];
  const o: MuseOptions = {
    apiKey: "test-key",
    onLog: (e) => logs.push(e),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  };
  return { o, logs, sleeps };
}

const seam = { text_crosses: true, same_place: false, confidence: 0.8, words_across: ["tose"], reason: "'to'+'se' is not a word" };

describe("verifySeam", () => {
  it("parses a recorded muse-spark-1.3 response and logs tokens and cost", async () => {
    const f = fakeFetch([new Response(recorded, { status: 200 })]);
    const { o, logs } = opts({ fetchImpl: f.impl });
    // the recording answers the v2 wording (no text_crosses)
    const r = await verifySeam(img, { ...o, prompt: "v2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.same_place).toBe(true);
    expect(r.value.words_across.length).toBeGreaterThan(0);
    expect(r.meta).toMatchObject({ fn: "verifySeam", model: "muse-spark-1.3", effort: "low", attempts: 1 });
    expect(r.meta.usage).toEqual({ inputTokens: 199, cachedTokens: 0, outputTokens: 1842, reasoningTokens: 1757 });
    expect(r.meta.costUsd).toBeCloseTo((199 * 1.25 + 1842 * 4.25) / 1e6, 8);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ outcome: "ok", status: 200 });
  });

  it("v3 passes text_crosses through, and retries an answer without it", async () => {
    const f = fakeFetch([answer({ same_place: true, confidence: 0.5, words_across: [], reason: "blank" }), answer({ ...seam, text_crosses: false })]);
    const { o, logs } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text_crosses).toBe(false);
    expect(logs.map((l) => l.error ?? "ok")).toEqual(["unparseable", "ok"]);
  });

  it("sends a strict structured request with a generic User-Agent and no stored response", async () => {
    const f = fakeFetch([answer(seam)]);
    const { o } = opts({ fetchImpl: f.impl });
    await verifySeam(img, o);
    const { url, init, body } = f.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("rejoin/0.1");
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization", "Content-Type", "User-Agent"]);
    expect(body).toMatchObject({ model: "muse-spark-1.3", reasoning: { effort: "low" }, store: false, max_output_tokens: 4000 });
    const fmt = (body.text as { format: Record<string, unknown> }).format;
    expect(fmt).toMatchObject({ type: "json_schema", name: "seam_verdict", strict: true });
    const content = (body.input as { content: { type: string; image_url?: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_image"]);
    expect(content[1].image_url).toBe("data:image/jpeg;base64,/9j/2Q==");
  });

  it("adds the 180° copy when both orientations are given", async () => {
    const f = fakeFetch([answer(seam)]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, { ...o, rotated: { url: "data:image/jpeg;base64,AAAA" } });
    const content = (f.calls[0].body.input as { content: { type: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_image", "input_text", "input_image"]);
    expect(r.meta.promptVersion).toMatch(/\+rot$/);
  });
});

describe("recorded answers from the live smoke run", () => {
  const replay = (name: string) => fakeFetch([new Response(fixture(name), { status: 200 })]);

  it("chooseContinuation picks B on the stack-tear trial", async () => {
    const r = await chooseContinuation(img, 3, opts({ fetchImpl: replay("muse-choice").impl }).o);
    expect(r.ok && r.value).toMatchObject({ choice: "B", index: 1 });
  });

  it("readPage marks the cut-away text as gaps, normalised to one marker, and invents nothing there", async () => {
    const r = await readPage(img, opts({ fetchImpl: replay("muse-read").impl }).o);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.language).toBe("en");
    expect(r.value.text).not.toContain("[...]");
    expect(r.value.text).toContain(`Lacle${GAP}`);
    expect(r.value.text.split(GAP).length - 1).toBeGreaterThanOrEqual(8);
    // the words under the hole ("Laclede's life was spent in a strug-") must not appear
    expect(r.value.text).not.toMatch(/life was spent/);
    expect(r.value.uncertain).toContain(`Lacle${GAP}`);
  });

  it("translate and sortFragments parse their recorded answers", async () => {
    const t = await translate("Dear Miss Dalton", "de", opts({ fetchImpl: replay("muse-translate").impl }).o);
    expect(t.ok && t.value).toMatchObject({ source_language: "en", to: "de" });
    const s = await sortFragments([img, img, img, img], opts({ fetchImpl: replay("muse-sort").impl }).o);
    expect(s.ok && s.value.groups.map((g) => g.fragments)).toEqual([[0, 3], [1], [2]]);
    expect(s.meta.model).toBe("muse-wonder-1.0");
  });
});

describe("retry policy", () => {
  it("retries a 503 after its Retry-After, then answers", async () => {
    const f = fakeFetch([httpError(503, "overloaded", { "retry-after": "2" }), answer(seam)]);
    const { o, sleeps, logs } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(true);
    expect(r.meta.attempts).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(logs.map((l) => l.outcome)).toEqual(["retry", "ok"]);
  });

  it("retries network errors and 429 with jittered exponential backoff", async () => {
    const netErr = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const f = fakeFetch([netErr, httpError(429, "slow down"), answer(seam)]);
    const { o, sleeps, logs } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(true);
    expect(r.meta.attempts).toBe(3);
    expect(logs[0]).toMatchObject({ error: "network", outcome: "retry" });
    expect(logs[0].message).toContain("ECONNRESET");
    expect(logs[1]).toMatchObject({ error: "rate_limited", status: 429 });
    // base 600 ms doubling, jitter in [exp/2, exp]; random() = 0.5 → 0.75 × exp
    expect(sleeps).toEqual([450, 900]);
  });

  it("retries empty output at once, reasoning one level lower with a larger budget when reasoning used it up", async () => {
    const empty = new Response(
      JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning" }],
        usage: { input_tokens: 200, output_tokens: 4000, output_tokens_details: { reasoning_tokens: 4000 } },
      }),
      { status: 200 },
    );
    const f = fakeFetch([empty, answer(seam)]);
    const { o, logs, sleeps } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => c.body.max_output_tokens)).toEqual([4000, 6000]);
    expect(f.calls.map((c) => (c.body.reasoning as { effort: string }).effort)).toEqual(["low", "minimal"]);
    expect(logs[0]).toMatchObject({ error: "incomplete", outcome: "retry" });
    expect(sleeps[0]).toBeLessThan(300);
    // the failed attempt's tokens are billed too
    expect(r.meta.usage.outputTokens).toBe(5000);
  });

  it("retries a completed but empty answer, and an answer that breaks the schema", async () => {
    const f = fakeFetch([answer(""), answer({ same_place: "yes" }), answer("not json at all"), answer(seam)]);
    const { o, logs } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(true);
    expect(logs.map((l) => l.error ?? "ok")).toEqual(["empty", "unparseable", "unparseable", "ok"]);
  });

  it("gives up after maxAttempts with a typed failure instead of throwing", async () => {
    const f = fakeFetch([answer("")]);
    const { o } = opts({ fetchImpl: f.impl, maxAttempts: 3 });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "empty", retryable: true });
    expect(r.meta.attempts).toBe(3);
  });

  it.each([
    [400, "bad_request"],
    [401, "auth"],
    [402, "billing"],
    [404, "bad_request"],
  ])("does not retry HTTP %i", async (status, code) => {
    const f = fakeFetch([httpError(status), answer(seam)]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code, status, retryable: false });
    expect(f.calls).toHaveLength(1);
  });

  it("times out a hung attempt and stops at the overall deadline", async () => {
    const f = fakeFetch(["hang"]);
    const { o } = opts({ fetchImpl: f.impl, timeoutMs: 30, deadlineMs: 80, sleep: undefined });
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("timeout");
    expect(r.meta.ms).toBeLessThan(1000);
  });

  it("stops at once when the caller aborts", async () => {
    const f = fakeFetch(["hang"]);
    const ac = new AbortController();
    const { o } = opts({ fetchImpl: f.impl, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const r = await verifySeam(img, o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
    expect(f.calls).toHaveLength(1);
  });

  it("fails cleanly without a key, before any request", async () => {
    const f = fakeFetch([answer(seam)]);
    const prev = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;
    const r = await verifySeam(img, { fetchImpl: f.impl, onLog: () => {} });
    if (prev !== undefined) process.env.MODEL_API_KEY = prev;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("config");
    expect(f.calls).toHaveLength(0);
  });
});

describe("chooseContinuation", () => {
  it("constrains the choice to the k letters and maps it to an index", async () => {
    const f = fakeFetch([answer({ choice: "c", confidence: 1.4, words_across: ["born"], reason: "bo+rn" })]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await chooseContinuation(img, 4, o);
    const schema = (f.calls[0].body.text as { format: { schema: { properties: { choice: { enum: string[] } } } } }).format.schema;
    expect(schema.properties.choice.enum).toEqual(["A", "B", "C", "D"]);
    expect(f.calls[0].body).toMatchObject({ reasoning: { effort: "low" }, max_output_tokens: 6000 });
    expect(r.ok && r.value).toMatchObject({ choice: "C", index: 2, confidence: 1 });
  });

  it("retries a letter outside the candidates", async () => {
    const f = fakeFetch([answer({ choice: "E", confidence: 0.9, words_across: [], reason: "" }), answer({ choice: "A", confidence: 0.9, words_across: [], reason: "" })]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await chooseContinuation(img, 3, o);
    expect(r.ok && r.value.index).toBe(0);
    expect(f.calls).toHaveLength(2);
  });
});

describe("pageOrientation", () => {
  it("says whether a rebuilt page stands upright, at minimal effort", async () => {
    const f = fakeFetch([answer({ upright: false, confidence: 0.92, reason: "'Merkle' reads only turned over" })]);
    const r = await pageOrientation(img, opts({ fetchImpl: f.impl }).o);
    expect(r.ok && r.value).toEqual({ upright: false, confidence: 0.92, reason: "'Merkle' reads only turned over" });
    expect((f.calls[0].body.reasoning as { effort: string }).effort).toBe("minimal");
  });

  it("treats an answer without the flag as unparseable", async () => {
    const f = fakeFetch([answer({ confidence: 0.9, reason: "?" }), answer({ confidence: 0.9, reason: "?" }), answer({ confidence: 0.9, reason: "?" })]);
    const r = await pageOrientation(img, opts({ fetchImpl: f.impl, maxAttempts: 2 }).o);
    expect(r.ok).toBe(false);
  });
});

describe("readPage and translate", () => {
  it("reads a page with gap markers", async () => {
    const page = { text: `Miss Mary ${GAP}\nSt. Lou${GAP}`, language: "en", uncertain: ["Socy."] };
    const f = fakeFetch([answer(page)]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await readPage(img, o);
    expect(r.ok && r.value).toEqual(page);
  });

  it("normalises gap markers written as [...]", async () => {
    const f = fakeFetch([answer({ text: "Mary [...]\nSt. Lou[ ... ]", language: "en", uncertain: ["Lou[...]"] })]);
    const r = await readPage(img, opts({ fetchImpl: f.impl }).o);
    expect(r.ok && r.value).toEqual({ text: `Mary ${GAP}\nSt. Lou${GAP}`, language: "en", uncertain: [`Lou${GAP}`] });
  });

  it("retries a translation that drops a gap marker", async () => {
    const f = fakeFetch([answer({ text: "Liebe Miss", source_language: "en" }), answer({ text: `Liebe ${GAP}`, source_language: "en" })]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await translate(`Dear ${GAP}`, "de", o);
    expect(r.ok && r.value).toEqual({ text: `Liebe ${GAP}`, source_language: "en", to: "de" });
    expect(f.calls).toHaveLength(2);
    const content = (f.calls[0].body.input as { content: { type: string }[] }[])[0].content;
    expect(content.every((c) => c.type === "input_text")).toBe(true);
  });
});

describe("sortFragments", () => {
  it("sends labelled crops to Muse Wonder and returns a 0-based partition", async () => {
    const f = fakeFetch([answer({ groups: [{ fragments: [1, 3], reason: "blue typewriter" }, { fragments: [2], reason: "handwriting" }] })]);
    const { o } = opts({ fetchImpl: f.impl });
    const r = await sortFragments([img, img, img], o);
    expect(f.calls[0].body.model).toBe("muse-wonder-1.0");
    const content = (f.calls[0].body.input as { content: { type: string; text?: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_text", "input_image", "input_text", "input_image", "input_text", "input_image"]);
    expect(content[5].text).toBe("Fragment 3:");
    expect(r.ok && r.value.groups.map((g) => g.fragments)).toEqual([[0, 2], [1]]);
  });

  it("repairs missing and repeated fragments, and refuses more than 50 crops without calling", async () => {
    expect(normaliseGroups([{ fragments: [1, 2, 2], reason: "a" }, { fragments: [2, 9], reason: "b" }], 3)).toEqual({
      groups: [{ fragments: [0, 1], reason: "a" }, { fragments: [2], reason: "not placed by the model; kept on its own" }],
      repaired: { missing: [2], duplicated: [1, 1] },
    });
    expect(normaliseGroups([{ fragments: [1], reason: "" }], 6)).toBeNull();
    const f = fakeFetch([answer({ groups: [] })]);
    const r = await sortFragments(Array.from({ length: 51 }, () => img), opts({ fetchImpl: f.impl }).o);
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("prices Spark and Wonder per token, cached input at the cached rate", () => {
    const u = { inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 1_000_000, reasoningTokens: 0 };
    expect(costUsd("muse-spark-1.3", u)).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.15 + 4.25, 6);
    expect(costUsd("muse-wonder-1.0", u)).toBeCloseTo(0.6 * 4 + 0.4 * 0.2 + 20, 6);
  });

  it("joins every output_text part and ignores reasoning items", () => {
    expect(
      extractOutputText({
        output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"a":' }, { type: "output_text", text: "1}" }] }],
      }),
    ).toBe('{"a":1}');
  });
});
