"use client";

// The finished run, in the same room: the rebuilt page on the light table (assembled or pulled apart with J, a
// real-pixel close-up under the pointer), what Muse read on it, every seam with both of its clues, the pieces left
// unplaced, and the downloads.

import { useEffect, useMemo, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../hooks";
import { WARNINGS } from "@/lib/run/errors";
import { buildScene, splitWords, statedSplit, type Scene, type SceneSeam } from "@/lib/run/scene";
import type { RunResult } from "@/lib/run/types";
import { languageName } from "@/lib/client/language";
import { pagesPdf } from "@/lib/client/pdf";
import { cutoutKey, makeCutouts, readPoint, sharedCutouts, type Cutout } from "../hero/cutouts";
import { COL, TAU, balloon, drawFrame, drawPiece, drawShadow, easeIO, fit, lerpCam, lightTable, linePath, readFonts, setCam, strokeAt, w2s, type Cam, type Pose } from "../hero/draw";

const esc = (s: string) => s;

function traceD(arr: number[], amp: number) {
  return arr.map((v, i) => `${i ? "L" : "M"}${((140 * i) / (arr.length - 1)).toFixed(1)} ${(8 - (v / amp) * 7).toFixed(1)}`).join("");
}

function SplitWord({ word, split }: { word: string; split: [string, string] | null }) {
  if (!split) return <>{word}</>;
  return (
    <>
      {split[0]}
      <i className="bar" aria-hidden="true" />
      <span className="sr"> </span>
      {split[1]}
    </>
  );
}

function markGaps(text: string) {
  return text.split(/(\[…\])/g).map((part, i) => (part === "[…]" ? <mark key={i} title="Missing or illegible: left as a gap">[…]</mark> : part));
}

/** The rebuilt page on the light table. */
function Plate({ scene, cuts, J, hl, label }: { scene: Scene; cuts: Map<string, Cutout> | null; J: number; hl: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const reduced = usePrefersReducedMotion();
  const [jAnim, setJAnim] = useState(J);
  const jNow = useRef(J);

  // ease the pull-apart (a still with reduced motion)
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const d = J - jNow.current;
      jNow.current = Math.abs(d) > 0.002 ? jNow.current + d * (1 - Math.exp(-dt * 7)) : J;
      setJAnim(jNow.current);
      if (jNow.current !== J) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [J, reduced]);
  const rJ = reduced ? J : jAnim;

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const K = (scene.pages[0]?.width ?? 820) / 820;
  const [bx0, by0, bx1, by1] = scene.pagesBox;
  const PCX = (bx0 + bx1) / 2;
  const PCY = (by0 + by1) / 2;
  const geo = useMemo(
    () =>
      scene.pieces.map((p) => {
        const vx = p.home[0] - PCX;
        const vy = p.home[1] - PCY;
        const vl = Math.hypot(vx, vy) || 1;
        return { path: linePath([...p.poly, p.poly[0], p.poly[1]]), jx: p.placed ? vx * 0.4 + (vx / vl) * 26 * K : 0, jy: p.placed ? vy * 0.4 + (vy / vl) * 26 * K : 0 };
      }),
    [scene, PCX, PCY, K],
  );
  const seamPaths = useMemo(() => scene.seams.map((s) => linePath(s.line)), [scene]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const DPR = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(size.w * DPR);
    cv.height = Math.round(size.h * DPR);
    const g = cv.getContext("2d")!;
    const fonts = readFonts(cv);
    const box = { x: 0, y: 0, w: size.w, h: size.h };
    const placed = scene.pieces.filter((p) => p.placed);
    const jb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    placed.forEach((p) => {
      const r = p.r;
      const x = p.home[0] + geo[p.i].jx;
      const y = p.home[1] + geo[p.i].jy;
      jb.x0 = Math.min(jb.x0, x - r);
      jb.y0 = Math.min(jb.y0, y - r);
      jb.x1 = Math.max(jb.x1, x + r);
      jb.y1 = Math.max(jb.y1, y + r);
    });
    const fa = fit({ x0: bx0 - 60 * K, y0: by0 - 56 * K, x1: bx1 + 60 * K, y1: by1 + 60 * K }, box);
    const fj = fit({ x0: jb.x0 - 10, y0: jb.y0 - 10, x1: jb.x1 + 10, y1: jb.y1 + 10 }, box);
    const c: Cam = lerpCam(fa, fj, easeIO(rJ));
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const poses: Pose[] = scene.pieces.map((p) => ({ x: p.home[0] + geo[p.i].jx * rJ, y: p.home[1] + geo[p.i].jy * rJ, a: p.ang, lift: rJ * 0.8, sc: 1, home: 1, k: 1 }));
    lightTable(g, c, scene.pagesBox, 1 - rJ * 0.4);
    drawFrame(g, c, scene.pages, 1 - rJ, fonts, { dark: true });
    setCam(g, c, DPR);
    if (cuts) {
      placed.forEach((p) => drawShadow(g, cuts.get(p.id) ?? null, poses[p.i], c, 1));
      placed.forEach((p) => drawPiece(g, cuts.get(p.id) ?? null, poses[p.i], 1));
    }
    g.lineJoin = "round";
    scene.seams.forEach((s, i) => {
      if (!s.line.length) return;
      const pa = poses[s.a];
      const pb = poses[s.b];
      const on = i === hl;
      if (s.read) {
        g.strokeStyle = COL.violet;
        g.lineWidth = (on ? 3.2 : 1.6) / c.s;
        g.globalAlpha = 0.95;
      } else {
        g.strokeStyle = COL.ink;
        g.lineWidth = (on ? 2.6 : 0.9) / c.s;
        g.globalAlpha = on ? 1 : 0.4;
      }
      if (rJ > 0.001) {
        strokeAt(g, seamPaths[i], pa.x - scene.pieces[s.a].home[0], pa.y - scene.pieces[s.a].home[1]);
        strokeAt(g, seamPaths[i], pb.x - scene.pieces[s.b].home[0], pb.y - scene.pieces[s.b].home[1]);
      } else g.stroke(seamPaths[i]);
    });
    g.globalAlpha = 1;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (rJ > 0.02) placed.forEach((p) => {
      const [sx, sy] = w2s(c, poses[p.i].x, poses[p.i].y);
      balloon(g, sx, sy, p.k, Math.min(1, rJ * 1.4), fonts, 11);
    });
    if (hl >= 0 && scene.seams[hl]?.line.length) {
      const s = scene.seams[hl];
      const pa = poses[s.a];
      const [sx, sy] = w2s(c, s.mid[0] + (pa.x - scene.pieces[s.a].home[0]), s.mid[1] + (pa.y - scene.pieces[s.a].home[1]));
      g.strokeStyle = s.read ? COL.violetLt : COL.chalk;
      g.lineWidth = 1.3;
      g.beginPath();
      g.arc(sx, sy, 16, 0, TAU);
      g.stroke();
    }
    if (mouse && cuts) {
      const scale = cuts.values().next().value?.scale ?? 1;
      const Z = 3 / scale;
      const RR = size.w < 560 ? 76 : 110;
      const { x: cx, y: cy } = mouse;
      const w0x = (cx - c.sx) / c.s + c.wx;
      const w0y = (cy - c.sy) / c.s + c.wy;
      g.save();
      g.beginPath();
      g.arc(cx, cy, RR, 0, TAU);
      g.fillStyle = COL.room;
      g.fill();
      g.clip();
      g.imageSmoothingEnabled = false;
      g.setTransform(DPR * Z, 0, 0, DPR * Z, DPR * Math.round(cx - w0x * Z), DPR * Math.round(cy - w0y * Z));
      placed.forEach((p) => drawPiece(g, cuts.get(p.id) ?? null, poses[p.i], 1));
      g.imageSmoothingEnabled = true;
      g.restore();
      g.lineWidth = 1.5;
      g.strokeStyle = COL.chalk;
      g.beginPath();
      g.arc(cx, cy, RR, 0, TAU);
      g.stroke();
      g.font = `500 11px ${fonts.sans}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineJoin = "round";
      g.lineWidth = 4;
      g.strokeStyle = COL.room;
      g.strokeText("×3 real pixels", cx, cy + RR + 14);
      g.fillStyle = COL.chalk;
      g.fillText("×3 real pixels", cx, cy + RR + 14);
    }
  });

  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div className="r-cv">
      <canvas
        ref={ref}
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          const r = e.currentTarget.getBoundingClientRect();
          setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
        onPointerLeave={(e) => e.pointerType !== "touch" && setMouse(null)}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") return;
          const r = e.currentTarget.getBoundingClientRect();
          setMouse({ x: e.clientX - r.left, y: e.clientY - r.top });
          if (touchTimer.current) clearTimeout(touchTimer.current);
          touchTimer.current = setTimeout(() => setMouse(null), 1800);
        }}
      />
    </div>
  );
}

/** A seam's real pixels around where text crosses it, at ×2 (two device pixels per photo pixel on a 2× screen). */
function Crop({ scene, seam, cuts, at }: { scene: Scene; seam: SceneSeam; cuts: Map<string, Cutout> | null; at: [number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !cuts) return;
    const scale = cuts.values().next().value?.scale ?? 1;
    const W = 420;
    const H = 126;
    cv.width = W;
    cv.height = H;
    const g = cv.getContext("2d")!;
    g.fillStyle = COL.room;
    g.fillRect(0, 0, W, H);
    const Z = 2 / scale;
    g.imageSmoothingEnabled = false;
    g.setTransform(Z, 0, 0, Z, Math.round(W / 2 - at[0] * Z), Math.round(H / 2 - at[1] * Z));
    for (const p of scene.pieces) {
      if (!p.placed) continue;
      if (Math.hypot(p.home[0] - at[0], p.home[1] - at[1]) > p.r + 200) continue;
      drawPiece(g, cuts.get(p.id) ?? null, { x: p.home[0], y: p.home[1], a: p.ang, lift: 0, home: 1, k: 1, sc: 1 }, 1);
    }
    g.setTransform(Z, 0, 0, Z, Math.round(W / 2 - at[0] * Z), Math.round(H / 2 - at[1] * Z));
    g.strokeStyle = seam.read ? COL.violet : "rgba(42,46,52,0.55)";
    g.lineWidth = 1.4 / Z;
    g.setLineDash([3 / Z, 3 / Z]);
    g.stroke(linePath(seam.line));
  }, [scene, seam, cuts, at]);
  const a = scene.pieces[seam.a].k;
  const b = scene.pieces[seam.b].k;
  return <canvas ref={ref} width={420} height={126} role="img" aria-label={`The tear between pieces ${a} and ${b}, real pixels`} />;
}

export function ResultSection({ result, photoSrc, J, setJ }: { result: RunResult; photoSrc: string | null; J: number; setJ: (v: number) => void }) {
  const scene = useMemo(() => buildScene(result), [result]);
  const [cuts, setCuts] = useState<Map<string, Cutout> | null>(null);
  const [hl, setHl] = useState(-1);
  const [view, setView] = useState<"text" | "translation">("text");

  useEffect(() => {
    if (!photoSrc) return;
    let cancelled = false;
    const key = cutoutKey(photoSrc, scene.pieces);
    sharedCutouts(key, async () => {
      const list = await makeCutouts(photoSrc, result.photo.width, scene.pieces);
      return new Map(list.map((c, i) => [scene.pieces[i].id, c] as const));
    })
      .then((m) => !cancelled && setCuts(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [photoSrc, scene, result.photo.width]);

  const readAt = useMemo(() => {
    const K = (scene.pages[0]?.width ?? 820) / 820;
    return scene.seams.map((s) => {
      const ca = cuts?.get(scene.pieces[s.a].id);
      const cb = cuts?.get(scene.pieces[s.b].id);
      if (!ca || !cb) return s.mid;
      const pa = scene.pieces[s.a];
      const pb = scene.pieces[s.b];
      return readPoint(s.line, s.mid, { cut: ca, x: pa.home[0], y: pa.home[1], ang: pa.ang }, { cut: cb, x: pb.home[0], y: pb.home[1], ang: pb.ang }, K);
    });
  }, [scene, cuts]);

  const transcript = result.transcripts.find((t) => t.ok) ?? result.transcripts[0] ?? null;
  const txt = transcript?.ok ? (view === "translation" && transcript.translation ? transcript.translation.text : transcript.text) : "";
  const txUrl = useMemo(() => (transcript?.ok ? URL.createObjectURL(new Blob([transcript.text + "\n"], { type: "text/plain" })) : null), [transcript]);
  useEffect(() => () => (txUrl ? URL.revokeObjectURL(txUrl) : undefined), [txUrl]);
  const json = result.source === "sample" && result.photo.url?.startsWith("/samples/") ? result.photo.url.replace(/photo[^/]*$/, "result.json") : `/api/runs/${result.runId}?download=1`;
  // the archive copy: the rebuilt pages with Muse's transcript as searchable text, and how they were rebuilt
  const [pdf, setPdf] = useState<"idle" | "making" | "failed">("idle");
  const savePdf = async () => {
    setPdf("making");
    try {
      const pages = result.pages.flatMap((p) => {
        if (!p.image) return [];
        const tr = result.transcripts.find((t) => t.page === p.id && t.ok);
        const translation = tr?.translation && tr.language !== tr.translation.to ? { text: tr.translation.text, from: languageName(tr.language) } : null;
        return [{ image: p.image, transcript: tr?.text ?? "", translation }];
      });
      const setAside = result.unplaced.length;
      const confirmed = result.joins.filter((j) => j.decidedBy !== "geometry").length;
      const day = result.createdAt ? result.createdAt.slice(0, 10) : "";
      const summary = [
        `${result.source === "sample" ? "A simulated tear of a sample letter, rebuilt" : "Rebuilt"} by Untorn from one photo${day ? ` on ${day}` : ""}.`,
        `${result.pieces.length - setAside} pieces placed on ${pages.length === 1 ? "one page" : `${pages.length} pages`}${setAside ? `; ${setAside} set aside, never forced` : ""}.`,
        `${result.joins.length} joins: ${confirmed} confirmed by Muse reading across the tear, the rest by the shape of the torn edges.`,
        ...(result.source === "sample" ? [] : [`The run, with every seam and its clues: ${location.origin}/r/${result.runId}`]),
      ];
      const blob = await pagesPdf(pages, { title: "A page rebuilt by Untorn", summary });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `untorn-${result.runId}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPdf("idle");
    } catch {
      setPdf("failed");
    }
  };

  const placed = scene.pieces.filter((p) => p.placed).length;
  const nPages = scene.pages.length;
  const read = scene.seams.filter((s) => s.read);
  // the reads in the order the pieces came home, then the rest by edge length
  const readFirst: SceneSeam[] = [];
  scene.order.forEach((o) => [o.read, ...o.more].forEach((i) => i !== null && !readFirst.includes(scene.seams[i]) && readFirst.push(scene.seams[i])));
  read.forEach((s) => !readFirst.includes(s) && readFirst.push(s));
  const rest = scene.seams.filter((s) => !s.read).sort((a, b) => b.len - a.len);
  let n = 0;
  const title = !nPages ? "No two pieces could be joined." : nPages === 1 ? `${placed} pieces, one page. Here it is.` : `${placed} pieces, ${nPages} pages. Here they are.`;

  const row = (s: SceneSeam) => {
    n++;
    const ka = Math.min(scene.pieces[s.a].k, scene.pieces[s.b].k);
    const kb = Math.max(scene.pieces[s.a].k, scene.pieces[s.b].k);
    const amp = s.profA && s.profB ? Math.max(4, ...s.profA.map(Math.abs), ...s.profB.map(Math.abs)) : 1;
    const jr = s.join.read;
    const sh = s.join.shape;
    let words: React.ReactNode;
    if (s.read) {
      const tokens = splitWords(s.read.words);
      words = (
        <>
          <span className="sw">{s.read.word ? <SplitWord word={s.read.word} split={s.read.split} /> : null}</span>
          <span className="ok">{s.read.words.join(", ")}</span>
          <span className="why">Muse: “{esc(s.read.reason)}”</span>
          <span className="dec">
            {s.join.decidedBy === "content" ? "Reading broke a tie between edges that fit alike." : "Joined on shape and reading."} {tokens.length && !tokens.some((t) => statedSplit(t, s.read!.reason)) ? "Muse didn’t say where the tear cuts each word." : ""}
          </span>
        </>
      );
    } else if (jr && jr.agrees === false) {
      words = (
        <>
          <span className="none">
            <span className="no">Muse read it as no join.</span> “{jr.reason}”
          </span>
          <span className="dec">The edge fit outweighed it.</span>
        </>
      );
    } else if (jr) {
      words = (
        <>
          <span className="none">Too little text crosses this tear to tell. Muse: “{jr.reason}”</span>
          <span className="dec">Placed by the edge.</span>
        </>
      );
    } else
      words = (
        <>
          <span className="none">Not read in this run. The edge places it.</span>
          {s.join.loop && <span className="dec">It closes a loop of joins already made.</span>}
        </>
      );
    return (
      <li key={s.i} tabIndex={0} className={hl === s.i ? "hl" : undefined} onMouseEnter={() => setHl(s.i)} onMouseLeave={() => setHl(-1)} onFocus={() => setHl(s.i)} onBlur={() => setHl(-1)}>
        <div className="k-id">
          <span className="j">J-{String(n).padStart(2, "0")}</span>
          <span className="b">{ka}</span>
          <span className="b">{kb}</span>
        </div>
        <div className="k-edge">
          {s.profA && s.profB ? (
            <>
              <span>A</span>
              <svg viewBox="0 0 140 16" aria-hidden="true">
                <path d={traceD(s.profA, amp)} />
              </svg>
              <span>B</span>
              <svg viewBox="0 0 140 16" aria-hidden="true">
                <path d={traceD(s.profB.map((v) => -v), amp)} />
              </svg>
              <span>A+B</span>
              <svg viewBox="0 0 140 16" aria-hidden="true">
                <path className="sum" d={traceD(s.profA.map((v, i) => v + s.profB![i]), amp)} />
              </svg>
            </>
          ) : null}
          <span className="len">
            fits along {Math.round(sh.score)} px, {sh.rms.toFixed(2)} px misfit
          </span>
        </div>
        <div className="k-crop">{s.line.length ? <Crop scene={scene} seam={s} cuts={cuts} at={readAt[s.i]} /> : null}</div>
        <div className="k-words">{words}</div>
      </li>
    );
  };

  const unplacedWhy = { "no-match": "no edge fitted", "twin-unresolved": "twins couldn't be told apart", rejected: "a fit was found but the clues disagreed" } as const;

  return (
    <section className="result" id="result" aria-labelledby="rh">
      <div className="r-head">
        <h2 id="rh">{title}</h2>
        <p className="r-sub">
          The rebuilt page, what Muse read on it, and every seam with both of its clues. <span className="on-fine">Hover the page for a real-pixel close-up; press <kbd>J</kbd> to pull it apart.</span>
          <span className="on-touch">Touch the page for a real-pixel close-up.</span>
        </p>
        <div className="dl" role="group" aria-label="Downloads">
          {result.pages.map(
            (p, i) =>
              p.image && (
                <a key={p.id} className="btn" href={p.image.startsWith("/api/") ? `${p.image}${p.image.includes("?") ? "&" : "?"}download=1` : p.image} download={`untorn-page${result.pages.length > 1 ? `-${i + 1}` : ""}.png`}>
                  <DlIcon />
                  Rebuilt page{result.pages.length > 1 ? ` ${i + 1}` : ""} <small>PNG</small>
                </a>
              ),
          )}
          {result.pages.some((p) => p.image) && (
            <button type="button" className="btn" onClick={savePdf} disabled={pdf === "making"}>
              <DlIcon />
              {pdf === "making" ? "Making the PDF…" : pdf === "failed" ? "PDF failed: try again" : "Searchable page"} <small>PDF</small>
            </button>
          )}
          {txUrl && (
            <a className="btn" href={txUrl} download="untorn-transcript.txt">
              <DlIcon />
              Transcript <small>TXT</small>
            </a>
          )}
          <a className="btn" href={json} download={`untorn-${result.runId}.json`}>
            <DlIcon />
            Join map <small>JSON</small>
          </a>
          <p className="meta">
            {result.timings.total ? `${(result.timings.total / 1000).toFixed(1)} s from photo to page` : ""}
            {result.cost ? `, model cost $${result.cost.usd.toFixed(2)}` : ""}
          </p>
        </div>
      </div>

      {nPages ? (
        <div className="r-grid">
          <figure className="r-plate">
            <div className="r-tools" role="group" aria-label="View">
              <button type="button" className="seg" aria-pressed={J === 0} onClick={() => setJ(0)}>
                Assembled
              </button>
              <button type="button" className="seg" aria-pressed={J === 1} onClick={() => setJ(1)}>
                Exploded <kbd>J</kbd>
              </button>
            </div>
            <Plate scene={scene} cuts={cuts} J={J} hl={hl} label={`The rebuilt page from ${placed} torn pieces, seams drawn as hairlines; violet seams were confirmed by reading across the tear.`} />
            <figcaption>
              Fig. 1. The page rebuilt from {placed} pieces. Hairlines are the tears; <span className="vi">violet</span> where Muse read a word across them.
            </figcaption>
          </figure>

          <div className="r-text">
            <h3>Transcript</h3>
            {transcript?.translation && (
              <div className="seg-row" role="tablist" aria-label="Transcript or translation">
                <button type="button" role="tab" className="seg" aria-selected={view === "text"} onClick={() => setView("text")}>
                  Original ({transcript.language})
                </button>
                <button type="button" role="tab" className="seg" aria-selected={view === "translation"} onClick={() => setView("translation")}>
                  English
                </button>
              </div>
            )}
            {transcript?.ok ? (
              <pre className="r-tx" lang={view === "translation" ? "en" : transcript.language} tabIndex={0}>
                {markGaps(txt)}
              </pre>
            ) : (
              <p className="r-note">Muse couldn’t read this page this time.</p>
            )}
            <p className="r-note">
              Read from the rebuilt page by Muse Spark. Line breaks follow the page; gaps where paper is missing are marked […], never filled in.
              {transcript?.uncertain.length ? ` Uncertain: ${transcript.uncertain.join(", ")}.` : ""}
            </p>
          </div>
        </div>
      ) : (
        <p className="r-empty">No two pieces could be joined with confidence. The pieces are shown as found.</p>
      )}

      {scene.seams.length > 0 && (
        <div className="key">
          <div className="key-h">
            <h3>Join map</h3>
            <p>Every place two pieces meet, with both clues. The shape clue is the two real edges, A and B, and their sum: true joins mirror, so the sum lies flat; the solver logs how far the edges fit and how far they miss. The word clue is the real pixels across the tear and what Muse read there.</p>
          </div>
          <ol className="key-list">
            <li className="key-sub">Read across the tear ({readFirst.length})</li>
            {readFirst.map(row)}
            <li className="key-sub">Placed by the edge ({rest.length})</li>
            {rest.map(row)}
          </ol>
        </div>
      )}

      {result.unplaced.length > 0 && (
        <div className="r-block">
          <h3>Left unplaced, never forced</h3>
          <ul>
            {result.unplaced.map((u) => {
              const p = scene.pieces.find((x) => x.id === u.id);
              return (
                <li key={u.id}>
                  Piece {p?.k ?? u.id}: {unplacedWhy[u.reason]}.
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className="r-block">
          <h3>Notes on this run</h3>
          <ul>
            {result.warnings.map((w) => (
              <li key={w.code}>{w.message || WARNINGS[w.code]}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function DlIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12" />
    </svg>
  );
}
