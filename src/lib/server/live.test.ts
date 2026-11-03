import { afterEach, describe, expect, it, vi } from "vitest";
import { liveDeps, readHosts } from "./live";

describe("readHosts", () => {
  const key = { BASETEN_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;

  it("reads with Muse Spark alone when the open-weights host isn't set up, or is set aside", () => {
    expect(readHosts("both", {} as unknown as NodeJS.ProcessEnv)).toEqual({});
    expect(readHosts("open", {} as unknown as NodeJS.ProcessEnv)).toEqual({});
    expect(readHosts("both", { ...key, OPEN_WEIGHTS: "off" } as unknown as NodeJS.ProcessEnv)).toEqual({});
  });

  it("asks Muse Spark first and the open weights for its slow reads; READ_FIRST swaps them or keeps Meta's API alone", () => {
    expect(readHosts("both", key)).toEqual({ model: "muse-spark-1.3", altModel: "muse-spark-open" });
    expect(readHosts("both", { ...key, READ_FIRST: "open" } as unknown as NodeJS.ProcessEnv)).toEqual({ model: "muse-spark-open", altModel: "muse-spark-1.3" });
    expect(readHosts("both", { ...key, READ_FIRST: "meta-only" } as unknown as NodeJS.ProcessEnv)).toEqual({});
  });

  it("keeps every read on the open weights when the visitor asks for that", () => {
    expect(readHosts("open", key)).toEqual({ model: "muse-spark-open" });
  });
});

describe("liveDeps with every read on the open weights (the visitor's switch)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const img = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: "image/jpeg" as const };
  const verdict = { text_crosses: true, same_place: true, confidence: 0.9, words_across: ["Dalton"], reason: "'Dal'+'ton' makes Dalton" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const metaAnswer = () =>
    json({
      id: "resp_test",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(verdict) }] }],
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 50 } },
    });
  const openAnswer = () => json({ id: "chatcmpl_test", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 200, completion_tokens: 100 } });
  // Baseten's answer when the account has no credit left
  const unpaid = () => json({ error: "please check your current payment status." }, 402);
  // Meta's API answers; the open weights' host answers as given
  function hosts(open: () => Response | Promise<Response>) {
    const calls = { meta: 0, open: 0 };
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes("baseten")) {
        calls.open++;
        return open();
      }
      calls.meta++;
      return metaAnswer();
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const quiet = { onLog: () => {}, sleep: async () => {} };
  const keys = () => {
    vi.stubEnv("BASETEN_API_KEY", "test-open-key");
    vi.stubEnv("MODEL_API_KEY", "test-meta-key");
  };

  it("a read the host turns away for our account goes to Muse Spark at once, and the refusal is reported", async () => {
    keys();
    const h = hosts(unpaid);
    const refused: string[] = [];
    const deps = liveDeps(async () => null, { reader: "open", openUsable: true, onRefused: (m) => refused.push(m) });
    const r = await deps.verifySeam(img, { ...quiet, fetchImpl: h.fetchImpl, hedgeAfterMs: 9000 });
    expect(r.ok && r.meta.model).toBe("muse-spark-1.3");
    expect(h.calls).toEqual({ meta: 1, open: 1 });
    expect(refused).toEqual(["muse-spark-open"]);
  });

  it("a slow read stays with the open weights: Muse Spark isn't asked", async () => {
    keys();
    const h = hosts(() => new Promise<Response>((resolve) => setTimeout(() => resolve(openAnswer()), 60)));
    const deps = liveDeps(async () => null, { reader: "open", openUsable: true });
    const r = await deps.verifySeam(img, { ...quiet, fetchImpl: h.fetchImpl, hedgeAfterMs: 10 });
    expect(r.ok && r.meta.model).toBe("muse-spark-open");
    expect(h.calls.meta).toBe(0);
  });

  it("after Meta's API refused our key, an open-weights refusal isn't handed back to it", async () => {
    keys();
    const h = hosts(unpaid);
    const deps = liveDeps(async () => null, { reader: "open", metaRefused: true, openUsable: true });
    const r = await deps.verifySeam(img, { ...quiet, fetchImpl: h.fetchImpl });
    expect(!r.ok && r.error.code).toBe("billing");
    expect(h.calls.meta).toBe(0);
  });
});
