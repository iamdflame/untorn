// 1:25 Under the hood: fewer words, bigger pictures, all from the recorded runs' own data.
// 1. The outline the solver traced from SAM 3.1's mask, drawing on over the letter's real pixels at x20.
// 2. The two edge traces of one seam, thick and large, sliding together until they mirror (the join map's own
//    numbers: "fits along 1063 px, 0.82 px misfit").
// 3. The exact image Muse Spark read across that seam, at x4, with the words it read set large in violet.
// 4. Three scraps with one edge; two reads must agree; and a scrap the stack run really set aside (p4,
//    "twin-unresolved") going down onto the tray: never forced.

import React, { useCallback } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import scene from "../data/scene-fdr-1927.json";
import { FrameCanvas, grain, type DrawFn } from "../lib/canvas";
import { useImages } from "../lib/images";
import { clamp, easeIO, easeOut, lerp, noise1, smooth, smoother, soft, spring, settle } from "../lib/motion";
import { C, F, FPS, H, W } from "../theme";

export type HoodCues = { s1: number; s2: number; s3: number; s4: number; s5: number; end: number };
export const HOOD_CUES: HoodCues = { s1: 0.2, s2: 4.6, s3: 8.4, s4: 11.2, s5: 16.2, end: 18.4 };

type SP = (typeof scene.pieces)[number];
const pieces = scene.pieces as SP[];
const SEAM = scene.seams.find((s) => s.read?.words?.includes("Patients'"))!; // p7~p9: "here, week and Patients'"
const PA = pieces[SEAM.a];

