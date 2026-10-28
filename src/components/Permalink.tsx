"use client";

// /r/<runId>: any stored run, played back by the same hero (a still with reduced motion), then its result.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Recovery } from "@/lib/run/errors";
import { SAMPLES } from "@/lib/run/samples";
import type { RunResult } from "@/lib/run/types";
import { Hero } from "./hero/Hero";
import { ErrorNote } from "./hero/LeadNote";
import { usePrefersReducedMotion } from "./hooks";
import { ResultSection } from "./result/ResultSection";
import { useRun } from "./run/useRun";

const SOURCE: Record<RunResult["source"], string> = { sample: "a sample run", phone: "a phone run", upload: "an uploaded run", health: "a health-check run" };

export function Permalink({ runId }: { runId: string }) {
  const run = useRun();
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [result, setResult] = useState<RunResult | null>(null);
  const [missing, setMissing] = useState<"not-found" | "network" | null>(null);
  const [J, setJ] = useState(0);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) return setMissing("not-found");
        if (!r.ok) return setMissing("network");
        setResult((await r.json()) as RunResult);
      })
      .catch(() => !cancelled && setMissing("network"));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const { replay } = run;
  useEffect(() => {
    if (!result) return;
    replay(result, { instant: true });
    setSeq((n) => n + 1);
  }, [result, replay]);

  const onAction = (r: Recovery) => {
    if (r === "recorded") router.push("/");
    else if (r === "retry") window.location.reload();
  };

  if (missing)
    return (
      <main className="page">
        <header className="page-rail">
          <Link className="mark" href="/" aria-label="Untorn, home">
            Un<span className="bar" aria-hidden="true" />
            torn
          </Link>
        </header>
        <div className="page-body nf">
          <ErrorNote code={missing} onAction={onAction} actions={missing === "not-found" ? ["recorded"] : ["retry", "recorded"]} />
        </div>
      </main>
    );

  const sample = result?.sample ? (SAMPLES[result.sample] ?? null) : null;
  const when = result ? new Date(result.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) : "";
  const honesty = (
    <p className="honest">
      {result ? `Replay of ${SOURCE[result.source]}, ${when} UTC${result.caption ? "; simulated tear" : ""}.` : "Loading the run…"}
      <Link href="/#tear">Tear your own</Link>
    </p>
  );
  const photoSrc = sample ? (sample.photo.hires ?? sample.photo.url) : (result?.photo.url ?? null);
  return (
    <main>
      <Hero
        state={run.state}
        mode="replay"
        runKey={`replay-${seq}`}
        sample={sample}
        twins={null}
        reduced={reduced}
        honesty={honesty}
        samplePhoto={!!sample}
        photoAlt={result ? `The photo of ${result.pieces.length} torn pieces this run started from.` : "Loading the run."}
      />
      {result && <ResultSection result={result} photoSrc={photoSrc} J={J} setJ={setJ} />}
    </main>
  );
}
