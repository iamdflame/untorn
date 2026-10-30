import React from "react";
import { Composition } from "remotion";
import { Film, FILM_FRAMES } from "./film/Film";
import { loadFonts } from "./lib/fonts";
import { ColdOpen } from "./scenes/ColdOpen";
import { DEFAULT_TEAR, Golden } from "./scenes/Golden";
import { Hood } from "./scenes/Hood";
import { Peak } from "./scenes/Peak";
import { Proof } from "./scenes/Proof";
import { Sacks } from "./scenes/Sacks";
import { Twins } from "./scenes/Twins";
import { Thumbnail } from "./scenes/Thumbnail";
import { Backup } from "./scenes/Backup";
import { BACKUP_TOTAL } from "./film/backupEdit";
import { Still } from "remotion";
import { FPS, H, W } from "./theme";

loadFonts();

const S = (s: number) => Math.round(s * FPS);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="UntornDemo" component={Film} durationInFrames={FILM_FRAMES} fps={FPS} width={W} height={H} defaultProps={{ audio: "mix" as const, tear: DEFAULT_TEAR }} />
      <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
      <Composition id="Backup" component={Backup} durationInFrames={Math.round(BACKUP_TOTAL * FPS)} fps={FPS} width={W} height={H} />
      <Composition id="ColdOpen" component={ColdOpen} durationInFrames={S(13.5)} fps={FPS} width={W} height={H} />
      <Composition id="ColdOpenDebug" component={ColdOpen} durationInFrames={S(13.5)} fps={FPS} width={W} height={H} defaultProps={{ debug: true }} />
      <Composition id="Sacks" component={Sacks} durationInFrames={S(17.5)} fps={FPS} width={W} height={H} />
      <Composition id="Twins" component={Twins} durationInFrames={S(15.5)} fps={FPS} width={W} height={H} />
      <Composition id="TwinsDebug" component={Twins} durationInFrames={S(15.5)} fps={FPS} width={W} height={H} defaultProps={{ debug: true }} />
      <Composition id="Proof" component={Proof} durationInFrames={S(14)} fps={FPS} width={W} height={H} />
      <Composition id="Golden" component={Golden} durationInFrames={S(23.5)} fps={FPS} width={W} height={H} />
      <Composition id="Hood" component={Hood} durationInFrames={S(20)} fps={FPS} width={W} height={H} />
      <Composition id="Peak" component={Peak} durationInFrames={S(17)} fps={FPS} width={W} height={H} />
    </>
  );
};
