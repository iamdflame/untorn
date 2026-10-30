// The thumbnail (1280x720 still): the product at work, not a face. The 1927 letter whole again on the light table,
// its seams violet where Muse read across them; the real-pixel loupe on one of those reads; the torn wordmark.
// Laid out at 1920x1080 and scaled, so it is the film's own frame, not a redrawing.
import React from "react";
import { AbsoluteFill } from "remotion";
import { TornWord } from "../components/TornWord";
import { C, F } from "../theme";
import { ColdOpen } from "./ColdOpen";

export const Thumbnail: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transform: "scale(0.66667)", transformOrigin: "0 0" }}>
        <ColdOpen still={11.45} bare forceRead loupeOffset={[-700, 330, 170]} />
        <TornWord text="Untorn" t={20} t0={0} seat={0} x={92} y={96} size={250} />
        <div style={{ position: "absolute", left: 100, bottom: 34, fontFamily: F.serif, fontWeight: 500, fontSize: 22, color: C.chalk3 }}>Simulated tear of a real 1927 letter, recorded run.</div>
      </div>
    </AbsoluteFill>
  );
};
