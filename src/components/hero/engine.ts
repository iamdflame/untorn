// The hero: a run drawn as an assembly drawing played backwards, on a light table in a dim room. A TypeScript port of
// the e4-exploded reference (round 7, app.js), driven by a real run instead of a design kit:
//   the photo → SAM 3.1's outlines trace each piece, balloons pop → the table drops away, the paper lifts and lights →
//   the pieces turn to the solver's true angles in an exploded drawing → join by join each piece lifts, carries on an
//   arc and settles with a small overshoot on its real pose; each read Muse confirmed opens a real-pixel close-up →
//   the climax: the camera goes in to the seam of the longest split word Muse read, and the tear closes on the paper →
//   the page is whole → (first screen) the twins → the transcript.
// A live run gates the clock on its events: it holds on the photo until SAM's outlines arrive, holds the lit pieces on
// the table (showing each read as Muse makes it) until the solver's poses arrive, and holds the whole page until the
// transcript arrives. Motion is transform and opacity on one canvas, plus a few DOM transforms.

import { buildScene, splitWords, statedSplit, type Scene, type SceneSeam } from "@/lib/run/scene";
import type { StackTrial } from "@/lib/run/samples";
import type { JoinOut, PageOut, PieceOut, ReadOut } from "@/lib/run/types";
import { cutoutKey, makeCutouts, readPoint, sharedCutouts, type Cutout } from "./cutouts";
import {
  COL,
  TAU,
  balloon,
  clamp,
  drawFrame,
  drawPiece,
  drawShadow,
  easeIO,
  easeOut,
  edgeLight,
  fit,
  lerp,
  lerpCam,
  lightTable,
  linePath,
  polyPath,
  readFonts,
  setCam,
  settle,
  smooth,
  splitWord,
  spring,
  strokeAt,
  w2s,
  type Box,
  type Cam,
  type Fonts,
  type Pose,
  type Rect,
} from "./draw";

export type EngineInput = {
  /** Identity of the run: the clock restarts when it changes. */
  key: string;
  mode: "recorded" | "live" | "replay";
  photo: { src: string; width: number; height: number } | null;
  pieces: PieceOut[];
  pages: PageOut[];
  joins: JoinOut[];
  reads: ReadOut[];
  transcript: string | null;
  /** Live progress, for the status line. */
  progress: { stage: string | null; asks: number; done: boolean; failed: boolean };
  twins: StackTrial | null;
};

export type HeroApi = {
  update: (input: EngineInput) => void;
  setReduced: (r: boolean) => void;
  destroy: () => void;
};

