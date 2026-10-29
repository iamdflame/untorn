import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted type: Gambetta 500 and 600 (Fontshare, ITF free licence) for the headline, mark, reads and titles; Schibsted
// Grotesk for UI and body; IBM Plex Mono only for machine output (Google Fonts, OFL). Latin subsets.
const gambetta = localFont({
  src: [{ path: "./fonts/gambetta-500.woff2", weight: "500", style: "normal" }],
  variable: "--font-gambetta",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});
// the semibold cut (the mark and the climax word) isn't needed for the first paint
const gambettaSemi = localFont({
  src: [{ path: "./fonts/gambetta-600.woff2", weight: "600", style: "normal" }],
  variable: "--font-gambetta-600",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
});
const schibsted = localFont({
  src: [{ path: "./fonts/schibsted.woff2", weight: "400 900", style: "normal" }],
  variable: "--font-schibsted",
  display: "swap",
});
const plex = localFont({
  src: [
    { path: "./fonts/plexmono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plexmono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "Untorn · Every torn page, whole again",
  description:
    "Untorn puts torn documents back together from one photo. Meta's SAM 3.1 cuts out every piece, and Muse reads the half-letters across each tear to decide which pieces belong together.",
  applicationName: "Untorn",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#332c27",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${gambetta.variable} ${gambettaSemi.variable} ${schibsted.variable} ${plex.variable}`}>
      <body>{children}</body>
    </html>
  );
}
