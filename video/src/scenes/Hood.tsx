// 1:21 Under the hood, built from the recorded run's own data, one stage after another along a single camera move:
// 1. real photo pixels at x12 with the outline the solver traced from SAM 3.1's mask (it runs between pixel centres);
// 2. the two edge traces of one seam sliding into a fit, worded as the app's join map words it;
// 3. the exact image Muse Spark read across that seam, and its answer;
// 4. twins: identical edges, so two reads must agree, or the piece is set aside, not forced;
// 5. the page with both clues on every seam.

import React, { useCallback } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import cutMeta from "../data/cutouts-fdr.json";
import scene from "../data/scene-fdr-1927.json";
import { FrameCanvas, grain, type DrawFn } from "../lib/canvas";
import { useImages } from "../lib/images";
import { clamp, easeIO, easeOut, lerp, noise1, smooth, smoother, soft } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type HoodCues = { s1: number; s2: number; s3: number; s4: number; s5: number; end: number };
export const HOOD_CUES: HoodCues = { s1: 0.2, s2: 4.6, s3: 8.4, s4: 12.4, s5: 16.2, end: 20.0 };

type SP = (typeof scene.pieces)[number];
const pieces = scene.pieces as SP[];
const SEAM = scene.seams.find((s) => s.read?.words?.includes("Patients'"))!; // p7~p9: "here, week and Patients'"
const PA = pieces[SEAM.a];
// a stretch of p7's torn edge, in the photo, for the pixel close-up
const ZOOM = 16;
const WIN = { w: 80, h: 44 };
const edgePt = (() => {
  // the outline point of p7 closest to the seam's midpoint, carried back into the photo
  const [mx, my] = SEAM.mid;
  const dx = mx - PA.home[0];
  const dy = my - PA.home[1];
  const c = Math.cos(-PA.ang);
  const s = Math.sin(-PA.ang);
  const px = PA.c[0] + c * dx - s * dy;
  const py = PA.c[1] + s * dx + c * dy;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < PA.poly.length; i += 2) {
    const d = Math.hypot(PA.c[0] + PA.poly[i] - px, PA.c[1] + PA.poly[i + 1] - py);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return [Math.round(PA.c[0] + PA.poly[best]), Math.round(PA.c[1] + PA.poly[best + 1])];
})();

const paths = ["kit/fdr/photo.jpg", "fx/grain.png"];

