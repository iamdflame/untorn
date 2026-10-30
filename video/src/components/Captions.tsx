// Burned-in captions, set in the design system (Schibsted Grotesk on the room, no box), timed by the narration's
// own timestamps chunk by chunk. The same cues feed out/untorn-demo.srt.
import React from "react";
import { useCurrentFrame } from "remotion";
import type { Clip } from "../film/timeline";
import { clamp } from "../lib/motion";
import { C, F, FPS, W } from "../theme";

export const Captions: React.FC<{ clips: Clip[] }> = ({ clips }) => {
  const t = useCurrentFrame() / FPS;
  // hold each caption until the next begins when the gap is short, so they don't flicker between phrases
  const list = clips.map((c, i) => {
    const start = c.at + 0.02;
    const natural = c.at + (c.to - c.from) + 0.25;
    const next = clips[i + 1]?.at ?? Infinity;
    const end = next - natural < 0.6 ? next - 0.02 : natural;
    return { ...c, start, end };
  });
  const cur = list.find((c) => t >= c.start && t < c.end);
  if (!cur) return null;
  const a = clamp((t - cur.start) / 0.1) * clamp((cur.end - t) / 0.1);
  return (
    <>
    {/* a calm band under the words, so a caption never sits on busy paper or UI */}
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 180, opacity: a, background: "linear-gradient(0deg, rgba(36,30,26,0.82) 0%, rgba(36,30,26,0.6) 45%, rgba(36,30,26,0) 100%)" }} />
    <div
      style={{
        position: "absolute",
        left: (W - 1240) / 2,
        width: 1240,
        bottom: 58,
        textAlign: "center",
        opacity: a,
        fontFamily: F.sans,
        fontWeight: 500,
        fontSize: 35,
        lineHeight: 1.3,
        letterSpacing: "-0.003em",
        color: C.chalk,
        textShadow: "0 1px 2px rgba(18,13,10,0.9), 0 0 16px rgba(18,13,10,0.75), 0 0 34px rgba(18,13,10,0.5)",
        textWrap: "balance",
      }}
    >
      {cur.shown}
    </div>
    </>
  );
};

/** SRT text from the same cues. */
export function toSrt(clips: Clip[]): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return clips
    .map((c, i) => {
      const start = c.at + 0.02;
      const natural = c.at + (c.to - c.from) + 0.25;
      const next = clips[i + 1]?.at ?? Infinity;
      const end = next - natural < 0.6 ? next - 0.02 : natural;
      return `${i + 1}\n${ts(start)} --> ${ts(end)}\n${c.shown}\n`;
    })
    .join("\n");
}
