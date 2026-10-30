// The storyboard's key frames: film times chosen from the timeline's own cues, with the narration line at each.
//   node_modules/.bin/tsx scripts/tools/keyframes.mts > out/storyboard/keyframes.json
import { buildTimeline } from "../../src/film/timeline";
import { FPS } from "../../src/theme";

const tl = buildTimeline();
const S = (id: string) => tl.scenes.find((s) => s.id === id)!.start;
const k: [string, number][] = [
  ["cold · macro on a torn edge", 0.4],
  ["cold · pull back, one photo", 3.2],
  ["cold · SAM 3.1 outlines", tl.cold.warp[1][0] + 1.0],
  ["cold · lift and fly home", tl.cold.warp[2][0] + 1.8],
  ["cold · 'hope' reads in violet", tl.cold.warp[3][0] - 0.2],
  ["cold · Untorn lands", tl.cold.warp[4][0] - 0.6],
  ["transition · the page pulls apart", tl.cold.warp[4][0] + 0.6],
  ["sacks · the depot", S("sacks") + 3.0],
  ["sacks · about 16,000", S("sacks") + tl.sacks.sixteen + 1.0],
  ["sacks · about 15,400", S("sacks") + tl.sacks.fifteen + 1.4],
  ["sacks · 847 years, alone", S("sacks") + tl.sacks.years + 1.0],
  ["transition · tear-shaped wipe", S("twins") + 0.45],
  ["twins · same edge, three letters", S("twins") + tl.twins.tie + 0.8],
  ["twins · A tried: no words", S("twins") + tl.twins.tryA + 0.9],
  ["twins · C completes the words", S("twins") + tl.twins.verdict + 1.0],
  ["proof · Muse Spark alone", S("proof") + tl.proof.muse + 3.6],
  ["proof · Untorn, same photo", S("proof") + tl.proof.untorn + 1.4],
  ["proof · the scores", S("proof") + tl.proof.scores + 2.4],
  ["golden · Tear your own, QR", S("golden") + 1.0],
  ["golden · the phone", S("golden") + tl.golden.phone + 2.0],
  ["golden · live: SAM 3.1", S("golden") + tl.golden.live + 1.6],
  ["golden · live: Muse reads", S("golden") + tl.golden.close + 1.2],
  ["golden · page comes back", S("golden") + tl.golden.climax + 0.6],
  ["golden · read back", S("golden") + tl.golden.result + 0.8],
  ["hood · pixels and outline", S("hood") + tl.hood.s1 + 2.0],
  ["hood · edges fit", S("hood") + tl.hood.s2 + 2.0],
  ["hood · Muse reads the seam", S("hood") + tl.hood.s3 + 2.0],
  ["hood · twins: agree or set aside", S("hood") + tl.hood.s4 + 2.4],
  ["hood · both clues", S("hood") + tl.hood.s5 + 1.6],
  ["peak · the letter, read", S("peak") + tl.peak.quote0 + 2.5],
  ["peak · the sack of slips", S("peak") + tl.peak.sacks + 2.0],
  ["peak · end card", S("peak") + tl.peak.seat + 1.6],
];
const caps = tl.clips;
const out = k.map(([label, t]) => {
  const c = [...caps].reverse().find((x) => x.at <= t + 0.05);
  const live = c && t <= c.at + (c.to - c.from) + 0.6 ? c.shown : "";
  return { label, t: Math.round(t * 100) / 100, frame: Math.round(t * FPS), narration: live };
});
console.log(JSON.stringify(out, null, 1));
