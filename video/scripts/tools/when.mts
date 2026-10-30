// Film times of named moments (for checking stills).
import { buildTimeline } from "../../src/film/timeline";
import { coldEvents, unwarpTime } from "../../src/scenes/ColdOpen";
const tl = buildTimeline();
const ce = coldEvents();
const S = (id: string) => tl.scenes.find((s) => s.id === id)!.start;
const out = {
  hope: unwarpTime(ce.word + 0.6, tl.cold.warp),
  seat: unwarpTime(ce.seat, tl.cold.warp),
  peakQuote: S("peak") + tl.peak.quote0 + 2.0,
  peakQuoteEnd: S("peak") + tl.peak.quote1,
  twinsTie: S("twins") + tl.twins.tie + 0.5,
  proofMuse: S("proof") + tl.proof.muse + 4,
  hoodS2: S("hood") + tl.hood.s2 + 2,
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { t: +v.toFixed(2), frame: Math.round(v * 30) }]))));
