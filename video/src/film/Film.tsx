// The film: seven scenes on one timeline computed from the narration's timestamps, with transitions made from the
// subject (the page pulls apart into the archive; a tear-shaped wipe cut from a real SAM outline; cuts on the voice's
// stresses), burned-in captions and the narration. The real page, torn by hand and rebuilt live, comes right after the
// sacks, inside the film's first minute.
import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Captions } from "../components/Captions";
import { TearWipe } from "../components/TearWipe";
import { ColdOpen } from "../scenes/ColdOpen";
import { DEFAULT_TEAR, Golden, type Tear } from "../scenes/Golden";
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

export const Film: React.FC<{ audio?: "scratch" | "final" | "mix" | "none"; tear?: Tear }> = ({ audio = "scratch", tear = DEFAULT_TEAR }) => {
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
      {/* the real page, rebuilt live, right after the sacks; the twins tear in over its last moments */}
      {seq("golden", <Golden cues={tl.golden} tear={tear} />)}
      {seq(
        "twins",
        <TearWipe t0={0} dur={0.95}>
          <Twins cues={tl.twins} />
        </TearWipe>,
      )}
      {seq("proof", <Proof cues={tl.proof} />)}
      {seq("hood", <Hood cues={tl.hood} />)}
      {seq("peak", <Peak cues={tl.peak} />)}
      {/* the end card sets the last line itself ("Untorn" / "Reads across the tears."), so its caption is not burned in
          twice (the SRT keeps every line) */}
      <Captions clips={tl.clips.filter((c) => c.at < at("peak").start + tl.peak.card)} />
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
