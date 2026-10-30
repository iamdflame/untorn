// The honesty label: what this footage is (simulated tear, recorded run, live run...), set quietly in the corner,
// exactly as the product words it.
import React from "react";
import { clamp, easeOut } from "../lib/motion";
import { C, F } from "../theme";

export const Label: React.FC<{ t: number; t0: number; t1?: number; x: number; y: number; children: React.ReactNode; align?: "left" | "right"; color?: string }> = ({ t, t0, t1 = 1e9, x, y, children, align = "left", color = C.chalk2 }) => {
  const a = easeOut(clamp((t - t0) / 0.5)) * (1 - clamp((t - t1) / 0.4));
  if (a <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: align === "left" ? x : undefined,
        right: align === "right" ? x : undefined,
        top: y,
        opacity: a,
        fontFamily: F.serif,
        fontWeight: 500,
        fontSize: 23,
        letterSpacing: "0.003em",
        color,
        textShadow: "0 1px 2px rgba(20,14,10,0.55)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
};