export const Hood: React.FC<{ cues?: HoodCues }> = ({ cues = HOOD_CUES }) => {
  const imgs = useImages(paths);
  const t = useCurrentFrame() / FPS;
  // the camera dolly: each stage slides in from the right as the last leaves
  const stage = (k: number) => {
    const starts = [cues.s1, cues.s2, cues.s3, cues.s4, cues.s5, cues.end + 1];
    const a = smoother(starts[k] - 0.5, starts[k] + 0.35, t);
    const b = smoother(starts[k + 1] - 0.5, starts[k + 1] + 0.35, t);
    return { x: (1 - a) * 260 - b * 260, o: a * (1 - b) };
  };

  const draw = useCallback<DrawFn>(
    (g, tt, frame) => {
      if (!imgs) return;
      g.fillStyle = C.room;
      g.fillRect(0, 0, W, H);
      const st = stage(0);
      if (st.o > 0.005) {
        // real pixels at x12, nearest neighbour, and the traced outline over them
        const ox = Math.round(W / 2 - (WIN.w * ZOOM) / 2 + st.x);
        const oy = 214;
        g.save();
        g.globalAlpha = st.o;
        g.imageSmoothingEnabled = false;
        const sx = edgePt[0] - WIN.w / 2;
        const sy = edgePt[1] - WIN.h / 2;
        g.drawImage(imgs["kit/fdr/photo.jpg"], sx, sy, WIN.w, WIN.h, ox, oy, WIN.w * ZOOM, WIN.h * ZOOM);
        g.imageSmoothingEnabled = true;
        // pixel grid, faint
        g.strokeStyle = "rgba(42,46,52,0.12)";
        g.lineWidth = 1;
        for (let i = 0; i <= WIN.w; i++) {
          g.beginPath();
          g.moveTo(ox + i * ZOOM + 0.5, oy);
          g.lineTo(ox + i * ZOOM + 0.5, oy + WIN.h * ZOOM);
          g.stroke();
        }
        for (let j = 0; j <= WIN.h; j++) {
          g.beginPath();
          g.moveTo(ox, oy + j * ZOOM + 0.5);
          g.lineTo(ox + WIN.w * ZOOM, oy + j * ZOOM + 0.5);
          g.stroke();
        }
        // the outline (photo px -> screen), drawn on progressively
        const draw1 = clamp((tt - cues.s1 - 0.4) / 1.6);
        g.beginPath();
        g.rect(ox, oy, WIN.w * ZOOM, WIN.h * ZOOM);
        g.clip();
        const pts: [number, number][] = [];
        for (let i = 0; i < PA.poly.length; i += 2) {
          const x = PA.c[0] + PA.poly[i];
          const y = PA.c[1] + PA.poly[i + 1];
          if (x > sx - 2 && x < sx + WIN.w + 2 && y > sy - 2 && y < sy + WIN.h + 2) pts.push([ox + (x - sx) * ZOOM, oy + (y - sy) * ZOOM]);
        }
        const n = Math.max(2, Math.round(pts.length * draw1));
        g.lineJoin = "round";
        g.lineCap = "round";
        for (const [col, wdt] of [
          ["rgba(250,246,238,0.9)", 7],
          [C.ink, 3],
        ] as const) {
          g.strokeStyle = col;
          g.lineWidth = wdt;
          g.beginPath();
          pts.slice(0, n).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
        g.fillStyle = C.ink;
        pts.slice(0, n).forEach(([x, y]) => {
          g.beginPath();
          g.arc(x, y, 3.2, 0, Math.PI * 2);
          g.fill();
        });
        g.restore();
      }
      grain(g, imgs["fx/grain.png"], frame, 0.07);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imgs, cues],
  );

  // stage 2: the edge traces (96 samples each), sliding together until they lie as one
  const s2 = stage(1);
  const fitK = easeIO(clamp((t - cues.s2 - 0.6) / 1.6));
  const prof = (p: number[], dy: number, sign: number) => p.map((v, i) => `${i ? "L" : "M"}${(i / (p.length - 1)) * 1100} ${dy + sign * v * 2.6}`).join("");
  const A = SEAM.profA as number[];
  const B = SEAM.profB as number[];
  const sum = A.map((v, i) => v + B[i]);
  // stage 3: the image Muse read, and its answer
  const s3 = stage(2);
  const ans = clamp((t - cues.s3 - 0.9) / 1.4);
  // stage 4: twins and the tray
  const s4 = stage(3);
  const s5 = stage(4);
  const label = (txt: React.ReactNode, o: number, x: number) => (
    <div style={{ position: "absolute", left: 0, right: 0, top: 96, textAlign: "center", transform: `translateX(${x * 0.6}px)`, opacity: o, fontFamily: F.serif, fontWeight: 500, fontSize: 46, color: C.chalk }}>{txt}</div>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <FrameCanvas draw={draw} ready={!!imgs} />
      {label(
        <>
          SAM 3.1's mask, traced <span style={{ color: C.chalk2 }}>to a fraction of a pixel</span>
        </>,
        stage(0).o,
        stage(0).x,
      )}
      {stage(0).o > 0.01 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 176, textAlign: "center", opacity: stage(0).o, fontFamily: F.sans, fontSize: 21, color: C.chalk3 }}>
          Real pixels of the 1927 letter at ×16. The line is the outline the solver traced from the mask: it runs between pixel centres.
        </div>
      )}
      {s2.o > 0.01 && (
        <div style={{ position: "absolute", left: 360 + s2.x, top: 250, width: 1200, height: 560, opacity: s2.o }}>
          <svg width={1200} height={560} viewBox="0 0 1100 520" style={{ overflow: "visible" }}>
            <path d={prof(A, lerp(90, 210, fitK), 1)} fill="none" stroke={C.chalk} strokeWidth={3} />
            <path d={prof(B, lerp(330, 210, fitK), -1)} fill="none" stroke={C.chalk2} strokeWidth={3} />
            <line x1={0} y1={430} x2={1100} y2={430} stroke={C.chalkHair2} strokeWidth={1} opacity={smooth(0.85, 1, fitK)} />
            <path d={prof(sum, 430, 1)} fill="none" stroke={C.chalk3} strokeWidth={2.2} opacity={smooth(0.85, 1, fitK)} />
          </svg>
          <div style={{ position: "absolute", left: -150, top: lerp(70, 205, fitK), fontFamily: F.sans, fontWeight: 600, fontSize: 21, color: C.chalk }}>edge A</div>
          <div style={{ position: "absolute", left: -150, top: lerp(335, 230, fitK), fontFamily: F.sans, fontWeight: 600, fontSize: 21, color: C.chalk2, opacity: 1 - smooth(0.8, 1, fitK) }}>edge B</div>
          <div style={{ position: "absolute", left: -150, top: 455, fontFamily: F.sans, fontWeight: 600, fontSize: 21, color: C.chalk3, opacity: smooth(0.85, 1, fitK) }}>A + B</div>
          <div style={{ position: "absolute", left: 0, top: 500, fontFamily: F.sans, fontSize: 20, color: C.chalk3, opacity: smooth(0.85, 1, fitK) }}>
            Each torn edge, traced from its own piece's mask. Where two pieces belong together, the traces mirror and cancel.
          </div>
        </div>
      )}
      {label(
        <>
          Shape proposes the join: <span style={{ color: C.chalk2 }}>fits along {Math.round(SEAM.shape.score)} px, {SEAM.shape.rms.toFixed(2)} px misfit</span>
        </>,
        s2.o,
        s2.x,
      )}
      {s3.o > 0.01 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 250, display: "flex", flexDirection: "column", alignItems: "center", opacity: s3.o, transform: `translateX(${s3.x}px)` }}>
          <Img src={staticFile("kit/fdr/seam-pair_p7_p9_0.jpg")} style={{ width: 840, height: 300, imageRendering: "pixelated", boxShadow: "0 14px 30px rgba(18,12,8,0.5)" }} />
          <div style={{ marginTop: 26, width: 900, fontFamily: F.mono, fontSize: 24, lineHeight: 1.55, color: C.chalk2, opacity: ans > 0 ? 1 : 0 }}>
            <div>
              same place: <span style={{ color: C.violetLt }}>yes</span> · confidence 0.95
            </div>
            <div>
              words across: <span style={{ color: C.violetLt }}>{(SEAM.read!.words as string[]).slice(0, Math.ceil(3 * clamp(ans * 2))).join(" · ")}</span>
            </div>
            <div style={{ color: C.chalk3, opacity: smooth(0.5, 1, ans) }}>“{SEAM.read!.reason}”</div>
          </div>
        </div>
      )}
      {label(
        <>
          Muse Spark reads across the seam
        </>,
        s3.o,
        s3.x,
      )}
      {s4.o > 0.01 && <TwinsTray t={t - cues.s4} o={s4.o} x={s4.x} />}
      {label(
        <>
          Shape can't decide? <span style={{ color: C.chalk2 }}>Two reads must agree, or it's set aside.</span>
        </>,
        s4.o,
        s4.x,
      )}
      {s5.o > 0.01 && <BothClues t={t - cues.s5} o={s5.o} x={s5.x} />}
      {label(<>Never a forced fit</>, s5.o, s5.x)}
    </AbsoluteFill>
  );
};

