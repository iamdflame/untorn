// The live content check for eval runs: the pipeline's own Muse calls (verifySeam / chooseContinuation, JPEG seam
// images, an upside-down copy when "up" is unknown), with a cache keyed by the exact image bytes so a rerun of an
// unchanged seam costs nothing, and a spend ledger. The cache holds model reads of private photos: keep it outside
// the repo.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ContentCheck, ContentRequest, ContentVerdict, Rgba } from "../../../src/lib/rejoin/types";
import { rotate180Jpeg } from "../../../src/lib/server/images";
import { chooseContinuation, verifySeam } from "../../../src/lib/server/muse";

export type ReadLog = {
  id: string;
  kind: "pair" | "choice";
  key: string;
  cached: boolean;
  ok: boolean;
  verdict: ContentVerdict | null;
  ms: number;
  costUsd: number;
};

type CacheEntry = { verdict: ContentVerdict | null; ok: boolean; costUsd: number; ms: number };

export async function encodeJpeg(img: Rgba, quality = 90): Promise<Uint8Array> {
  const buf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(buf);
}

/** A cached live Muse check. `spent()` is the new spend of this process; every read is logged. */
export function cachedMuseCheck(opts: { cacheFile: string; ledgerFile: string; saveImages?: string; maxUsd?: number }): ContentCheck & {
  spent: () => number;
  log: ReadLog[];
} {
  const cache: Record<string, CacheEntry> = existsSync(opts.cacheFile) ? JSON.parse(readFileSync(opts.cacheFile, "utf8")) : {};
  let spent = 0;
  const log: ReadLog[] = [];
  const persist = () => {
    mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
    writeFileSync(opts.cacheFile, JSON.stringify(cache));
  };
  const check = async (req: ContentRequest): Promise<ContentVerdict | null> => {
    const t0 = performance.now();
    const jpeg = await encodeJpeg(req.render());
    const key = `${req.kind}:${req.uprightKnown ? "up" : "rot"}:${createHash("sha1").update(jpeg).digest("hex")}`;
    if (opts.saveImages) {
      mkdirSync(opts.saveImages, { recursive: true });
      writeFileSync(path.join(opts.saveImages, `${req.id.replace(/[^\w~#.-]+/g, "_")}.jpg`), jpeg);
    }
    const hit = cache[key];
    if (hit) {
      const verdict = hit.verdict ? { ...hit.verdict, id: req.id } : null;
      log.push({ id: req.id, kind: req.kind, key, cached: true, ok: hit.ok, verdict, ms: 0, costUsd: 0 });
      return verdict;
    }
    if (opts.maxUsd !== undefined && spent >= opts.maxUsd) return null;
    const image = { data: jpeg, mime: "image/jpeg" as const };
    const rotated = req.uprightKnown ? undefined : { data: await rotate180Jpeg(jpeg), mime: "image/jpeg" as const };
    const callOpts = { rotated, onLog: () => {}, hedgeAfterMs: 12_000 };
    let verdict: ContentVerdict | null = null;
    let ok = false;
    let cost = 0;
    if (req.kind === "pair") {
      const out = await verifySeam(image, callOpts);
      cost = out.meta.costUsd;
      if (out.ok) {
        ok = true;
        const v = out.value;
        verdict = { kind: "pair", id: req.id, same: v.same_place, confidence: v.confidence, reason: v.reason, wordsAcross: v.words_across };
      }
    } else {
      const out = await chooseContinuation(image, req.candidates.length, callOpts);
      cost = out.meta.costUsd;
      if (out.ok) {
        ok = true;
        const v = out.value;
        const choice = Number.isInteger(v.index) && v.index >= 0 && v.index < req.candidates.length ? v.index : null;
        verdict = { kind: "choice", id: req.id, choice, confidence: v.confidence, reason: v.reason, wordsAcross: v.words_across };
      }
    }
    spent += cost;
    const ms = performance.now() - t0;
    if (ok) {
      cache[key] = { verdict, ok, costUsd: cost, ms };
      persist();
    }
    mkdirSync(path.dirname(opts.ledgerFile), { recursive: true });
    appendFileSync(opts.ledgerFile, JSON.stringify({ at: new Date().toISOString(), fn: req.kind === "pair" ? "verifySeam" : "chooseContinuation", costUsd: cost, ms: Math.round(ms), ok }) + "\n");
    log.push({ id: req.id, kind: req.kind, key, cached: false, ok, verdict, ms, costUsd: cost });
    return verdict;
  };
  return Object.assign(check, { spent: () => spent, log });
}

/** Total spend recorded in a ledger file. */
export function ledgerTotal(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).costUsd ?? 0), 0);
}
