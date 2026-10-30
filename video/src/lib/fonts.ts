// Self-hosted type, the same files the app ships: Gambetta 500/600, Schibsted Grotesk (variable), IBM Plex Mono.
import { continueRender, delayRender, staticFile } from "remotion";

const FACES: [string, string, string][] = [
  ["Gambetta", "fonts/gambetta-500.woff2", "500"],
  ["Gambetta", "fonts/gambetta-600.woff2", "600"],
  ["Schibsted Grotesk", "fonts/schibsted.woff2", "400 900"],
  ["IBM Plex Mono", "fonts/plexmono-400.woff2", "400"],
  ["IBM Plex Mono", "fonts/plexmono-500.woff2", "500"],
];

let started = false;
export function loadFonts() {
  if (started || typeof document === "undefined") return;
  started = true;
  const handle = delayRender("fonts");
  Promise.all(
    FACES.map(([family, url, weight]) =>
      new FontFace(family, `url(${staticFile(url)}) format('woff2')`, { weight, style: "normal" }).load().then((f) => {
        document.fonts.add(f);
      }),
    ),
  )
    .then(() => continueRender(handle))
    .catch((e) => {
      console.error("font load failed", e);
      continueRender(handle);
    });
}