/** Three identical scraps: the shape can't choose. Placed only when two reads agree; otherwise set aside, not forced. */
const TwinsTray: React.FC<{ t: number; o: number; x: number }> = ({ t, o, x }) => {
  const tray = easeIO(clamp((t - 1.9) / 1.0));
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 250, height: 560, opacity: o, transform: `translateX(${x}px)` }}>
      <div style={{ position: "absolute", left: 250, top: 30, display: "flex", gap: 40 }}>
        {["A", "B", "C"].map((k, i) => (
          <div key={k} style={{ position: "relative", width: 340, height: 192, transform: i === 1 ? `translate(${tray * 380}px, ${tray * 300}px) rotate(${tray * -4}deg) scale(${1 - 0.18 * tray})` : undefined }}>
            <Img src={staticFile(`kit/twins-sheet/twin-${k}.webp`)} style={{ width: 340, height: 192, objectFit: "contain", filter: "drop-shadow(0 8px 14px rgba(18,12,8,0.45))" }} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 250, top: 262, width: 640, fontFamily: F.serif, fontWeight: 500, fontSize: 30, lineHeight: 1.35, color: C.chalk2, opacity: smooth(0.5, 1.0, t) }}>
        Placed only when two reads agree on the same scrap.
      </div>
      <div style={{ position: "absolute", left: 980, top: 300, width: 600, height: 230, border: `1.5px dashed ${C.chalkHair2}`, borderRadius: 6, opacity: smooth(1.5, 1.9, t) }}>
        <div style={{ position: "absolute", left: 20, top: 188, fontFamily: F.sans, fontSize: 20, color: C.chalk3 }}>Set aside, not forced. In the stack run: 6 of 24.</div>
      </div>
    </div>
  );
};

