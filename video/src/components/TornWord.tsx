// A word set in Gambetta and cut in two by a real tear profile (the edge trace of the recorded run's longest seam),
// like the app's torn headline: the halves sit offset, slide together on the heavy spring, and the cut ends as a
// violet hairline. Legible from its first frame.
import React, { useMemo } from "react";
import scene from "../data/scene-fdr-1927.json";
import { clamp, easeOut, smooth, spring } from "../lib/motion";
import { C, F } from "../theme";

const TEAR: number[] = (() => {
  const s = [...scene.seams].filter((x) => x.profA).sort((a, b) => b.len - a.len)[0];
  const prof = (s?.profA ?? [0, 0.4, -0.3, 0.2, -0.5, 0.1, 0]) as number[];
  const amp = Math.max(...prof.map(Math.abs)) || 1;
  // keep every other sample: about 48 points down the cut
  return prof.filter((_, i) => i % 2 === 0).map((v) => v / amp);
})();

function measure(text: string, upTo: number, size: number) {
  if (typeof document === "undefined") return 0.4;
  const c = document.createElement("canvas").getContext("2d")!;
  c.font = `500 ${size}px ${F.serif}`;
  return c.measureText(text.slice(0, upTo)).width / c.measureText(text).width;
}

export const TornWord: React.FC<{ text: string; cut?: number; t: number; t0: number; seat: number; x: number; y: number; size: number; color?: string; hairline?: boolean; align?: "left" | "center" }> = ({
  text,
  cut = 2,
  t,
  t0,
  seat,
  x,
  y,
  size,
  color = C.chalk,
  hairline = true,
  align = "left",
}) => {
  const frac = useMemo(() => measure(text, cut, size), [text, cut, size]);
  if (t < t0 - 0.01) return null;
  const appear = easeOut(clamp((t - t0) / 0.5));
  const join = spring(t - seat + 0.12);
  const u = 1 - clamp(join, 0, 1.05);
  const cx = frac * 100;
  const dev = 2.6;
  const pts = TEAR.map((v, i) => [cx + v * dev, -6 + (112 * i) / (TEAR.length - 1)]);
  const P = pts.map(([px, py]) => `${px.toFixed(2)}% ${py.toFixed(2)}%`).join(",");
  const R = [...pts].reverse().map(([px, py]) => `${px.toFixed(2)}% ${py.toFixed(2)}%`).join(",");
  const left = `polygon(-12% -12%, ${P}, -12% 112%)`;
  const right = `polygon(${pts[0][0].toFixed(2)}% -12%, 112% -12%, 112% 112%, ${R})`;
  const seamA = hairline ? smooth(0.86, 1.0, clamp(join)) : 0;
  const seamDraw = clamp((t - seat - 0.05) / 0.35);
  const common: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    fontFamily: F.serif,
    fontWeight: 500,
    fontSize: size,
    lineHeight: 1,
    letterSpacing: "-0.02em",
    color,
    whiteSpace: "nowrap",
  };
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y + 14 * (1 - appear),
        opacity: appear,
        transform: align === "center" ? "translateX(-50%)" : undefined,
      }}
    >
      <div style={{ position: "relative" }}>
        <span style={{ ...common, position: "relative", visibility: "hidden" }}>{text}</span>
        <span style={{ ...common, clipPath: left, transform: `translate(${(-0.045 * u).toFixed(4)}em, ${(-0.004 * u).toFixed(4)}em)` }}>{text}</span>
        <span style={{ ...common, clipPath: right, transform: `translate(${(0.055 * u).toFixed(4)}em, ${(0.03 * u).toFixed(4)}em) rotate(${(0.7 * u).toFixed(3)}deg)` }}>{text}</span>
        {seamA > 0.01 && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible", opacity: seamA }}>
            <path
              d={pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`).join("")}
              fill="none"
              stroke={C.violetLt}
              strokeWidth={2.2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="100"
              strokeDashoffset={100 * (1 - seamDraw)}
              pathLength={100}
            />
          </svg>
        )}
      </div>
    </div>
  );
};
