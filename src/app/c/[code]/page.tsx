import type { Metadata } from "next";
import { Suspense } from "react";
import { Capture } from "@/components/Capture";

export const metadata: Metadata = { title: "Send a photo · Untorn", robots: { index: false } };

export default function CapturePage({ params }: PageProps<"/c/[code]">) {
  return (
    <Suspense fallback={<p role="status">Opening the camera page…</p>}>
      {params.then(({ code }) => (
        <Capture code={decodeURIComponent(code).toUpperCase().slice(0, 12)} />
      ))}
    </Suspense>
  );
}
