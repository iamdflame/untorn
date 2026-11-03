// A torn synthetic page photographed on a desk, with mocked models, for pipeline and route tests (no network).
// SAM is mocked by the pieces' true masks; Muse answers every seam "same place" and reads a fixed page.

import { UpstreamError } from "@/lib/sam/parse";
import sharp from "sharp";
import { gridTear, scatterPage } from "@/lib/rejoin/__tests__/synth";
import type { CallMeta, MuseOutcome } from "../muse";
import { traceOutline, type PlacedMask } from "../mask-geometry";
import type { PipelineDeps } from "../pipeline";
import type { Fragment } from "../segment";

const meta = (fn: string): CallMeta => ({
  fn,
  model: "muse-spark-1.3",
  effort: "low",
  promptVersion: "test",
  attempts: 1,
  ms: 5,
  lastAttemptMs: 5,
  usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, reasoningTokens: 0 },
  costUsd: 0.005,
  responseId: null,
  lanes: 1,
});

export const ok = <T>(fn: string, value: T): MuseOutcome<T> => ({ ok: true, value, meta: meta(fn) });

export type FakeScene = { photo: Uint8Array; fragments: Fragment[]; width: number; height: number };

let cached: Promise<FakeScene> | null = null;

/** Six pieces of a 520×420 page scattered on a brown desk, as a PNG (lossless, so masks match pixels). */
export function fakeScene(): Promise<FakeScene> {
  cached ??= (async () => {
    const page = gridTear(520, 420, 3, 2, 21);
    const { inputs } = scatterPage(page, 5, { noise: 0.6 });
    let W = 0;
    let H = 0;
    for (const f of inputs) {
      W = Math.max(W, f.x0 + f.mask.width + 60);
      H = Math.max(H, f.y0 + f.mask.height + 60);
    }
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) rgb.set([120, 90, 60], 3 * i);
    for (const f of inputs) {
      for (let r = 0; r < f.mask.height; r++) {
        for (let c = 0; c < f.mask.width; c++) {
          if (!f.mask.data[r * f.mask.width + c]) continue;
          const k = 4 * (r * f.mask.width + c);
          const o = 3 * ((f.y0 + r) * W + f.x0 + c);
          rgb[o] = f.rgba!.data[k];
          rgb[o + 1] = f.rgba!.data[k + 1];
          rgb[o + 2] = f.rgba!.data[k + 2];
        }
      }
    }
    const photo = new Uint8Array(await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
    const fragments: Fragment[] = inputs.map((f, i) => {
      const mask: PlacedMask = { x: f.x0, y: f.y0, width: f.mask.width, height: f.mask.height, data: f.mask.data };
      let area = 0;
      for (const v of f.mask.data) area += v;
      return {
        id: i,
        box: [f.x0, f.y0, f.x0 + f.mask.width - 1, f.y0 + f.mask.height - 1],
        polygon: traceOutline(mask),
        mask,
        area,
        confidence: 0.97,
        refined: true,
        method: "snap",
      };
    });
    return { photo, fragments, width: W, height: H };
  })();
  return cached;
}

export type FakeOptions = {
  /** Make SAM fail, find nothing, or refuse the key (no credit left). */
  segment?: "ok" | "fail" | "empty" | "refused";
  /** Make every Muse seam call fail. */
  museFails?: boolean;
  /** Delay per Muse seam call (ms). */
  readDelayMs?: number;
  /** Write archive records after done: a record quoting the fake page (one name it doesn't, to be dropped). */
  catalog?: boolean;
};

export function fakeDeps(putAsset: PipelineDeps["putAsset"], o: FakeOptions = {}): PipelineDeps & { calls: Record<string, number> } {
  const calls: Record<string, number> = { segment: 0, verifySeam: 0, chooseContinuation: 0, readPage: 0, translate: 0 };
  const fail = (fn: string) => ({ ok: false as const, error: { code: "http" as const, message: "upstream 500", status: 500, retryable: true }, meta: meta(fn) });
  const delay = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      // an already-aborted signal never fires "abort" again
      if (!ms || signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  return {
    calls,
    putAsset,
    segment: async () => {
      calls.segment++;
      if (o.segment === "fail") throw new Error("SAM 503");
      if (o.segment === "refused") throw new UpstreamError("Your credit balance is too low", 402, "insufficient_credits");
      const scene = await fakeScene();
      return { fragments: o.segment === "empty" ? [] : scene.fragments, costUsd: 0.0025, samCalls: 1 };
    },
    verifySeam: async (_img, opts) => {
      calls.verifySeam++;
      await delay(o.readDelayMs ?? 0, opts?.signal);
      if (opts?.signal?.aborted) return { ok: false, error: { code: "aborted", message: "aborted", status: null, retryable: false }, meta: meta("verifySeam") };
      if (o.museFails) return fail("verifySeam");
      return ok("verifySeam", { same_place: true, confidence: 0.9, words_across: ["bo|rn → born"], reason: "the words continue" });
    },
    chooseContinuation: async (_img, _k, opts) => {
      calls.chooseContinuation++;
      await delay(o.readDelayMs ?? 0, opts?.signal);
      if (o.museFails) return fail("chooseContinuation");
      return ok("chooseContinuation", { choice: "A", index: 0, confidence: 0.9, words_across: ["fou|nded"], reason: "A continues the line" });
    },
    readPage: async () => {
      calls.readPage++;
      return ok("readPage", { text: "Sehr geehrte Frau Dalton, […] ich danke Ihnen.", language: "de", uncertain: [] });
    },
    translate: async (text, to) => {
      calls.translate++;
      return ok("translate", { text: `Dear Mrs Dalton, […] thank you. (${text.length})`, source_language: "de", to });
    },
    ...(o.catalog
      ? {
          catalogPage: async () => {
            calls.catalogPage = (calls.catalogPage ?? 0) + 1;
            const none = { name: "", quote: "" };
            return ok("catalogPage", {
              kind: "letter",
              date: { quote: "", iso: "" },
              place: none,
              from: none,
              to: { name: "Frau Dalton", quote: "Frau Dalton" },
              people: [{ name: "Herr Reimann", quote: "Herr Reimann" }],
              places: [],
              organisations: [],
              summary: "A short letter of thanks to Mrs Dalton.",
            });
          },
        }
      : {}),
  } as PipelineDeps & { calls: Record<string, number> };
}
