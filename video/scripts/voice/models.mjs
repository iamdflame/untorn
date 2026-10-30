// Lists the TTS models and the chosen library voice (no characters are spent).
import { elevenKey, headers } from "./env.mjs";

const key = elevenKey();
const VOICE = process.argv[2] ?? "MFZUKuGQUsGJPQjTS4wC";
const r = await fetch("https://api.elevenlabs.io/v1/models", { headers: headers(key) });
const models = await r.json();
if (!Array.isArray(models)) { console.log("models:", r.status, JSON.stringify(models).slice(0, 300)); process.exit(1); }
for (const m of models)
  console.log([m.model_id, m.name, `tts=${m.can_do_text_to_speech}`, `langs=${(m.languages ?? []).length}`, `maxChars=${m.max_characters_request_subscribed_user ?? m.maximum_text_length_per_request ?? "?"}`, `costFactor=${m.token_cost_factor ?? "?"}`, `style=${m.can_use_style}`, `boost=${m.can_use_speaker_boost}`].join(" | "));
const v = await fetch(`https://api.elevenlabs.io/v1/voices/${VOICE}`, { headers: headers(key) });
const vj = await v.json();
console.log("voice:", v.status, vj.name, "| category:", vj.category, "| labels:", JSON.stringify(vj.labels), "| hq models:", JSON.stringify(vj.high_quality_base_model_ids), "| settings:", JSON.stringify(vj.settings));
const u = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: headers(key) });
const uj = await u.json();
console.log("subscription:", u.status, "tier:", uj.tier, "| used:", uj.character_count, "| limit:", uj.character_limit, "| reset (unix):", uj.next_character_count_reset_unix);
