// Remotion's own ffmpeg and ffprobe (from @remotion/compositor-*), so nothing is installed system-wide.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
function binDir() {
  const pkg = `@remotion/compositor-${process.platform}-${process.arch}${process.platform === "win32" ? "-msvc" : ""}`;
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`, { paths: [path.dirname(require.resolve("@remotion/renderer/package.json"))] }));
  } catch {
    const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../node_modules/.pnpm");
    const d = fs.readdirSync(base).find((n) => n.startsWith("@remotion+compositor-"));
    return path.join(base, d, "node_modules", "@remotion", d.replace(/^@remotion\+/, "").replace(/@.*$/, ""));
  }
}
const DIR = binDir();
export const FFMPEG = path.join(DIR, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
export const FFPROBE = path.join(DIR, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

export function ffmpeg(args, opts = {}) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", opts.loglevel ?? "error", ...args], { encoding: "utf8", maxBuffer: 1 << 28, cwd: DIR });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr?.slice(-800)}`);
  return r;
}
export function probe(file) {
  return JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path.resolve(file)], { encoding: "utf8", cwd: DIR }));
}
/** Decode any audio file to mono 16-bit PCM WAV at the given rate. */
export function toWav(input, output, rate = 24000) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  ffmpeg(["-y", "-i", path.resolve(input), "-ac", "1", "-ar", String(rate), "-c:a", "pcm_s16le", "-map_metadata", "-1", path.resolve(output)]);
  return output;
}
