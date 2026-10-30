import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildScene, chooseClimax, splitWords, statedSplit } from "./scene";
import type { RunResult } from "./types";

const recorded = JSON.parse(readFileSync(path.join(__dirname, "../../../public/samples/chouteau-1903/result.json"), "utf8")) as RunResult;

describe("reads", () => {
  it("keeps single words and drops phrases and punctuation", () => {
    expect(splitWords(["referred:", "remainder of", "respected", "1755", "n, / blank"])).toEqual(["referred", "respected", "1755"]);
  });
  it("finds Muse's own split in its reason", () => {
    expect(statedSplit("respected", "cut 'r' + 'espected' completes to respected")).toEqual(["r", "espected"]);
    expect(statedSplit("born", "o+rn makes born and di+ed makes died")).toEqual(["bo", "rn"]);
    expect(statedSplit("died", "o+rn makes born and di+ed makes died")).toEqual(["di", "ed"]);
    expect(statedSplit("recover", "Tear completes recover, sad, and banks")).toBeNull();
  });
});

describe("the recorded sample's scene", () => {
  const scene = buildScene(recorded);

  it("places every piece on one page and finds a shared edge for the joins", () => {
    expect(scene.pieces).toHaveLength(10);
    expect(scene.pieces.every((p) => p.placed && p.page === 0)).toBe(true);
    expect(scene.seams.length).toBe(recorded.joins.length);
    const withEdge = scene.seams.filter((s) => s.line.length >= 4);
    expect(withEdge.length).toBeGreaterThanOrEqual(14);
    // true joins mirror: the summed edge traces are much flatter than either edge
    const flat = withEdge.filter((s) => s.profA && s.profB).map((s) => {
      const amp = (a: number[]) => Math.max(...a) - Math.min(...a);
      return amp(s.profA!.map((v, i) => v + s.profB![i])) / Math.max(1, amp(s.profA!));
    });
    expect(flat.filter((f) => f < 0.6).length).toBeGreaterThan(flat.length / 2);
  });

  it("shows only reads that confirmed their join", () => {
    expect(scene.reads).toBe(3);
    expect(scene.seams.filter((s) => s.read).map((s) => s.join.candidate).sort()).toEqual(["p1~p2#0", "p2~p9#0", "p8~p9#0"]);
  });

  it("lands the climax on the most confident split word read at confidence ≥ 0.9, and seats that piece last", () => {
    // "recover" (0.95) wins over the longer "respected" (0.90), whose stated split the paper doesn't show.
    expect(scene.climax?.word).toBe("recover");
    if (scene.climax?.split) expect(scene.climax.split.join("")).toBe("recover");
    expect(scene.seams[scene.climax!.seam].join.candidate).toBe("p8~p9#0");
    const last = scene.order.at(-1)!;
    expect(last.read).toBe(scene.climax!.seam);
    expect(scene.order).toHaveLength(10);
    expect(new Set(scene.order.map((o) => o.piece)).size).toBe(10);
  });

  it("chooses no climax when nothing was read with confidence", () => {
    expect(chooseClimax(scene.seams, 0.99)).toBeNull();
  });
});

describe("pieces the solver set aside", () => {
  // the recorded run with three pieces taken off its page, as a partial solve leaves them
  const out = new Set(["p0", "p4", "p7"]);
  const partial: RunResult = {
    ...recorded,
    pages: recorded.pages.map((pg) => ({ ...pg, pieces: pg.pieces.filter((f) => !out.has(f.id)) })),
    joins: recorded.joins.filter((j) => !out.has(j.a) && !out.has(j.b)),
  };
  const scene = buildScene(partial);
  const aside = scene.pieces.filter((p) => !p.placed);

  it("go to a tray beside the pages, never onto them or each other", () => {
    expect(aside.map((p) => p.id).sort()).toEqual([...out].sort());
    const [x0, y0, x1, y1] = scene.pagesBox;
    for (const p of aside) {
      const clear = p.home[0] - p.r >= x1 || p.home[1] - p.r >= y1 || p.home[0] + p.r <= x0 || p.home[1] + p.r <= y0;
      expect(clear).toBe(true);
      expect(p.ang).toBe(0);
    }
    for (let i = 0; i < aside.length; i++)
      for (let j = i + 1; j < aside.length; j++) expect(Math.hypot(aside[i].home[0] - aside[j].home[0], aside[i].home[1] - aside[j].home[1])).toBeGreaterThanOrEqual(aside[i].r + aside[j].r);
  });

  it("are framed with the pages", () => {
    const [bx0, by0, bx1, by1] = scene.box;
    for (const p of aside) {
      expect(p.home[0] - p.r).toBeGreaterThanOrEqual(bx0 - 1e-6);
      expect(p.home[1] - p.r).toBeGreaterThanOrEqual(by0 - 1e-6);
      expect(p.home[0] + p.r).toBeLessThanOrEqual(bx1 + 1e-6);
      expect(p.home[1] + p.r).toBeLessThanOrEqual(by1 + 1e-6);
    }
    expect(buildScene(recorded).box).toEqual(buildScene(recorded).pagesBox);
  });
});
