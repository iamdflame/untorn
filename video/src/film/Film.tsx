// The film: seven scenes on one timeline computed from the narration's timestamps, with transitions made from the
// subject (the page pulls apart into the archive; a tear-shaped wipe cut from a real SAM outline; cuts on the voice's
// stresses; a match cut on the page), burned-in captions and the narration.
import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Captions } from "../components/Captions";
import { TearWipe } from "../components/TearWipe";
import { ColdOpen } from "../scenes/ColdOpen";
import { Golden } from "../scenes/Golden";
import { Hood } from "../scenes/Hood";
import { Peak } from "../scenes/Peak";
import { Proof } from "../scenes/Proof";
import { Sacks } from "../scenes/Sacks";
import { Twins } from "../scenes/Twins";
import { C, FPS } from "../theme";
import { align } from "./align";
import { buildTimeline } from "./timeline";

export const fr = (s: number) => Math.round(s * FPS);
export const TIMELINE = buildTimeline();
export const FILM_FRAMES = fr(TIMELINE.total);

export const Film: React.FC<{ audio?: "scratch" | "final" | "mix" | "none" }> = ({ audio = "scratch" }) => {
  const tl = useMemo(() => TIMELINE, []);
  const at = (id: string) => tl.scenes.find((s) => s.id === id)!;
  const seq = (id: string, node: React.ReactNode) => {
    const s = at(id);
    return (
      <Sequence key={id} from={fr(s.start)} durationInFrames={fr(s.dur)} name={id}>
        {node}
      </Sequence>
    );
  };
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      {seq("sacks", <Sacks cues={tl.sacks} />)}
      {/* the cold open sits on top: its page pulls apart and the archive shows through */}
      {seq("cold", <ColdOpen warp={tl.cold.warp} />)}
      {seq(
        "twins",
        <TearWipe t0={0} dur={0.95}>
          <Twins cues={tl.twins} />
        </TearWipe>,
      )}
      {seq("proof", <Proof cues={tl.proof} />)}
      {seq("golden", <Golden cues={tl.golden} />)}
      {seq("hood", <Hood cues={tl.hood} />)}
      {seq("peak", <Peak cues={tl.peak} />)}
      <Captions clips={tl.clips} />
      {audio === "scratch" || audio === "final"
        ? tl.clips.map((c, i) => (
            <Sequence key={i} from={fr(c.at)} durationInFrames={Math.max(1, fr(c.to - c.from))} layout="none">
              <Audio src={staticFile(align(c.scene).audio)} trimBefore={fr(c.from)} />
            </Sequence>
          ))
        : null}
      {audio === "mix" ? <Audio src={staticFile("audio/mix.wav")} /> : null}
    </AbsoluteFill>
  );
};