type P = Scene["pieces"][number] & {
  path: Path2D;
  ex: number;
  ey: number;
  ux: number;
  uy: number;
  jx: number;
  jy: number;
};
type S = SceneSeam & { path: Path2D; slen: number; readAt: [number, number] };
type Beat = { step: number; seam: number; t0: number; t1: number; lead: boolean; n: number };

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const curly = (s: string) => s.replace(/'/g, "’").replace(/(^|[\s(“"])’/g, "$1‘");

export function createHero(root: HTMLElement, opts: { reduced: boolean }): HeroApi {
  const $ = <E extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as E;
  const cv = $<HTMLCanvasElement>(".plate");
  const ctx = cv.getContext("2d")!;
  const placeholder = root.querySelector<HTMLImageElement>(".hero-photo");
  const elArea = $(".m-area");
  const elCenter = $(".m-center");
  const elProof = $(".m-proof");
  const elLead = $(".lead");
  const elRail = $(".rail");
  const h1L = $(".torn .hl");
  const h1R = $(".torn .hr");
  const h1Seam = $<SVGPathElement>(".tseam path");
  const elIntro = $(".intro");
  const elTx = $(".tx");
  const elTxBody = $(".tx-body");
  const elTxMore = $(".tx-more");
  const elRdWord = $(".rd-word");
  const elRdNote = $(".rd-note");
  const elStatus = $(".status");
  const elCl = $(".climax");
  const clL = $(".cl-l");
  const clR = $(".cl-r");
  const clBar = $(".cl-bar");
  const clWhy = $(".cl-why");
  const clCell = $(".cl-cell");
  const elTw = root.querySelector<HTMLElement>(".twins");
  const btnPlay = $<HTMLButtonElement>(".btn-play");
  const btnJ = $<HTMLButtonElement>(".btn-j");
  const caret = document.createElement("span");
  caret.className = "car";
  const txNode = document.createTextNode("");
  elTxBody.replaceChildren(txNode, caret);

  let fonts: Fonts = readFonts(root);
  let reduced = opts.reduced;
  let input: EngineInput | null = null;
  let scene: Scene | null = null;
  let pieces: P[] = [];
  let seams: S[] = [];
  let cuts = new Map<string, Cutout>();
  let cutKey = "";
  let cutsReady = false;
  let cutSignal = { cancelled: false };
  let readAtDone = false;
  const photo = new Image();
  photo.decoding = "async";
  let photoOk = false;
  photo.onload = () => {
    photoOk = true;
    dirty = true;
    startCutouts();
  };

  /* ---------------- geometry derived from the scene ---------------- */
  let K = 1;
  let PCX = 0;
  let PCY = 0;
  let PHC = { x: 0, y: 0 };
  let litScale = 1;
  let ZOOM = 2;
  let assembled = false;
  let order: Scene["order"] = [];
  let orderIdx: Record<number, number> = {};
  let LAST = -1;
  let climaxSeam: S | null = null;
  let beats: Beat[] = [];
  let TEXT = "";
  let TEXT_START = "";
  let TEXT_LINES = 0;

  const T = {
    trace0: 0.9,
    traceDur: 0.62,
    traceStag: 0.085,
    lift0: 2.05,
    lift1: 2.6,
    exp0: 2.55,
    exp1: 3.75,
    fly: 0.95,
    stepT: [] as number[],
    cl0: -99,
    cl1: -99,
    seat: 0,
    asmEnd: 0,
    whole: 0,
    tw0: 0,
    tw1: 0,
    tx0: 0,
    tx1: 0,
    end: 0,
    loop: 0,
  };
  const TW = { ask: 0.7, try0: 3.6, tryDur: 1.45 };
  /** A live run waits here, the lit pieces on the table, until the solver's poses arrive. */
  const HOLD = 4.0;
  /** The live run waited on the table: when the poses arrive the clock steps back to the explode, outlines and
   * balloons already gone. */
  let rewound = false;
  let STOPS: number[] = [0];

  function setScene(sc: Scene) {
    scene = sc;
    const was = assembled;
    assembled = sc.pages.length > 0;
    if (assembled && !was && input?.mode === "live" && t > T.exp0) {
      t = T.exp0;
      rewound = true;
    }
    const [bx0, by0, bx1, by1] = sc.pagesBox;
    PCX = (bx0 + bx1) / 2;
    PCY = (by0 + by1) / 2;
    K = (sc.pages[0]?.width ?? 820) / 820;
    pieces = sc.pieces.map((p) => {
      const path = polyPath(p.poly);
      const hx = p.home[0];
      const hy = p.home[1];
      const vx = hx - PCX;
      const vy = hy - PCY;
      const vl = Math.hypot(vx, vy) || 1;
      const ex = p.placed ? hx + vx * 0.46 + (vx / vl) * 70 * K : p.c[0];
      const ey = p.placed ? hy + vy * 0.46 + (vy / vl) * 70 * K : p.c[1];
      const dl = Math.hypot(ex - hx, ey - hy) || 1;
      return { ...p, path, ex, ey, ux: (ex - hx) / dl, uy: (ey - hy) / dl, jx: p.placed ? vx * 0.4 + (vx / vl) * 26 * K : 0, jy: p.placed ? vy * 0.4 + (vy / vl) * 26 * K : 0 };
    });
    PHC = { x: pieces.reduce((n, p) => n + p.c[0], 0) / (pieces.length || 1), y: pieces.reduce((n, p) => n + p.c[1], 0) / (pieces.length || 1) };
    seams = sc.seams.map((s) => {
      let slen = 0;
      for (let j = 2; j < s.line.length; j += 2) slen += Math.hypot(s.line[j] - s.line[j - 2], s.line[j + 1] - s.line[j - 1]);
      return { ...s, path: linePath(s.line), slen, readAt: [s.mid[0], s.mid[1]] as [number, number] };
    });
    order = sc.order;
    orderIdx = {};
    order.forEach((o, i) => (orderIdx[o.piece] = i));
    LAST = order.length - 1;
    climaxSeam = sc.climax ? seams[sc.climax.seam] : null;
    setHover();
    readAtDone = false;
    computeT();
    setClimaxText();
    setHeadline();
    layout();
  }

  /** The climax piece hovers short of home across its seam: along the seam's normal, away from its partner. */
  let hover: [number, number] = [0, 0];
  function setHover() {
    if (!climaxSeam || LAST < 0) return;
    const last = order[LAST].piece;
    const partner = climaxSeam.a === last ? climaxSeam.b : climaxSeam.a;
    const L = climaxSeam.line;
    const [rx, ry] = climaxSeam.readAt;
    let bi = 0;
    for (let j = 0; j < L.length; j += 2) if (Math.hypot(L[j] - rx, L[j + 1] - ry) < Math.hypot(L[bi] - rx, L[bi + 1] - ry)) bi = j;
    const j0 = Math.max(0, bi - 4);
    const j1 = Math.min(L.length - 2, bi + 4);
    let tx = L[j1] - L[j0];
    let ty = L[j1 + 1] - L[j0 + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    let nx = -ty;
    let ny = tx;
    const p = pieces[last];
    const q = pieces[partner];
    if ((p.home[0] - q.home[0]) * nx + (p.home[1] - q.home[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    hover = [nx, ny];
  }

  function computeT() {
    const n = pieces.length;
    T.traceStag = Math.min(0.085, 0.9 / Math.max(1, n));
    T.stepT = [];
    beats = [];
    const base = clamp(6 / Math.max(1, order.length), 0.2, 0.5);
    let t = 3.8;
    order.forEach((o, i) => {
      T.stepT.push(t);
      const isLast = i === LAST && !!climaxSeam;
      if (isLast) return;
      let d = base;
      if (o.read !== null) {
        beats.push({ step: i, seam: o.read, t0: t - 0.05, t1: t + 1.1, lead: true, n: beats.length });
        d = 1.15;
        o.more.forEach((m, j) => beats.push({ step: i, seam: m, t0: t + 1.15 + j * 1.05, t1: t + 1.15 + j * 1.05 + 1.0, lead: false, n: beats.length }));
        d += o.more.length * 1.05;
      }
      t += i === 0 ? 0.5 : d;
    });
    if (climaxSeam && LAST >= 0) {
      const o = order[LAST];
      const s0 = T.stepT[LAST];
      o.more.forEach((m, j) => beats.push({ step: LAST, seam: m, t0: s0 + 0.9 + j * 1.1, t1: s0 + 0.9 + j * 1.1 + 1.05, lead: false, n: beats.length }));
      T.cl0 = s0 + 0.95 + o.more.length * 1.1;
      T.cl1 = T.cl0 + 3.7;
      T.seat = T.cl0 + 1.2;
      T.asmEnd = T.seat + T.fly;
      T.whole = T.cl1 + 0.1;
    } else {
      T.cl0 = T.cl1 = -99;
      T.seat = LAST >= 0 ? T.stepT[LAST] : 3.8;
      T.asmEnd = T.seat + T.fly;
      T.whole = T.asmEnd + 0.4;
    }
    // a read window lasts until the next one opens (it lingers while edge-only pieces come home), at most 2.6 s
    beats.sort((a, b) => a.t0 - b.t0);
    beats.forEach((b, i) => {
      const nx = beats[i + 1];
      b.n = i;
      b.t1 = Math.max(b.t1, Math.min(nx ? nx.t0 - 0.05 : b.t0 + 1.6, b.t0 + 2.6));
      if (climaxSeam) b.t1 = Math.min(b.t1, T.cl0 - 0.3);
    });
    const twins = input?.twins && input.mode === "recorded";
    if (twins) {
      T.tw0 = T.whole + 1.0;
      T.tw1 = T.tw0 + TW.try0 + 3 * TW.tryDur + 2.8;
    } else T.tw0 = T.tw1 = T.whole + 0.6;
    T.tx0 = T.tw1 + 0.2;
    T.tx1 = T.tx0 + 2.4;
    T.end = T.tx1 + 0.2;
    T.loop = T.end + 7;
    STOPS = [0, T.trace0, T.lift0, T.exp0, ...T.stepT, ...(climaxSeam ? [T.cl0 + 2.6] : []), T.whole + 0.6, ...(twins ? [T.tw0] : []), T.tx0, T.end];
  }

  /* ---------------- cut-outs, then where text crosses each seam ---------------- */
  function startCutouts() {
    if (!photoOk || !scene || !input?.photo) return;
    const key = cutoutKey(input.photo.src, scene.pieces);
    if (key === cutKey) return;
    cutKey = key;
    cutSignal.cancelled = true;
    cutSignal = { cancelled: false };
    const sig = cutSignal;
    cutsReady = false;
    cuts = new Map();
    const ps = scene.pieces;
    const worldW = input.photo.width;
    sharedCutouts(key, () =>
      makeCutouts(photo, worldW, ps, (i, c) => {
        if (sig.cancelled || cutKey !== key) return;
        cuts.set(ps[i].id, c);
        litScale = c.scale;
        dirty = true;
      }).then((list) => new Map(list.map((c, i) => [ps[i].id, c] as const))),
    ).then((m) => {
      if (sig.cancelled || cutKey !== key) return;
      cuts = m;
      litScale = m.values().next().value?.scale ?? 1;
      cutsReady = true;
      readAtDone = false;
      dirty = true;
    });
  }

  function findReadPoints() {
    if (readAtDone || !cutsReady || !assembled) return;
    readAtDone = true;
    for (const s of seams) {
      const ca = cuts.get(pieces[s.a].id);
      const cb = cuts.get(pieces[s.b].id);
      if (!ca || !cb) continue;
      const pa = pieces[s.a];
      const pb = pieces[s.b];
      s.readAt = readPoint(s.line, s.mid, { cut: ca, x: pa.home[0], y: pa.home[1], ang: pa.ang }, { cut: cb, x: pb.home[0], y: pb.home[1], ang: pb.ang }, K);
    }
    const pageSrcPx = (scene?.pages[0]?.width ?? 844) / litScale;
    ZOOM = clamp(Math.round(2400 / pageSrcPx), 2, 3);
    setHover();
    layout();
  }

  /* ---------------- layout and cameras ---------------- */
  let W = 0;
  let H = 0;
  let DPR = 1;
  let phone = false;
  const R: Record<"area" | "center" | "proof" | "full", Rect> = { area: { x: 0, y: 0, w: 1, h: 1 }, center: { x: 0, y: 0, w: 1, h: 1 }, proof: { x: 0, y: 0, w: 1, h: 1 }, full: { x: 0, y: 0, w: 1, h: 1 } };
  const F: Record<"photo" | "expl" | "final" | "join" | "climax", Cam> = { photo: cam0(), expl: cam0(), final: cam0(), join: cam0(), climax: cam0() };
  function cam0(): Cam {
    return { s: 1, wx: 0, wy: 0, sx: 0, sy: 0 };
  }
  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    const h = root.getBoundingClientRect();
    return { x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height };
  }
  function polyBox(p: P, x: number, y: number, a: number, b: Box) {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i < p.poly.length; i += 6) {
      const px = p.poly[i];
      const py = p.poly[i + 1];
      const X = x + px * ca - py * sa;
      const Y = y + px * sa + py * ca;
      if (X < b.x0) b.x0 = X;
      if (X > b.x1) b.x1 = X;
      if (Y < b.y0) b.y0 = Y;
      if (Y > b.y1) b.y1 = Y;
    }
    return b;
  }
  const pagesB = (): Box => {
    const pb = scene?.pagesBox ?? [0, 0, input?.photo?.width ?? 1600, input?.photo?.height ?? 1200];
    return { x0: pb[0], y0: pb[1], x1: pb[2], y1: pb[3] };
  };
  function posesBox(list: [P, number, number, number][]) {
    const b = pagesB();
    list.forEach(([p, x, y, a]) => polyBox(p, x, y, a, b));
    return b;
  }
  const MARG = () => (phone ? [10, 26, 26] : [30, 30, 30]).map((v) => v * K);
  function withMargins(b: Box): Box {
    const m = MARG();
    const pb = pagesB();
    return { x0: Math.min(b.x0, pb.x0 - m[0]), y0: Math.min(b.y0, pb.y0 - m[1]), x1: Math.max(b.x1, pb.x1 + m[0]), y1: Math.max(b.y1, pb.y1 + m[2]) };
  }

  function layout() {
    const hr = root.getBoundingClientRect();
    W = hr.width;
    H = hr.height;
    DPR = Math.min(2, devicePixelRatio || 1);
    phone = W <= 760;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    R.area = rectOf(elArea);
    R.center = rectOf(elCenter);
    R.proof = rectOf(elProof);
    const PWX = input?.photo?.width ?? 1600;
    const PHY = input?.photo?.height ?? 1200;
    // the photo covers the stage, centred (the server-rendered placeholder uses the same framing)
    const s = Math.max(R.area.w / PWX, R.area.h / PHY);
    F.photo = { s, wx: PWX / 2, wy: PHY / 2, sx: R.area.x + R.area.w / 2, sy: R.area.y + R.area.h / 2 };
    const railH = rectOf(elRail).h;
    R.full = phone ? R.area : { x: 0, y: railH, w: W, h: H - railH };
    if (scene && assembled) {
      const eb = posesBox(pieces.map((p) => [p, p.ex, p.ey, p.ang]));
      F.expl = fit(withMargins(eb), R.center);
      F.final = fit(withMargins(pagesB()), R.center);
      const jb = posesBox(pieces.map((p) => [p, p.home[0] + p.jx, p.home[1] + p.jy, p.ang]));
      F.join = fit({ x0: jb.x0 - 30 * K, y0: jb.y0 - 30 * K, x1: jb.x1 + 30 * K, y1: jb.y1 + 30 * K }, R.center);
      if (climaxSeam) {
        const [fx, fy0] = climaxSeam.readAt;
        const fy = fy0 + (phone ? 4 : 10) * K;
        const z = zoomNow() / litScale;
        F.climax = { s: z, wx: fx, wy: fy, sx: Math.round(R.full.x + R.full.w / 2), sy: Math.round(R.full.y + R.full.h * (phone ? 0.4 : 0.36)) };
      }
    } else {
      F.expl = F.final = F.join = F.climax = F.photo;
    }
    if (placeholder) {
      placeholder.style.left = `${R.area.x}px`;
      placeholder.style.top = `${R.area.y}px`;
      placeholder.style.width = `${R.area.w}px`;
      placeholder.style.height = `${R.area.h}px`;
    }
    setHeadline();
    layoutTwins();
    dirty = true;
  }

  /** Whole-number zoom of the photo's own pixels: one step less on a phone's narrow stage. */
  const zoomNow = () => (phone ? Math.max(2, ZOOM - 1) : ZOOM);
  function liveFrame(poses: Pose[]): Cam {
    const b = posesBox(poses.map((ps, i) => [pieces[i], ps.x, ps.y, ps.a]));
    b.x0 -= 20 * K;
    b.x1 += 20 * K;
    b.y0 -= 20 * K;
    b.y1 += 24 * K;
    return fit(withMargins(b), R.center);
  }
  function climaxZoom(t: number) {
    if (!climaxSeam) return 0;
    return smooth(T.cl0 - 0.15, T.cl0 + 0.45, t) * (1 - smooth(T.cl1 - 0.55, T.cl1, t));
  }
  function camAt(t: number, j: number, poses: Pose[]): Cam {
    let c: Cam;
    if (!assembled || t < T.exp0) c = F.photo;
    else if (t < T.stepT[0]) c = lerpCam(F.photo, F.expl, easeIO(clamp((t - T.exp0) / (T.stepT[0] - T.exp0))));
    else if (t < T.asmEnd + 0.4) {
      const lag = pieces.map((p) => poseAt(p, Math.max(T.stepT[0], t - 0.35), 0));
      c = lerpCam(liveFrame(lag), liveFrame(poses), 0.5);
      c = lerpCam(F.expl, c, smooth(T.stepT[0], T.stepT[0] + 0.5, t));
      if (t > T.seat) c = lerpCam(c, F.final, smooth(T.seat, T.asmEnd + 0.4, t));
    } else c = F.final;
    const z = climaxZoom(t);
    if (z > 0) c = z >= 0.999 ? F.climax : lerpCam(c, F.climax, easeIO(z));
    if (j > 0) c = lerpCam(c, F.join, j);
    return c;
  }

  /* ---------------- poses: lift, carry with weight on an arc, settle with a small overshoot ---------------- */
  function poseAt(p: P, t: number, j: number): Pose {
    const i = orderIdx[p.i];
    let x: number;
    let y: number;
    let a: number;
    let lift: number;
    let home = 0;
    let k = 0;
    const testing = liveTesting.has(p.i) ? 1 : 0;
    if (!assembled || !p.placed || i === undefined || t <= T.exp0) {
      x = p.c[0];
      y = p.c[1];
      a = 0;
      lift = Math.max(smooth(T.lift0, T.lift1, t), testing);
      if (assembled && !p.placed) lift = smooth(T.lift0, T.lift1, t) * (1 - smooth(T.exp0, T.exp1, t));
    } else {
      const ts = T.stepT[i];
      if (t < ts) {
        const st = T.exp0 + (i % 5) * 0.05;
        const u = clamp((t - st) / (T.exp1 - T.exp0 - 0.2));
        const up = easeIO(u);
        const ua = easeIO(clamp(u * 1.18));
        const dx = p.ex - p.c[0];
        const dy = p.ey - p.c[1];
        const dd = Math.hypot(dx, dy) || 1;
        const arc = Math.sin(Math.PI * up) * Math.min(90 * K, dd * 0.12);
        x = lerp(p.c[0], p.ex, up) + (dy / dd) * arc;
        y = lerp(p.c[1], p.ey, up) - Math.abs(dx / dd) * arc;
        a = lerp(0, p.ang, ua);
        lift = 1;
      } else {
        let fromX = p.ex;
        let fromY = p.ey;
        let e = t - ts;
        let toX = p.home[0];
        let toY = p.home[1];
        const climaxPiece = i === LAST && !!climaxSeam;
        if (climaxPiece) {
          const hvx = p.home[0] + hover[0] * 34 * K;
          const hvy = p.home[1] + hover[1] * 34 * K;
          if (t < T.seat) {
            toX = hvx;
            toY = hvy;
          } else {
            fromX = hvx;
            fromY = hvy;
            e = t - T.seat;
          }
        }
        k = spring(e);
        const dd = Math.hypot(toX - fromX, toY - fromY);
        const arc = Math.sin(Math.PI * clamp(k)) * Math.min(60 * K, dd * 0.16);
        x = lerp(fromX, toX, k);
        y = lerp(fromY, toY, k) - arc;
        const landing = climaxPiece && t < T.seat ? 0 : 1;
        a = p.ang + 0.035 * settle(e - 0.42) * landing + 0.04 * Math.sin(Math.PI * clamp(k)) * Math.sign(p.ux || 1) * (climaxPiece && t >= T.seat ? 0.3 : 1);
        lift = landing ? 1 - smooth(0.25, 0.75, e / T.fly) : 1;
        home = landing ? smooth(0.55, 0.9, e / T.fly) : 0;
        if (climaxPiece && t < T.seat) k = 0.86 * k;
      }
    }
    if (j > 0 && p.placed) {
      x += p.jx * j;
      y += p.jy * j;
      lift = Math.max(lift, j * 0.7);
    }
    return { x, y, a, lift, home, k, sc: 1 + 0.022 * lift };
  }

  /* ---------------- the hero scene ---------------- */
  function twinsVis(t: number) {
    if (!(input?.twins && input.mode === "recorded")) return 0;
    return smooth(T.tw0 - 0.3, T.tw0 + 0.2, t) * (1 - smooth(T.tw1 - 0.35, T.tw1, t));
  }
  /** Before the poses arrive, the light table sits under the pieces: a page-sized patch at their centre. */
  function tableBox(): [number, number, number, number] {
    const area = pieces.reduce((n, p) => n + (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]) * 0.6, 0) || 1e6;
    const h = Math.sqrt(area * 1.3);
    const w = h / 1.3;
    return [PHC.x - w / 2, PHC.y - h / 2, PHC.x + w / 2, PHC.y + h / 2];
  }
  function homeFrac(t: number) {
    if (!assembled || !pieces.length) return 0;
    return pieces.reduce((n, p) => n + (p.placed ? poseAt(p, t, 0).home : 1), 0) / pieces.length;
  }

  function drawHero(t: number, j: number) {
    const g = ctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const ph = photoOk ? photo : placeholder && placeholder.complete && placeholder.naturalWidth ? placeholder : null;
    if (!input?.photo || !ph) {
      // nothing to draw yet: let the server-rendered photo show through
      g.clearRect(0, 0, W, H);
      return;
    }
    g.fillStyle = COL.room;
    g.fillRect(0, 0, W, H);
    const poses = pieces.map((p) => poseAt(p, t, j));
    const c = camAt(t, j, pieces.map((p) => poseAt(p, t, 0)));
    const z = climaxZoom(t);
    const litA = cutsReady ? smooth(T.lift0, T.lift1 + 0.15, t) : 0;
    const expl = smooth(T.exp0, T.exp1, t);
    const photoA = 1 - (cutsReady ? smooth(T.lift0, T.lift1, t) : 0);
    const shadowA = cutsReady ? smooth(T.lift0 + 0.1, T.lift1, t) : 0;
    const dimsA = smooth(T.exp0 + 0.4, T.exp1, t) * (1 - smooth(T.stepT[1] ?? T.exp1 + 1, (T.stepT[1] ?? T.exp1 + 1) + 0.6, t)) * (1 - j);
    const cornersA = assembled ? smooth(T.exp0 + 0.4, T.exp1, t) * (1 - smooth(T.stepT[1] ?? T.exp1 + 1, (T.stepT[1] ?? T.exp1 + 1) + 0.6, t)) : 0;
    const wholeA = smooth(T.whole, T.whole + 0.7, t);
    const pb = assembled && scene ? scene.pagesBox : tableBox();

    g.save();
    lightTable(g, c, pb as [number, number, number, number], (cutsReady ? smooth(T.lift0, T.lift1 + 0.3, t) : 0) * (1 - z));
    {
      const cr = z > 0.001 ? R.full : R.area;
      g.beginPath();
      g.rect(cr.x, cr.y, cr.w, cr.h);
      g.clip();
    }
    if (photoA > 0.002) {
      g.save();
      g.beginPath();
      g.rect(R.area.x, R.area.y, R.area.w, R.area.h);
      g.clip();
      g.globalAlpha = photoA;
      setCam(g, c, DPR);
      g.drawImage(ph, 0, 0, input.photo.width, input.photo.height);
      g.restore();
      g.globalAlpha = 1;
      if (placeholder && !placeholderHidden) {
        placeholderHidden = true;
        placeholder.style.opacity = "0";
      }
    }
    if (scene) drawFrame(g, c, scene.pages, cornersA * (1 - z), fonts, { dark: true, dimA: dimsA / Math.max(cornersA, 0.001) });

    setCam(g, c, DPR);
    const crisp = z >= 0.999;
    g.imageSmoothingEnabled = !crisp;
    const under = climaxSeam && z > 0 && t < T.seat + T.fly ? order[LAST].piece : -1;
    const zo = pieces.map((_, i) => i).sort((a, b) => Number(b === under) - Number(a === under) || poses[a].lift - poses[b].lift || (orderIdx[a] ?? 99) - (orderIdx[b] ?? 99));
    const dimA = (i: number) => (assembled && !pieces[i].placed ? 1 - 0.55 * expl : 1);
    if (shadowA > 0) zo.forEach((i) => drawShadow(g, cuts.get(pieces[i].id) ?? null, poses[i], c, shadowA * (1 - z) * dimA(i)));
    if (litA > 0.001)
      zo.forEach((i) => {
        g.globalAlpha = dimA(i);
        drawPiece(g, cuts.get(pieces[i].id) ?? null, poses[i], litA);
        g.globalAlpha = 1;
      });
    g.imageSmoothingEnabled = true;
    if (litA > 0.02 && z < 0.5) zo.forEach((i) => edgeLight(g, pieces[i].path, poses[i], c, litA * (liveTesting.has(i) ? 1 : 0.55) * (1 - z * 2) * dimA(i), DPR));

    // SAM's outlines: traced on the photo, then they hand over to the paper's own edges
    g.lineJoin = "round";
    g.lineCap = "round";
    pieces.forEach((p, i) => {
      const pr = clamp((t - (T.trace0 + i * T.traceStag)) / T.traceDur);
      if (pr <= 0) return;
      const ps = poses[i];
      let a = 1 - (assembled ? smooth(T.exp1 - 0.4, T.exp1 + 0.4, t) : cutsReady ? smooth(T.lift1, T.lift1 + 0.6, t) * 0.85 : 0);
      if (rewound) a = Math.min(a, 0.15);
      if (a < 0.01) return;
      g.save();
      g.translate(ps.x, ps.y);
      g.rotate(ps.a);
      g.scale(ps.sc, ps.sc);
      g.globalAlpha = a;
      g.strokeStyle = "rgba(250,246,238,0.85)";
      g.lineWidth = 3.6 / c.s;
      g.setLineDash(pr < 1 ? [p.len * pr, p.len] : []);
      g.stroke(p.path);
      g.strokeStyle = COL.ink;
      g.lineWidth = 1.5 / c.s;
      g.stroke(p.path);
      g.restore();
    });
    g.setLineDash([]);
    g.globalAlpha = 1;

    // confirmed seams: a violet hairline where Muse read across, a graphite one where the edge alone decided
    if (assembled && z < 0.98)
      seams.forEach((s) => {
        if (!s.line.length) return;
        const last = Math.max(orderIdx[s.a] ?? 0, orderIdx[s.b] ?? 0);
        const land = last === LAST && climaxSeam ? T.seat + T.fly * 0.62 : (T.stepT[last] ?? 0) + T.fly * 0.62;
        const pr = j > 0 ? 1 : clamp((t - land) / 0.45);
        if (pr <= 0) return;
        const pa = poses[s.a];
        const pbp = poses[s.b];
        g.setLineDash(pr < 1 ? [s.slen * pr, s.slen] : []);
        if (s.read) {
          g.strokeStyle = COL.violet;
          g.lineWidth = 1.8 / c.s;
          g.globalAlpha = 0.95 * (1 - z);
        } else {
          g.strokeStyle = COL.ink;
          g.lineWidth = 0.9 / c.s;
          g.globalAlpha = 0.35 * (1 - z);
        }
        if (j > 0.001) {
          strokeAt(g, s.path, pa.x - pieces[s.a].home[0], pa.y - pieces[s.a].home[1]);
          strokeAt(g, s.path, pbp.x - pieces[s.b].home[0], pbp.y - pieces[s.b].home[1]);
        } else g.stroke(s.path);
      });
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.restore();

    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    // balloons: only while SAM finds the pieces (and in the join map)
    const bc = { x: lerp(PHC.x, PCX || PHC.x, assembled ? expl : 0), y: lerp(PHC.y, PCY || PHC.y, assembled ? expl : 0) };
    g.save();
    g.beginPath();
    g.rect(R.area.x, R.area.y, R.area.w, R.area.h);
    g.clip();
    pieces.forEach((p, i) => {
      const ps = poses[i];
      const done = T.trace0 + i * T.traceStag + T.traceDur;
      const a = (rewound ? 0 : smooth(done - 0.1, done + 0.2, t) * (1 - (assembled ? smooth(T.exp1 - 0.3, T.exp1 + 0.3, t) : cutsReady ? smooth(T.lift1 + 0.4, T.lift1 + 1.2, t) : 0))) + j * wholeA;
      if (a < 0.01) return;
      const [sx, sy] = w2s(c, ps.x, ps.y);
      let dx = ps.x - bc.x;
      let dy = ps.y - bc.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const off = p.r * c.s * 0.42 + 22;
      const bx = clamp(sx + dx * off, R.area.x + 16, R.area.x + R.area.w - 16);
      const by = clamp(sy + dy * off, R.area.y + 16, R.area.y + R.area.h - (phone ? 16 : 70));
      g.globalAlpha = a;
      g.strokeStyle = COL.ink;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(bx - dx * 11, by - dy * 11);
      g.stroke();
      g.fillStyle = COL.ink;
      g.beginPath();
      g.arc(sx, sy, 2.6, 0, TAU);
      g.fill();
      balloon(g, bx, by, p.k, a, fonts, phone ? 10 : 12);
    });
    g.restore();
    g.globalAlpha = 1;
    if (j > 0.02) drawJoinLabels(g, c, poses, j);

    // the twins and the climax each get one crisp stage
    const tv = twinsVis(t);
    if (tv > 0) {
      g.globalAlpha = tv;
      g.fillStyle = COL.room;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
    if (phone && j < 0.3) {
      const A = activeA(t);
      if (A > 0.01) {
        g.globalAlpha = A * 0.62;
        g.fillStyle = COL.room;
        g.fillRect(R.area.x, R.area.y, R.area.w, R.area.h);
        g.globalAlpha = 1;
      }
    }
    drawProof(g, c, poses, t, j);
    drawLiveRead(g);

    if (input.mode === "recorded") {
      const lf = smooth(T.loop - 0.7, T.loop, t);
      if (lf > 0) {
        g.globalAlpha = lf;
        g.fillStyle = COL.room;
        g.fillRect(R.area.x, 0, W, H);
        g.globalAlpha = 1;
      }
    }
  }
  let placeholderHidden = false;

  function drawJoinLabels(g: CanvasRenderingContext2D, c: Cam, poses: Pose[], j: number) {
    g.save();
    g.globalAlpha = smooth(0.4, 1, j);
    seams.forEach((s) => {
      if (!s.line.length) return;
      const pa = poses[s.a];
      const pbp = poses[s.b];
      const A = pieces[s.a];
      const B = pieces[s.b];
      const [x0, y0] = w2s(c, s.mid[0] + (pa.x - A.home[0]), s.mid[1] + (pa.y - A.home[1]));
      const [x1, y1] = w2s(c, s.mid[0] + (pbp.x - B.home[0]), s.mid[1] + (pbp.y - B.home[1]));
      g.strokeStyle = s.read ? COL.violetLt : COL.chalk3;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.setLineDash([]);
      for (const [x, y] of [
        [x0, y0],
        [x1, y1],
      ]) {
        g.fillStyle = s.read ? COL.violetLt : COL.chalk2;
        g.beginPath();
        g.arc(x, y, 2.2, 0, TAU);
        g.fill();
      }
      if (s.read?.word) {
        const fz = phone ? 14 : 17;
        g.font = `500 ${fz}px ${fonts.serif}`;
        g.textAlign = "left";
        g.textBaseline = "alphabetic";
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2 + fz * 0.35;
        if (s.read.split) {
          const [l, r] = s.read.split;
          const w = g.measureText(l).width + g.measureText(r).width + fz * 0.3;
          splitWord(g, l, r, cx - w / 2, cy, fz, COL.violet, COL.filmHi);
        } else {
          g.textAlign = "center";
          g.lineJoin = "round";
          g.lineWidth = 4;
          g.strokeStyle = COL.filmHi;
          g.strokeText(s.read.word, cx, cy);
          g.fillStyle = COL.violet;
          g.fillText(s.read.word, cx, cy);
        }
      }
    });
    g.restore();
  }

  /* ---------------- the proof: one large real-pixel close-up per read ---------------- */
  function activeBeat(t: number): Beat | null {
    if (!assembled) return null;
    for (const b of beats) if (t >= b.t0 && t < b.t1 + 0.25) return b;
    return null;
  }
  function activeA(t: number) {
    const b = activeBeat(t);
    if (!b) return liveShown ? liveA() : 0;
    return smooth(b.t0, b.t0 + 0.25, t) * (1 - smooth(b.t1, b.t1 + 0.25, t));
  }
  function loupe(g: CanvasRenderingContext2D, A: number, draw: (cx: number, cy: number, R2: number) => void, open: number) {
    const RR = R.proof.w / 2 - 2;
    const cx = Math.round(R.proof.x + R.proof.w / 2);
    const cy = Math.round(R.proof.y + R.proof.h / 2);
    const R2 = RR * open;
    g.save();
    g.globalAlpha = A;
    g.shadowColor = "rgba(20,14,10,0.55)";
    g.shadowBlur = 30 * DPR;
    g.shadowOffsetY = 12 * DPR;
    g.beginPath();
    g.arc(cx, cy, R2, 0, TAU);
    g.fillStyle = COL.room;
    g.fill();
    g.restore();
    g.save();
    g.globalAlpha = A;
    g.beginPath();
    g.arc(cx, cy, R2, 0, TAU);
    g.clip();
    g.imageSmoothingEnabled = false;
    draw(cx, cy, R2);
    g.imageSmoothingEnabled = true;
    g.restore();
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.globalAlpha = A;
    g.lineWidth = 2;
    g.strokeStyle = COL.chalk;
    g.beginPath();
    g.arc(cx, cy, R2, 0, TAU);
    g.stroke();
    g.globalAlpha = 1;
    return { cx, cy, R2 };
  }
  function drawProof(g: CanvasRenderingContext2D, c: Cam, poses: Pose[], t: number, j: number) {
    if (j > 0.3) return;
    const b = activeBeat(t);
    if (!b) return;
    const A = smooth(b.t0, b.t0 + 0.25, t) * (1 - smooth(b.t1, b.t1 + 0.25, t)) * (1 - j / 0.3);
    if (A < 0.01) return;
    const s = seams[b.seam];
    const mover = order[b.step].piece;
    const k = b.lead ? poses[mover].k : 1;
    const [fx, fy] = s.readAt;
    // the read point follows the moving piece until it seats
    const [px, py] = w2s(c, fx, fy);
    const Z = zoomNow() / litScale;
    const open = 0.9 + 0.1 * easeOut(clamp((t - b.t0) / 0.3));
    const RR = R.proof.w / 2 - 2;
    const cx0 = Math.round(R.proof.x + R.proof.w / 2);
    const cy0 = Math.round(R.proof.y + R.proof.h / 2);
    const R2 = RR * open;
    const ang = Math.atan2(py - cy0, px - cx0);
    g.globalAlpha = A;
    g.strokeStyle = COL.violetLt;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(px, py, 10, 0, TAU);
    g.stroke();
    g.beginPath();
    g.moveTo(px - Math.cos(ang) * 10, py - Math.sin(ang) * 10);
    g.lineTo(cx0 + Math.cos(ang) * R2, cy0 + Math.sin(ang) * R2);
    g.stroke();
    g.globalAlpha = 1;
    loupe(
      g,
      A,
      (cx, cy, r2) => {
        g.setTransform(DPR * Z, 0, 0, DPR * Z, DPR * Math.round(cx - fx * Z), DPR * Math.round(cy - fy * Z));
        pieces.forEach((p, i) => {
          const ps = poses[i];
          if (Math.hypot(ps.x - fx, ps.y - fy) < p.r * 1.1 + r2 / Z + 10) drawPiece(g, cuts.get(p.id) ?? null, ps, 1);
        });
      },
      open,
    );
    readingAt(b, s, k, A);
  }

  let rdCache = "";
  function setReading(key: string, word: string, note: string, A: number) {
    if (key !== rdCache) {
      rdCache = key;
      elRdWord.innerHTML = word;
      elRdNote.textContent = note;
    }
    const o = A.toFixed(2);
    if (elRdWord.style.opacity !== o) elRdWord.style.opacity = elRdNote.style.opacity = o;
  }
  function wordHtml(read: { word: string | null; split: [string, string] | null }, gap: number) {
    if (read.split) {
      const [l, r] = read.split;
      return `${esc(l)}<span class="gap" style="width:${gap}px"></span><i class="bar"></i><span class="gap" style="width:${gap}px"></span>${esc(r)}`;
    }
    return read.word ? `<span class="whole-w">${esc(read.word)}</span>` : "";
  }
  const listWords = (ws: string[]) => {
    const q = ws.map((w) => `“${w}”`);
    return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : (q[0] ?? "");
  };
  function readingAt(b: Beat, s: S, k: number, A: number) {
    const r = s.read!;
    const gap = Math.round((1 - clamp(k)) * 22);
    const done = k > 0.85;
    const note = !done ? "Reading across the tear…" : r.split ? "The tear cuts the word. Muse read it across the tear." : `Muse read ${listWords(r.words)} across the tear.`;
    setReading(`${b.n}|${gap}|${done}`, wordHtml(r, gap), note, A);
  }
  function readingIdle() {
    if (rdCache !== "idle") {
      rdCache = "idle";
      elRdWord.innerHTML = "";
      elRdNote.textContent = "";
    }
  }

  /* ---------------- live: each read as Muse makes it, while the pieces wait on the table ---------------- */
  const liveSeen = new Set<string>();
  const liveQ: ReadOut[] = [];
  let liveCur: { read: ReadOut; at: number; img: HTMLImageElement | null } | null = null;
  let liveShown = false;
  const liveTesting = new Set<number>();
  function liveA() {
    if (!liveCur) return 0;
    const age = (performance.now() - liveCur.at) / 1000;
    return smooth(0, 0.25, age) * (1 - smooth(3.2, 3.6, age));
  }
  function pumpLive(t: number) {
    liveShown = false;
    liveTesting.clear();
    if (!input || input.mode !== "live" || assembled || t < T.lift1) {
      if (liveCur && (assembled || input?.mode !== "live")) liveCur = null;
      return;
    }
    const now = performance.now();
    if (liveQ.length && (!liveCur || now - liveCur.at > 1300)) {
      const next = liveQ.length > 2 ? liveQ.splice(0, liveQ.length).at(-1)! : liveQ.shift()!;
      let img: HTMLImageElement | null = null;
      if (next.image) {
        img = new Image();
        img.onload = () => (dirty = true);
        img.src = next.image;
      }
      liveCur = { read: next, at: now, img };
    }
    if (!liveCur) return;
    const A = liveA();
    if (A <= 0.01) return;
    liveShown = true;
    dirty = true;
    for (const id of liveCur.read.pieces) {
      const p = pieces.find((x) => x.id === id);
      if (p) liveTesting.add(p.i);
    }
  }
  function drawLiveRead(g: CanvasRenderingContext2D) {
    if (!liveShown || !liveCur) return;
    const A = liveA();
    const { read, img } = liveCur;
    loupe(
      g,
      A,
      (cx, cy) => {
        if (!img || !img.complete || !img.naturalWidth) return;
        const z = 2;
        // a pair image is centred on the seam; a choice sheet's seam window is its top strip
        const fy = read.kind === "choice" ? Math.min(img.naturalHeight / 2, 75) : img.naturalHeight / 2;
        g.setTransform(DPR * z, 0, 0, DPR * z, DPR * Math.round(cx - (img.naturalWidth / 2) * z), DPR * Math.round(cy - fy * z));
        g.drawImage(img, 0, 0);
      },
      1,
    );
    const tokens = splitWords(read.words);
    const best = [...tokens].sort((a, b) => b.length - a.length)[0] ?? null;
    const split = best ? statedSplit(best, read.reason) : null;
    const positive = read.ok && read.confidence > 0.5 && (read.kind === "pair" ? read.same === true : read.choice !== null);
    const word = best ? wordHtml({ word: best, split }, 0) : "";
    const note = !read.ok ? "Muse didn’t answer this one; the edge will decide." : positive ? `Muse: “${curly(read.reason)}”` : read.confidence <= 0.5 ? "Too little text crosses this tear to tell. The edge will decide." : `Muse: “${curly(read.reason)}”`;
    setReading(`live|${read.id}`, positive ? word : "", note, A);
  }

  /* ---------------- climax: the real paper fills the stage ---------------- */
  function setClimaxText() {
    const cl = scene?.climax;
    if (!cl) {
      clL.textContent = clR.textContent = "";
      clWhy.innerHTML = "";
      clCell.textContent = "";
      return;
    }
    if (cl.split) {
      clL.textContent = cl.split[0];
      clR.textContent = cl.split[1];
      clBar.style.display = "";
    } else {
      clL.textContent = cl.word;
      clR.textContent = "";
      clBar.style.display = "none";
    }
    clWhy.innerHTML = `<span class="cl-src">Muse:</span> “${esc(curly(cl.read.reason))}”`;
    const s = scene!.seams[cl.seam];
    const sh = s.join.shape;
    clCell.textContent = `Pieces ${scene!.pieces[s.a].k} and ${scene!.pieces[s.b].k}: the edges fit along ${Math.round(sh.score)} px, and Muse read across the tear at ${Math.round(cl.read.confidence * 100)}% confidence.${cl.split ? "" : " Muse didn’t say where the tear cuts the word."}`;
  }
  let clCache = "";
  function climaxAt(t: number) {
    const u = t - T.cl0;
    const vis = climaxSeam ? smooth(0.3, 0.6, u) * (1 - smooth(3.0, 3.4, u)) : 0;
    const key = vis.toFixed(3) + "|" + u.toFixed(3);
    if (key === clCache) return;
    clCache = key;
    elCl.style.visibility = vis > 0.005 ? "visible" : "hidden";
    if (vis <= 0.005) return;
    elCl.style.opacity = vis.toFixed(3);
    const seat = spring(t - T.seat);
    const gap = lerp(0.36, 0, clamp(seat, 0, 1.05));
    clL.style.transform = `translateX(${(-gap / 2).toFixed(3)}em)`;
    clR.style.transform = `translateX(${(gap / 2).toFixed(3)}em)`;
    clWhy.style.opacity = smooth(1.75, 2.1, u).toFixed(3);
    clCell.style.opacity = smooth(2.05, 2.4, u).toFixed(3);
  }

  /* ---------------- the torn headline: a real tear profile cuts the setting in two ---------------- */
  let TEAR: number[] = [0, 0.4, -0.3, 0.2, -0.5, 0.1, 0];
  let h1Cache = -1;
  function setHeadline() {
    const withProf = [...seams].filter((s) => s.profA).sort((a, b) => b.len - a.len)[0];
    if (withProf?.profA) {
      const amp = Math.max(...withProf.profA.map(Math.abs)) || 1;
      TEAR = withProf.profA.map((v) => v / amp);
    }
    const cx = phone ? 50 : 37;
    const dev = phone ? 3.2 : 3.4;
    const pts = TEAR.map((v, i) => [cx + v * dev, -4 + (108 * i) / (TEAR.length - 1)]);
    const P = pts.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(",");
    const Rv = pts
      .slice()
      .reverse()
      .map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`)
      .join(",");
    h1L.style.clipPath = `polygon(-10% -10%, ${P}, -10% 110%)`;
    h1R.style.clipPath = `polygon(${pts[0][0].toFixed(2)}% -10%, 110% -10%, 110% 110%, ${Rv})`;
    h1Seam.setAttribute("d", pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(""));
    h1Cache = -1;
  }
  function headlineAt(p: number) {
    const q = Math.round(p * 400) / 400;
    if (q === h1Cache) return;
    h1Cache = q;
    const u = 1 - q;
    // calm, like paper: the right half sits a little low and apart; no tilt
    h1L.style.transform = `translate(${(-0.012 * u).toFixed(4)}em, 0)`;
    h1R.style.transform = `translate(${(0.03 * u).toFixed(4)}em, ${(0.022 * u).toFixed(4)}em)`;
    h1Seam.style.opacity = smooth(0.96, 1, q).toFixed(3);
  }

  /* ---------------- twins: one crisp stage, and it asks ---------------- */
  type TwinsLayout = { w: number; h: number; ms: number; cs: number; L: [number, number]; M: [number, number]; P: Record<"A" | "B" | "C", [number, number]> };
  let TWL: TwinsLayout | null = null;
  let twPick: "A" | "B" | "C" | null = null;
  const tw = elTw
    ? {
        stage: elTw.querySelector<HTMLElement>(".tw-stage")!,
        L: elTw.querySelector<HTMLElement>(".tw-L")!,
        C: { A: elTw.querySelector<HTMLElement>('.tw-c[data-k="A"]')!, B: elTw.querySelector<HTMLElement>('.tw-c[data-k="B"]')!, C: elTw.querySelector<HTMLElement>('.tw-c[data-k="C"]')! },
        rings: [...elTw.querySelectorAll<SVGCircleElement>(".tw-ov .ring")],
        ov: elTw.querySelector<SVGSVGElement>(".tw-ov")!,
        msg: elTw.querySelector<HTMLElement>(".tw-msg")!,
        verdict: elTw.querySelector<HTMLElement>(".tw-verdict")!,
      }
    : null;
  function layoutTwins() {
    const d = input?.twins;
    if (!tw || !d) return;
    const hostW = tw.stage.parentElement!.getBoundingClientRect().width;
    const cw = d.images.A.w;
    const ch = d.images.A.h;
    const lw = d.images.L.w;
    const mw0 = d.slotX + cw;
    if (phone) {
      // the slot on top at near full width; the three scraps fanned below like a hand of cards, edges showing
      const avail = hostW - 24;
      const ms = Math.min(0.86, avail / mw0);
      const cs = Math.min(0.66, (avail + 2 * 70) / (3 * cw));
      const mw = mw0 * ms;
      const ox = (avail - mw) / 2;
      const rowY = ch * ms + 26;
      const step = (avail - cw * cs) / 2;
      TWL = { w: avail, h: rowY + ch * cs + 16, ms, cs, L: [ox, 0], M: [ox + d.slotX * ms, 0], P: { A: [0, rowY + 16], B: [step, rowY + 8], C: [2 * step, rowY] } };
    } else {
      // the scraps carry the screen: as large as the stage allows
      const rowW = 3 * cw + 2 * 24;
      const availH = H - 64 - 56 - 300;
      const sc = Math.max(0.9, Math.min(1.7, (hostW - 140) / rowW, availH / (2 * ch + 40)));
      const mw = mw0 * sc;
      const ox = (rowW * sc - mw) / 2;
      const rowY = ch * sc + 36;
      TWL = { w: rowW * sc, h: rowY + ch * sc, ms: sc, cs: sc, L: [ox, 0], M: [ox + d.slotX * sc, 0], P: { A: [0, rowY], B: [(cw + 24) * sc, rowY], C: [2 * (cw + 24) * sc, rowY] } };
    }
    void lw;
    tw.stage.style.width = TWL.w + "px";
    tw.stage.style.height = TWL.h + "px";
    tw.ov.setAttribute("width", String(TWL.w));
    tw.ov.setAttribute("height", String(TWL.h));
    dirty = true;
  }
  function tries(): ("A" | "B" | "C")[] {
    const truth = input?.twins?.choice ?? "C";
    const all: ("A" | "B" | "C")[] = ["A", "B", "C"];
    if (twPick) return twPick === truth ? [truth] : [twPick, truth];
    return [...all.filter((k) => k !== truth), truth];
  }
  function twinsAt(t: number) {
    const d = input?.twins;
    if (!tw || !elTw || !d || !TWL) return;
    const vis = twinsVis(t);
    elTw.style.opacity = vis.toFixed(3);
    elTw.style.visibility = vis > 0.01 ? "visible" : "hidden";
    if (vis <= 0.01) {
      if (twPick && t < T.tw0 - 1) twPick = null;
      return;
    }
    const truth = d.choice;
    const u = t - T.tw0;
    const put = (el: HTMLElement, x: number, y: number, sc: number, o = 1) => {
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${sc.toFixed(4)})`;
      el.style.opacity = String(o);
    };
    put(tw.L, TWL.L[0], TWL.L[1], TWL.ms);
    const list = tries();
    const vU = TW.try0 + list.length * TW.tryDur + 0.1;
    const asking = u >= TW.ask && u < TW.try0;
    let ringA = 0;
    let msg = "";
    (["A", "B", "C"] as const).forEach((k, zi) => {
      const [px, py] = TWL!.P[k];
      const ti = list.indexOf(k);
      const el = tw.C[k];
      let x = px;
      let y = py;
      let sc = TWL!.cs;
      let o = smooth(0.1 + zi * 0.12, 0.45 + zi * 0.12, u);
      let strike = 0;
      let z = zi + 1;
      let no = false;
      let yes = false;
      if (ti >= 0) {
        const st = TW.try0 + ti * TW.tryDur;
        const inU = easeIO(clamp((u - st) / 0.45));
        const outU = k === truth ? 0 : easeIO(clamp((u - st - 1.05) / 0.35));
        x = lerp(lerp(px, TWL!.M[0], inU), px, outU);
        y = lerp(lerp(py, TWL!.M[1], inU), py, outU) - Math.sin(Math.PI * inU) * 24 * (1 - outU);
        sc = lerp(lerp(TWL!.cs, TWL!.ms, inU), TWL!.cs, outU);
        if (inU > 0 && outU < 1) z = 6;
        if (k !== truth) {
          strike = clamp((u - st - 0.55) / 0.25);
          no = u > st + 0.55;
          if (outU > 0) o = lerp(1, 0.5, outU);
        } else {
          yes = u > st + 0.5;
          ringA = smooth(st + 0.45, st + 0.7, u);
        }
        if (u >= st && u < st + TW.tryDur)
          msg = k === truth ? (u > st + 0.5 ? (twPick === truth ? `Yes: ${truth}. The letters join into words.` : `${truth}: the letters join into words.`) : `Trying ${k}…`) : u > st + 0.55 ? (twPick === k ? `Not ${k}: the letters don’t join.` : `${k}: the letters don’t join.`) : `Trying ${k}…`;
      } else if (k !== truth && u > vU) {
        strike = clamp((u - vU) / 0.25);
        no = true;
        o = 0.5;
      }
      put(el, x, y, sc, o);
      el.style.zIndex = String(z);
      const sk = el.querySelector<SVGPathElement>(".strike");
      if (sk) sk.style.strokeDashoffset = (150 * (1 - strike)).toFixed(1);
      el.classList.toggle("no", no);
      el.classList.toggle("yes", yes);
      el.classList.toggle("ask", asking);
      el.tabIndex = asking ? 0 : -1;
      el.setAttribute("aria-disabled", asking ? "false" : "true");
    });
    if (asking) msg = phone ? "Tap the scrap you think belongs." : "Pick the scrap you think belongs.";
    if (u < TW.ask || u > vU) msg = "";
    if (tw.msg.textContent !== msg) tw.msg.textContent = msg;
    tw.rings.forEach((r, i) => {
      const rp = d.rings[i];
      if (!rp) return;
      r.setAttribute("cx", String(TWL!.L[0] + rp[0] * TWL!.ms));
      r.setAttribute("cy", String(TWL!.L[1] + rp[1] * TWL!.ms));
      r.setAttribute("r", String(17 * TWL!.ms));
      r.style.opacity = String(ringA);
    });
    tw.verdict.style.opacity = smooth(vU, vU + 0.35, u).toFixed(3);
  }
  const onTwinClick = (e: Event) => {
    const el = (e.target as Element).closest<HTMLElement>(".tw-c");
    if (!el) return;
    const k = el.dataset.k as "A" | "B" | "C";
    const u = t - T.tw0;
    if (u < TW.ask || u >= TW.try0) return;
    twPick = k;
    t = T.tw0 + TW.try0 - 0.05;
    dirty = true;
    if (!playing) setPlaying(true);
  };
  elTw?.addEventListener("click", onTwinClick);

  /* ---------------- transcript + one status line ---------------- */
  let lastChars = -1;
  function setTranscript(text: string | null) {
    TEXT = text ?? "";
    TEXT_LINES = TEXT.split("\n").filter((l) => l.trim()).length;
    const hero = TEXT.split(/\n\s*\n/)
      .map((par) => {
        const ls = par.split("\n");
        if (!ls.some((l) => l.length > 45)) return par.replace(/\n/g, " ");
        return ls.reduce((acc, l) => (!acc ? l.trim() : /[a-z]-$/.test(acc) && !/--$/.test(acc) ? acc.slice(0, -1) + l.trim() : acc + " " + l.trim()), "");
      })
      .join("\n");
    const m = hero.search(/\b(My )?[Dd]ear\b/);
    TEXT_START = m >= 0 ? hero.slice(m) : hero;
    lastChars = -1;
    if (elTxMore) elTxMore.textContent = TEXT_LINES ? `Read all ${TEXT_LINES} lines` : "";
  }
  function transcriptAt(t: number) {
    const vis = TEXT ? smooth(T.tx0 - 0.1, T.tx0 + 0.25, t) * (input?.mode === "recorded" ? 1 - smooth(T.loop - 0.7, T.loop - 0.1, t) : 1) : 0;
    elTx.style.opacity = vis.toFixed(3);
    elTx.style.visibility = vis > 0.01 ? "visible" : "hidden";
    elIntro.style.opacity = (1 - vis).toFixed(3);
    elIntro.style.visibility = vis > 0.99 ? "hidden" : "visible";
    const u = clamp((t - T.tx0) / (T.tx1 - T.tx0));
    const n = Math.round(TEXT_START.length * u);
    if (n !== lastChars) {
      lastChars = n;
      txNode.nodeValue = TEXT_START.slice(0, n);
      caret.style.display = n > 0 && n < TEXT_START.length ? "" : "none";
    }
  }
  let stCache = "";
  function statusAt(t: number) {
    const inp = input;
    if (!inp) return;
    let s = "";
    const n = pieces.length;
    const live = inp.mode === "live";
    if (live && !n) s = inp.progress.failed ? "" : "SAM 3.1 is finding the pieces…";
    else if (live && !assembled) s = inp.progress.failed ? `SAM 3.1 cut out <b>${n}</b> pieces.` : inp.progress.stage === "read" || inp.reads.length ? `Muse is reading across the tears: <b>${inp.reads.length}</b> of ${inp.progress.asks || "…"}` : inp.progress.stage === "assemble" ? `Assembling ${n} pieces…` : `SAM 3.1 cut out <b>${n}</b> pieces. Matching the edges…`;
    else if (!assembled) s = n ? `SAM 3.1 cut out <b>${n}</b> pieces` : "";
    else if (t < T.exp0) s = `SAM 3.1 cut out <b>${pieces.filter((_, i) => t >= T.trace0 + i * T.traceStag + T.traceDur).length}</b> of ${n} pieces`;
    else if (t < T.asmEnd) {
      const home = order.filter((o, i) => t >= (i === LAST && climaxSeam ? T.seat : T.stepT[i]) + T.fly * 0.62).length;
      const reads = beats.filter((b) => t >= b.t0 + 0.6).length + (climaxSeam && t >= T.seat + 0.6 ? 1 : 0);
      s = `<b>${home}</b> of ${order.length} pieces home, <b>${Math.min(reads, scene?.reads ?? 0)}</b> of ${scene?.reads ?? 0} tears read`;
    } else {
      const placed = order.length;
      s = `Whole: ${placed} piece${placed === 1 ? "" : "s"}${n > placed ? ` (${n - placed} left unplaced)` : ""}, ${scene?.reads ?? 0} tear${scene?.reads === 1 ? "" : "s"} read`;
      if (live && !inp.transcript && !inp.progress.done) s += ". Muse is reading the page…";
    }
    if (s !== stCache) {
      stCache = s;
      elStatus.innerHTML = s;
    }
  }

  /* ---------------- clock, gates, controls ---------------- */
  let t = 0;
  let playing = !reduced;
  let dirty = true;
  let last = performance.now();
  let jAmt = 0;
  let jTarget = 0;
  let heroVisible = true;
  let raf = 0;

  /** How far the clock may run on what has arrived so far. */
  function gate(): number {
    if (!input?.photo || !(photoOk || (placeholder?.complete && placeholder.naturalWidth))) return 0;
    if (!pieces.length) return T.trace0 - 0.01;
    if (!cutsReady) return T.lift0;
    if (!assembled) return input.mode === "live" ? HOLD : T.exp0;
    if (!input.transcript && !input.progress.done) return T.whole + 0.6;
    if (!input.transcript) return T.whole + 0.6;
    return Infinity;
  }
  function stopAt(): number {
    // the finished still: the end, as far as the run has got
    return Math.min(T.end, gate());
  }

  function setPlaying(p: boolean) {
    playing = p;
    root.classList.toggle("paused", !p);
    btnPlay.setAttribute("aria-label", p ? "Pause (space)" : "Play (space)");
    if (p) {
      setJ(0);
      last = performance.now();
    }
    dirty = true;
  }
  function setJ(v: number) {
    jTarget = v;
    btnJ.setAttribute("aria-pressed", v ? "true" : "false");
    if (reduced) jAmt = v;
    dirty = true;
  }
  let stepped = false;
  function step(dir: number) {
    if (!assembled) return;
    stepped = true;
    setPlaying(false);
    setJ(0);
    if (dir > 0) {
      const n = STOPS.find((s) => s > t + 0.02);
      t = n === undefined ? 0 : n + 0.001;
    } else {
      const p = [...STOPS].reverse().find((s) => s < t - 0.3);
      t = p === undefined ? T.end : p + 0.001;
    }
    if (T.stepT.some((s) => Math.abs(s + 0.001 - t) < 0.002)) t += T.fly;
    else if (Math.abs(t - T.tw0 - 0.001) < 0.002 && twinsVis(T.tw0 + 1) > 0) t = T.tw0 + TW.try0 + 3 * TW.tryDur + 0.8;
    else if (Math.abs(t - T.tx0 - 0.001) < 0.002) t = T.end;
    else if (Math.abs(t - T.trace0 - 0.001) < 0.002) t = T.trace0 + 1.0;
    t = Math.min(t, gate());
    dirty = true;
  }
  function toggleHeroJ() {
    if (!assembled) return;
    if (jTarget) {
      setJ(0);
      return;
    }
    if (t < T.whole + 0.6 || t > T.loop - 1) t = Math.min(T.end, gate());
    if (twinsVis(t) > 0) t = Math.min(T.end, gate());
    setPlaying(false);
    setJ(1);
  }
  const onPrev = () => step(-1);
  const onNext = () => step(1);
  const onPlay = () => {
    if (!playing && t >= Math.min(T.loop, stopAt()) - 0.01 && input?.mode === "recorded") t = 0;
    setPlaying(!playing);
  };
  $(".btn-prev").addEventListener("click", onPrev);
  $(".btn-next").addEventListener("click", onNext);
  btnPlay.addEventListener("click", onPlay);
  btnJ.addEventListener("click", toggleHeroJ);
  const onKey = (e: KeyboardEvent) => {
    const tg = e.target as Element | null;
    if (tg?.closest?.("input,textarea,select")) return;
    if (e.metaKey || e.ctrlKey || e.altKey || !heroVisible) return;
    const k = e.key;
    const rr = document.querySelector(".result")?.getBoundingClientRect();
    const resultInView = rr && rr.top < innerHeight * 0.5 && rr.bottom > innerHeight * 0.3;
    if ((k === "j" || k === "J") && !resultInView) {
      toggleHeroJ();
      e.preventDefault();
    } else if (k === "ArrowRight" || k === "ArrowLeft") {
      if (resultInView) return;
      step(k === "ArrowRight" ? 1 : -1);
      e.preventDefault();
    } else if (k === " " && !tg?.closest?.("button,a,[tabindex]")) {
      if (resultInView) return;
      onPlay();
      e.preventDefault();
    }
  };
  addEventListener("keydown", onKey);

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const g = gate();
    if (playing && heroVisible) {
      if (t < g) {
        t = Math.min(t + dt, g);
        dirty = true;
      }
      if (input?.mode === "recorded" && t >= T.loop) {
        t = 0;
        twPick = null;
      }
      if (input?.mode !== "recorded" && t >= T.end) t = T.end;
    } else if (!playing && t > g) t = g;
    // reduced motion: the finished still, as far as the run has got (until the visitor steps through it)
    if (reduced && !stepped) {
      const st = stopAt();
      if (t !== st) {
        t = st;
        dirty = true;
      }
    }
    if (Math.abs(jAmt - jTarget) > 0.001) {
      jAmt += (jTarget - jAmt) * (1 - Math.exp(-dt * 7));
      if (Math.abs(jAmt - jTarget) < 0.002) jAmt = jTarget;
      dirty = true;
    }
    pumpLive(t);
    findReadPoints();
    if (dirty && heroVisible) {
      dirty = false;
      const j = easeIO(jAmt);
      drawHero(t, j);
      if (!activeBeat(t) && !liveShown) readingIdle();
      else if (j > 0.3) readingIdle();
      climaxAt(j > 0.01 ? -10 : t);
      twinsAt(j > 0.01 ? -10 : t);
      transcriptAt(t);
      if (climaxZoom(t) > 0.05) {
        elRdWord.style.opacity = elRdNote.style.opacity = "0";
        rdCache = "cl";
      }
      statusAt(t);
      headlineAt(reduced ? 1 : homeFrac(t));
      const back = Math.max(climaxZoom(t), twinsVis(t)) * (jAmt > 0.01 ? 0 : 1);
      const lo = (1 - back * (phone ? 0 : 1)).toFixed(3);
      if (elLead.style.opacity !== lo) {
        elLead.style.opacity = lo;
        elLead.style.visibility = +lo < 0.01 ? "hidden" : "visible";
      }
      root.dataset.phase = !pieces.length ? "photo" : !assembled ? (t >= T.lift1 ? "reading" : "outlined") : t < T.asmEnd ? "assembling" : "whole";
    }
  }

  let rz = 0;
  const onResize = () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(layout);
  };
  addEventListener("resize", onResize);
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        heroVisible = e.isIntersecting;
        dirty = true;
        last = performance.now();
      }),
    { threshold: 0.02 },
  );
  io.observe(root);
  document.fonts?.ready.then(() => {
    fonts = readFonts(root);
    layout();
  });
  if (!playing) root.classList.add("paused");

  /** The full-resolution photo waits until the page has loaded (the stage shows the server-rendered photo meanwhile). */
  let photoWant = "";
  function loadPhoto(src: string) {
    photoWant = src;
    const go = () => {
      if (photoWant === src) photo.src = src;
    };
    if (document.readyState === "complete" || !placeholder) go();
    else
      addEventListener(
        "load",
        () => {
          const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
          if (ric) ric(go, { timeout: 600 });
          else setTimeout(go, 50);
        },
        { once: true },
      );
  }

  function update(next: EngineInput) {
    const prev = input;
    input = next;
    const newRun = !prev || prev.key !== next.key;
    if (newRun) {
      t = 0;
      rewound = false;
      stepped = false;
      twPick = null;
      liveSeen.clear();
      liveQ.length = 0;
      liveCur = null;
      scene = null;
      pieces = [];
      seams = [];
      assembled = false;
      cutKey = "";
      cutsReady = false;
      cuts = new Map();
      setJ(0);
      if (!reduced) setPlaying(true);
    }
    if (next.photo && (newRun || prev?.photo?.src !== next.photo.src)) {
      if (photo.src !== new URL(next.photo.src, location.href).href) {
        photoOk = false;
        loadPhoto(next.photo.src);
      }
    }
    const piecesChanged = newRun || prev?.pieces !== next.pieces || prev?.pages !== next.pages || prev?.joins !== next.joins;
    if (piecesChanged && next.photo && next.pieces.length) {
      setScene(buildScene({ photo: { width: next.photo.width, height: next.photo.height }, pieces: next.pieces, pages: next.pages, joins: next.joins, reads: next.reads }));
      startCutouts();
    } else if (newRun || prev?.twins !== next.twins) computeT();
    if (newRun || prev?.transcript !== next.transcript) setTranscript(next.transcript);
    for (const r of next.reads)
      if (!liveSeen.has(r.id)) {
        liveSeen.add(r.id);
        if (next.mode === "live" && !assembled) liveQ.push(r);
      }
    root.classList.toggle("is-live", next.mode === "live");
    if (reduced) t = stopAt();
    layout();
    dirty = true;
  }

  function setReduced(r: boolean) {
    reduced = r;
    if (r) {
      setPlaying(false);
      t = stopAt();
    }
    dirty = true;
  }

  (window as unknown as { untorn?: unknown }).untorn = {
    T,
    TW,
    seek: (v: number) => {
      t = Math.min(v, gate());
      setPlaying(false);
      dirty = true;
    },
    play: () => setPlaying(true),
    J: (v: number) => setJ(v),
    pick: (k: "A" | "B" | "C") => {
      twPick = k;
      dirty = true;
    },
    beats: () => beats.map((b) => ({ t0: b.t0, t1: b.t1, seam: seams[b.seam]?.join.candidate, lead: b.lead })),
    state: () => ({ t, gate: gate(), cutsReady, assembled, climax: scene?.climax ? { word: scene.climax.word, split: scene.climax.split, seam: scene.seams[scene.climax.seam].join.candidate } : null }),
  };

  raf = requestAnimationFrame(frame);
  return {
    update,
    setReduced,
    destroy() {
      cancelAnimationFrame(raf);
      cutSignal.cancelled = true;
      removeEventListener("keydown", onKey);
      removeEventListener("resize", onResize);
      io.disconnect();
      elTw?.removeEventListener("click", onTwinClick);
      $(".btn-prev").removeEventListener("click", onPrev);
      $(".btn-next").removeEventListener("click", onNext);
      btnPlay.removeEventListener("click", onPlay);
      btnJ.removeEventListener("click", toggleHeroJ);
    },
  };
}
