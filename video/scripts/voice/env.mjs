// Reads ELEVENLABS_API_KEY from the main checkout's .env (or the environment). The key is never printed.
import fs from "node:fs";

export function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = process.env.ELEVEN_ENV_FILE ?? "C:/Users/Dflame/Pictures/rr/.env";
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/m);
  if (!m) throw new Error("ELEVENLABS_API_KEY not found");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** Generic headers only: no names, no email, nothing personal. */
export const headers = (key) => ({ "xi-api-key": key, "User-Agent": "video-build/1.0", Accept: "application/json" });
