import type { Metadata } from "next";
import { Suspense } from "react";
import { Permalink } from "@/components/Permalink";

export const metadata: Metadata = { title: "A run · Untorn", robots: { index: false } };

export default function RunPage({ params }: PageProps<"/r/[runId]">) {
  return (
    <Suspense fallback={<p role="status">Loading the run…</p>}>
      {params.then(({ runId }) => (
        <Permalink runId={runId} />
      ))}
    </Suspense>
  );
}
