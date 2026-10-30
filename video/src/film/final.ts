// The final narration's alignments (ElevenLabs eleven_v4, per scene; scripts/voice/narrate.mjs).
import cold from "../data/narration/cold.json";
import sacks from "../data/narration/sacks.json";
import twins from "../data/narration/twins.json";
import proof from "../data/narration/proof.json";
import golden from "../data/narration/golden.json";
import hood from "../data/narration/hood.json";
import peak from "../data/narration/peak.json";

export const FINAL_READY = true;
export const FINAL: Record<string, unknown> = { cold, sacks, twins, proof, golden, hood, peak };