/** The rebuilt page with the run's own seams: violet where Muse confirmed one by reading, graphite where the edge alone decided. */
const PAGE = scene.pages[0];
const BothClues: React.FC<{ t: number; o: number; x: number }> = ({ t, o, x }) => {
  const k = soft(t, 4);
  const hgt = 760;
  const sc = hgt / (PAGE.height + 16);
  const wdt = (PAGE.width + 16) * sc;
  const toImg = (wx: number, wy: number) => [(wx - PAGE.origin[0] + 8) * sc, (wy - PAGE.origin[1] + 8) * sc];
  const draw = clamp(t / 1.6);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 210, display: "flex", justifyContent: "center", opacity: o, transform: `translateX(${x}px) translateY(${(1 - k) * 20}px)` }}>
      <div style={{ display: "flex", gap: 56, alignItems: "center" }}>
        <div style={{ position: "relative", width: wdt, height: hgt }}>
          <Img src={staticFile("kit/proof/fdr-page.png")} style={{ width: wdt, height: hgt, filter: "drop-shadow(0 16px 32px rgba(18,12,8,0.55))" }} />
          <svg width={wdt} height={hgt} style={{ position: "absolute", left: 0, top: 0 }}>
            {scene.seams.map((sm, i) => {
              if (!sm.line.length) return null;
              const pts: string[] = [];
              for (let j = 0; j < sm.line.length; j += 2) {
                const [px, py] = toImg(sm.line[j], sm.line[j + 1]);
                pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
              }
              return <polyline key={i} points={pts.join(" ")} fill="none" stroke={sm.read ? C.violet : C.ink} strokeWidth={sm.read ? 2.4 : 1.6} strokeOpacity={sm.read ? 0.95 : 0.55} pathLength={100} strokeDasharray="100" strokeDashoffset={100 * (1 - draw)} />;
            })}
          </svg>
        </div>
        <div style={{ width: 560, fontFamily: F.serif, fontWeight: 500, fontSize: 34, lineHeight: 1.35, color: C.chalk }}>
          <div>
            <span style={{ display: "inline-block", width: 46, height: 3, background: C.violetLt, verticalAlign: "middle", marginRight: 16 }} />
            {scene.reads} seams confirmed by reading
          </div>
          <div style={{ marginTop: 18 }}>
            <span style={{ display: "inline-block", width: 46, height: 2, background: C.chalk3, verticalAlign: "middle", marginRight: 16 }} />
            {scene.seams.length - scene.reads} placed by the edge alone
          </div>
          <div style={{ marginTop: 34, fontFamily: F.sans, fontSize: 22, lineHeight: 1.4, color: C.chalk3 }}>The app's join map shows both clues for every seam, with the exact image Muse read.</div>
        </div>
      </div>
    </div>
  );
};
void noise1;
void easeOut;
void cutMeta;
