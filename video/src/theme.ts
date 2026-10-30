// Untorn's design tokens for the film (from the app's globals.css and draw.ts), and the type stack.
// Three-colour rule: graphite = geometry, violet = what Muse read, red = a rejected twin. The paper is the only warm
// thing on screen, lit by the light table.

export const C = {
  room: "#332c27", // oklch(0.30 0.014 60)
  room2: "#3f3731", // oklch(0.36 0.016 62)
  room3: "#2c2622", // oklch(0.265 0.012 60)
  chalk: "#f3eee4", // oklch(0.95 0.014 85)
  chalk2: "#c9c3b8", // oklch(0.80 0.014 80)
  chalk3: "#b0a99e", // oklch(0.70 0.014 75), raised for contrast on the room
  chalkHair: "rgba(243,238,228,0.12)",
  chalkHair2: "rgba(243,238,228,0.28)",
  ink: "#2a2e34", // graphite: outlines, balloons, geometry
  ink2: "#5f636a",
  ink3: "#8f9298",
  violet: "#583bab", // oklch(0.45 0.17 290): Muse read this (on paper)
  violetLt: "#b0a4f8", // oklch(0.76 0.12 290): Muse read this (on the room)
  red: "#c74c41", // oklch(0.58 0.16 28): a rejected twin
  redLt: "#e2897c",
  film: "#f0f4f7",
  filmHi: "#fafcfe",
  warm: "#fdf3df", // oklch(0.975 0.022 85): the light-table glow
} as const;

export const F = {
  serif: "Gambetta, 'Times New Roman', Georgia, serif",
  sans: "'Schibsted Grotesk', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

export const W = 1920;
export const H = 1080;
export const FPS = 30;
/** Side margin of the frame (the design's 48-56 px gutter, scaled to a 1920 frame). */
export const GX = 96;
