// A tear-shaped wipe: the next scene shows through a hole cut in the shape of a real SAM 3.1 outline (a piece of
// the 1927 letter), which opens out past the frame. Its rim catches the light like a torn fibre edge.
import React from "react";
import { useCurrentFrame } from "remotion";
import scene from "../data/scene-fdr-1927.json";
import { clamp, smoother } from "../lib/motion";
import { FPS, H, W } from "../theme";

const P = scene.pieces.find((p) => p.id === "p4")!;
const R = P.r;
// a gently simplified outline (every 3rd point), normalised to its own radius
const UNIT: [number, number][] = [];
for (let i = 0; i < P.poly.length; i += 6) UNIT.push([P.poly[i] / R, P.poly[i + 1] / R]);

function pathAt(cx: number, cy: number, r: number, rot: number) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return UNIT.map(([x, y], i) => `${i ? "L" : "M"}${(cx + (x * c - y * s) * r).toFixed(1)} ${(cy + (x * s + y * c) * r).toFixed(1)}`).join("") + "Z";
}

/** Children appear inside the opening outline between t0 and t0 + dur (seconds, in the enclosing sequence). */
export const TearWipe: React.FC<{ t0: number; dur: number; cx?: number; cy?: number; children: React.ReactNode }> = ({ t0, dur, cx = W * 0.52, cy = H * 0.5, children }) => {
  const t = useCurrentFrame() / FPS;
  const u = smoother(t0, t0 + dur, t);
  if (u >= 1) return <>{children}</>;
  if (u <= 0) return null;
  // grows from a scrap to past the corners (the outline's inner radius is about 0.45 of its outer)
  const r = 30 + Math.pow(u, 1.6) * Math.hypot(W, H) * 2.6;
  const rot = -0.5 + 0.35 * u;
  const d = pathAt(cx, cy, r, rot);
  const rim = clamp(1 - u * 1.1);
  return (
    <>
      <div style={{ position: "absolute", inset: 0, clipPath: `path('${d}')` }}>{children}</div>
      <svg width={W} height={H} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
        <path d={d} fill="none" stroke="rgba(255,244,222,0.85)" strokeWidth={3.2} opacity={rim} style={{ filter: "drop-shadow(0 0 6px rgba(255,236,200,0.9))" }} />
      </svg>
    </>
  );
};
