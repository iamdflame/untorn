import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Untorn · torn pages, put back together from one photo",
  description:
    "Untorn puts torn documents back together from one photo. Meta's SAM 3.1 outlines every piece, and Muse reads the half-letters across each tear to decide which pieces belong together.",
  applicationName: "Untorn",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f3f5f8",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
