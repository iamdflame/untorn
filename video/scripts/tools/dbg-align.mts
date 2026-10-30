// Debug: word timings and chunk matches for scenes.  node_modules/.bin/tsx scripts/tools/dbg-align.mts proof hood
import { align, chunkTimes, type SceneId } from "../../src/film/align";

const ids = (process.argv.slice(2).length ? process.argv.slice(2) : ["proof", "hood"]) as SceneId[];
for (const id of ids) {
  const a = align(id);
  console.log(id, a.words.map((w) => `${w.w}@${w.start.toFixed(2)}`).join(" "));
  console.log(chunkTimes(id).map((c) => `  [${c.start.toFixed(2)}-${c.end.toFixed(2)}] ${c.spoken.slice(0, 40)}`).join("\n"));
}