// stage 1: a stretch of p7's torn edge in the photo, at x20, filling the frame
const ZOOM = 20;
const WIN = { w: 96, h: 40 };
const edgePt = (() => {
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
  // a stage's slide and opacity at time tt (the canvas passes its own frame time)
  const stageAt = (k: number, tt: number) => {
    const starts = [cues.s1, cues.s2, cues.s3, cues.s4, cues.end + 5];
    const a = smoother(starts[k] - 0.45, starts[k] + 0.3, tt);
    const b = smoother(starts[k + 1] - 0.45, starts[k + 1] + 0.3, tt);
    return { x: (1 - a) * 220 - b * 220, o: a * (1 - b) };
  };
  const stage = (k: number) => stageAt(k, t);

  const draw = useCallback<DrawFn>(
    (g, tt, frame) => {
      if (!imgs) return;
      g.fillStyle = C.room;
      g.fillRect(0, 0, W, H);
      const st = stageAt(0, tt);
      if (st.o > 0.005) {
        const ox = Math.round((W - WIN.w * ZOOM) / 2 + st.x);
        const oy = 96;
        const sx = edgePt[0] - WIN.w / 2;
        const sy = edgePt[1] - WIN.h / 2;
        g.save();
        g.globalAlpha = st.o;
        g.imageSmoothingEnabled = false;
        g.drawImage(imgs["kit/fdr/photo.jpg"], sx, sy, WIN.w, WIN.h, ox, oy, WIN.w * ZOOM, WIN.h * ZOOM);
        g.imageSmoothingEnabled = true;
        g.strokeStyle = "rgba(42,46,52,0.10)";
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
        // the outline (photo px -> screen), drawing on with its head as a graphite dot
        const draw1 = clamp((tt - cues.s1 - 0.3) / 2.4);
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
          ["rgba(250,246,238,0.92)", 12],
          [C.ink, 5],
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
          g.arc(x, y, 4.5, 0, Math.PI * 2);
          g.fill();
        });
        g.restore();
      }
      grain(g, imgs["fx/grain.png"], frame, 0.07);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imgs, cues],
  );

  // stage 2: the two traces
  const s2 = stage(1);
  const fitK = easeIO(clamp((t - cues.s2 - 0.5) / 1.8));
  const A = SEAM.profA as number[];
  const B = SEAM.profB as number[];
  const sum = A.map((v, i) => v + B[i]);
  const TW = 1640;
  // the profiles swing about 100 px of the photo one way (A down-to-up, B mirrored): 2.5x keeps each trace in a
  // 260 px band, clear of the title above and the caption band below
  const amp = 2.5;
  const yA = lerp(400, 560, fitK);
  const yB = lerp(780, 560, fitK);
  const ySum = 820;
  const prof = (p: number[], dy: number, sign: number) => p.map((v, i) => `${i ? "L" : "M"}${((i / (p.length - 1)) * TW).toFixed(1)} ${(dy + sign * v * amp).toFixed(1)}`).join("");
  // stage 3: the image Muse read
  const s3 = stage(2);
  const words = (SEAM.read!.words as string[]) ?? [];
  const wordsK = clamp((t - cues.s3 - 0.7) / 0.9);
  // stage 4: twins, then the tray
  const s4 = stage(3);
  const trayK = spring(t - cues.s5 + 0.2);
  // the scraps sit in the middle of the frame, then rise to make room for the tray
  const rise4 = (1 - easeIO(clamp((t - (cues.s5 - 1.15)) / 0.6))) * 150;
  const title = (txt: React.ReactNode, o: number, x: number) => (
    <div style={{ position: "absolute", left: 96, top: 36, transform: `translateX(${x * 0.5}px)`, opacity: Math.pow(clamp((o - 0.35) / 0.65), 1.5), fontFamily: F.serif, fontWeight: 500, fontSize: 38, color: C.chalk }}>{txt}</div>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <FrameCanvas draw={draw} ready={!!imgs} />
      {title(<>SAM 3.1's mask, traced between the pixels</>, stage(0).o, stage(0).x)}

      {s2.o > 0.01 && (
        <div style={{ position: "absolute", left: (W - TW) / 2 + s2.x, top: 0, width: TW, height: H, opacity: s2.o }}>
          <svg width={TW} height={H} style={{ overflow: "visible" }}>
            <path d={prof(A, yA, 1)} fill="none" stroke={C.chalk} strokeWidth={7} strokeLinejoin="round" />
            <path d={prof(B, yB, -1)} fill="none" stroke={C.chalk2} strokeWidth={7} strokeLinejoin="round" opacity={1 - 0.4 * fitK} />
            <path d={prof(sum, ySum, 1)} fill="none" stroke={C.chalk3} strokeWidth={4} opacity={smooth(0.85, 1, fitK)} />
          </svg>
          <div style={{ position: "absolute", left: 0, top: yA + A[0] * amp - 44, fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.chalk }}>edge A</div>
          <div style={{ position: "absolute", left: 0, top: yB - B[0] * amp + 16, fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.chalk2, opacity: 1 - smooth(0.7, 1, fitK) }}>edge B</div>
          <div style={{ position: "absolute", left: 0, top: ySum - 46, fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.chalk3, opacity: smooth(0.85, 1, fitK) }}>A + B: flat</div>
        </div>
      )}
      {title(
        <>
          The edges mirror: <span style={{ color: C.chalk2 }}>fits along {Math.round(SEAM.shape.score)} px, {SEAM.shape.rms.toFixed(2)} px misfit</span>
        </>,
        s2.o,
        s2.x,
      )}

      {s3.o > 0.01 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 120, display: "flex", flexDirection: "column", alignItems: "center", opacity: s3.o, transform: `translateX(${s3.x}px)` }}>
          <Img src={staticFile("kit/fdr/seam-pair_p7_p9_0.jpg")} style={{ width: 1680, height: 600, imageRendering: "pixelated", boxShadow: "0 18px 40px rgba(18,12,8,0.55)" }} />
          <div style={{ marginTop: 24, fontFamily: F.serif, fontWeight: 500, fontSize: 92, lineHeight: 1, color: C.violetLt, letterSpacing: "-0.01em" }}>
            {words.slice(0, Math.max(0, Math.ceil(words.length * wordsK))).join(" · ")}
          </div>
        </div>
      )}
      {title(<>Muse Spark reads across the seam</>, s3.o, s3.x)}

      {s4.o > 0.01 && (
        <div style={{ position: "absolute", inset: 0, opacity: s4.o, transform: `translateX(${s4.x}px)` }}>
          <div style={{ position: "absolute", left: 96, top: 120 + rise4, display: "flex", gap: 36, transform: `translate(${noise1(t * 0.3, 21) * 4}px, ${noise1(t * 0.27, 22) * 3}px)` }}>
            {["A", "B", "C"].map((k, i) => {
              // the rule played once: the reading rejects A and B (red, as in the twins beat) and picks C (violet)
              const at = cues.s4 + 1.0 + i * 0.55;
              const on = clamp((t - at) / 0.3);
              const tagA = smooth(cues.s4 + 0.4, cues.s4 + 0.8, t);
              const picked = i === 2;
              return (
                <div key={k} style={{ position: "relative", width: 552, height: 312 }}>
                  <Img src={staticFile(`kit/twins-sheet/twin-${k}.webp`)} style={{ width: 552, height: 312, objectFit: "contain", opacity: picked ? 1 : 1 - 0.35 * on, filter: picked && on > 0 ? `drop-shadow(0 0 ${18 * on}px rgba(176,164,248,${0.45 * on})) drop-shadow(0 12px 20px rgba(18,12,8,0.5))` : "drop-shadow(0 12px 20px rgba(18,12,8,0.5))" }} />
                  {!picked && (
                    <svg width={552} height={312} style={{ position: "absolute", inset: 0 }}>
                      <line x1={60} y1={262} x2={60 + 432 * on} y2={262 - 212 * on} stroke={C.red} strokeWidth={6} strokeLinecap="round" opacity={on > 0 ? 0.95 : 0} />
                    </svg>
                  )}
                  <div style={{ position: "absolute", left: 276 - 22, top: 312 - 30, width: 44, height: 44, borderRadius: 22, display: "grid", placeItems: "center", opacity: tagA, fontFamily: F.sans, fontWeight: 700, fontSize: 24, color: C.chalk, background: on > 0.5 ? (picked ? C.violet : C.red) : "rgba(42,46,52,0.92)", boxShadow: "0 4px 14px rgba(20,14,10,0.35)" }}>
                    {k}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ position: "absolute", left: 96, top: 470 + rise4, fontFamily: F.serif, fontWeight: 500, fontSize: 44, color: C.chalk2, opacity: smooth(cues.s4 + 0.3, cues.s4 + 0.8, t) }}>One edge, three scraps: placed only when two reads agree.</div>
          {/* the tray, and a scrap the stack run really set aside */}
          <div style={{ position: "absolute", left: 1010, top: 580, width: 814, height: 330, borderRadius: 8, background: "rgba(20,15,12,0.35)", boxShadow: `inset 0 0 0 1.5px ${C.chalkHair2}`, opacity: smooth(cues.s5 - 1.0, cues.s5 - 0.5, t) }}>
            <Img
              src={staticFile("kit/aside/p4-lit.png")}
              style={{
                position: "absolute",
                left: 210,
                top: 40 - (1 - clamp(trayK)) * 360,
                height: 230,
                transform: `rotate(${(1 - clamp(trayK)) * 9 - 3 + 2 * settle(t - cues.s5 - 0.35)}deg)`,
                opacity: smooth(cues.s5 - 0.7, cues.s5 - 0.4, t),
                filter: `drop-shadow(0 ${6 + 20 * (1 - clamp(trayK))}px ${12 + 18 * (1 - clamp(trayK))}px rgba(18,12,8,0.55))`,
              }}
            />
          </div>
          <div style={{ position: "absolute", left: 96, top: 600, width: 860, fontFamily: F.serif, fontWeight: 500, fontSize: 64, lineHeight: 1.1, color: C.chalk, opacity: smooth(cues.s5 - 0.3, cues.s5 + 0.3, t) }}>
            Never forced.
            <div style={{ marginTop: 16, fontFamily: F.sans, fontSize: 24, color: C.chalk3 }}>This scrap was set aside: its twins could not be told apart. 6 of 24 in the stack run.</div>
          </div>
        </div>
      )}
      {title(<>Shape can't decide? The reading must agree.</>, s4.o, s4.x)}
    </AbsoluteFill>
  );
};
void easeOut;
void soft;
