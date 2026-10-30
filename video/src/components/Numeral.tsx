// A figure set large in Gambetta with tabular figures. Changing digits settle into place (the old digit slides out
// under, the new one settles in from above on a soft spring); unchanged digits never move. No slot-machine spinning.
import React from "react";
import { clamp, soft } from "../lib/motion";
import { C, F } from "../theme";

export const Numeral: React.FC<{ from?: string; to: string; t: number; t0: number; size: number; color?: string; stagger?: number }> = ({ from, to, t, t0, size, color = C.chalk, stagger = 0.07 }) => {
  const a = from ?? to;
  const len = Math.max(a.length, to.length);
  const A = a.padStart(len, " ");
  const B = to.padStart(len, " ");
  let changed = 0;
  return (
    <span style={{ display: "inline-flex", fontFamily: F.serif, fontWeight: 500, fontSize: size, lineHeight: 1, color, fontVariantNumeric: "tabular-nums lining-nums", letterSpacing: "-0.015em" }}>
      {B.split("").map((ch, i) => {
        const old = A[i];
        if (old === ch) return <span key={i}>{ch === " " ? "" : ch}</span>;
        const k = changed++;
        const u = clamp(soft(t - t0 - k * stagger, 8), 0, 1);
        return (
          <span key={i} style={{ position: "relative", display: "inline-block", overflow: "hidden", height: "1.08em", verticalAlign: "top" }}>
            <span style={{ visibility: "hidden" }}>{ch}</span>
            <span style={{ position: "absolute", left: 0, top: 0, transform: `translateY(${(u * 0.9).toFixed(4)}em)`, opacity: 1 - u }}>{old}</span>
            <span style={{ position: "absolute", left: 0, top: 0, transform: `translateY(${((u - 1) * 0.9).toFixed(4)}em)`, opacity: u }}>{ch}</span>
          </span>
        );
      })}
    </span>
  );
};
