// Voice search across the ElevenLabs library, by evidence. No characters are spent: these are listing calls only.
// Pulls English narration candidates from the public library (several sorts and use cases, plus featured) and the
// account's premade voices, drops clones of real or famous people and the user's own clone, and writes one table.
//   node scripts/voice/library.mjs  ->  out/voice-auditions/candidates.json
import fs from "node:fs";
import path from "node:path";
import { elevenKey, headers } from "./env.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const OUT = path.join(ROOT, "out", "voice-auditions");
fs.mkdirSync(OUT, { recursive: true });
const key = elevenKey();
const H = headers(key);

const seen = new Map();
const add = (v, via) => {
  const id = v.voice_id;
  const prev = seen.get(id);
  if (prev) {
    prev.via.add(via);
    return;
  }
  const models = [...new Set((v.verified_languages ?? []).filter((l) => !l.language || l.language === "en").map((l) => l.model_id))];
  seen.set(id, {
    id,
    name: v.name,
    category: v.category,
    accent: v.accent ?? null,
    age: v.age ?? null,
    gender: v.gender ?? null,
    descriptive: v.descriptive ?? null,
    use_case: v.use_case ?? null,
    language: v.language ?? null,
    usage_1y: v.usage_character_count_1y ?? null,
    usage_7d: v.usage_character_count_7d ?? null,
    cloned_by: v.cloned_by_count ?? null,
    liked_by: v.liked_by_count ?? null,
    featured: v.featured ?? null,
    free_users_allowed: v.free_users_allowed ?? null,
    notice_period: v.notice_period ?? null,
    rate: v.rate ?? null,
    v4: models.includes("eleven_v4"),
    models,
    description: (v.description ?? "").replace(/\s+/g, " ").trim(),
    preview_url: v.preview_url ?? null,
    via: new Set([via]),
  });
};

async function shared(params, via) {
  const q = new URLSearchParams({ page_size: "100", language: "en", ...params });
  const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${q}`, { headers: H });
  if (!r.ok) {
    console.log("shared-voices", via, r.status, (await r.text()).slice(0, 200));
    return 0;
  }
  const j = await r.json();
  for (const v of j.voices ?? []) add(v, via);
  return (j.voices ?? []).length;
}

const useCases = ["narrative_story", "informative_educational", "advertisement", "entertainment_tv"];
for (const uc of useCases)
  for (const sort of ["usage_character_count_1y", "cloned_by_count"])
    for (const category of ["high_quality", "professional"]) {
      const n = await shared({ use_cases: uc, sort, category }, `${uc}/${sort}/${category}`);
      console.log(uc, sort, category, n);
    }
for (const sort of ["usage_character_count_1y", "cloned_by_count", "trending"]) console.log("featured", sort, await shared({ featured: "true", sort }, `featured/${sort}`));
for (const s of ["documentary", "narrator", "audiobook", "storyteller", "calm", "deep"]) console.log("search", s, await shared({ search: s, sort: "usage_character_count_1y" }, `search:${s}`));

// the account's own voices: premade ones are candidates; the user's clone ("Dflame") is never one
const mine = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: H }).then((r) => r.json());
for (const v of mine.voices ?? []) {
  if (v.category === "cloned") continue;
  add({ ...v, use_case: v.labels?.use_case ?? v.labels?.["use case"], accent: v.labels?.accent, age: v.labels?.age, gender: v.labels?.gender, descriptive: v.labels?.descriptive, verified_languages: (v.verified_languages ?? []).map((l) => ({ ...l, model_id: l.model_id })) }, `account/${v.category}`);
}

// exclusions: clones or soundalikes of real or famous people, the user's own clone, anything not plainly English narration
const FAMOUS = /attenborough|freeman|morgan|obama|trump|biden|elon|musk|jobs|sagan|hawking|walken|cumberbatch|nolan|celebrity|famous|impression|soundalike|parody|like (a )?famous|imitat/i;
const rows = [...seen.values()].map((v) => {
  const why = [];
  if (/dflame/i.test(v.name)) why.push("the user's own clone");
  if (v.category === "famous") why.push("famous-person category");
  if (FAMOUS.test(`${v.name} ${v.description}`)) why.push("name or description suggests a real person or soundalike");
  if (v.language && v.language !== "en") why.push(`language ${v.language}`);
  return { ...v, via: [...v.via], excluded: why.length ? why.join("; ") : null };
});
rows.sort((a, b) => (b.usage_1y ?? 0) - (a.usage_1y ?? 0));
fs.writeFileSync(path.join(OUT, "candidates.json"), JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} candidates (${rows.filter((r) => r.excluded).length} excluded) -> out/voice-auditions/candidates.json`);
const fmt = (n) => (n == null ? "-" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
for (const r of rows.filter((x) => !x.excluded && x.gender === "male" || !x.excluded && x.gender === "female").slice(0, 70))
  console.log([r.id, r.name.slice(0, 44).padEnd(44), (r.gender ?? "").padEnd(6), (r.age ?? "").padEnd(11), (r.accent ?? "").padEnd(10), (r.use_case ?? "").padEnd(22), (r.descriptive ?? "").padEnd(12), "use1y", fmt(r.usage_1y).padStart(6), "clones", fmt(r.cloned_by).padStart(6), "likes", fmt(r.liked_by).padStart(5), r.v4 ? "v4" : "--", r.category].join(" "));
