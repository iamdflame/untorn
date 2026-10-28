"use client";

// /r/<runId>: any stored run, replayed with its real timing (a still with reduced motion).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Recovery } from "@/lib/run/errors";
import type { RunResult } from "@/lib/run/types";
import { ErrorPanel } from "./run/panels";
import { RunView, usePrefersReducedMotion } from "./run/RunView";
import { useRun } from "./run/useRun";

export function Permalink({ runId }: { runId: string }) {
  const run = useRun();
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [result, setResult] = useState<RunResult | null>(null);
  const [missing, setMissing] = useState<"not-found" | "network" | null>(null);

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
    if (result) replay(result, { instant: reduced, targetMs: 20_000 });
  }, [result, reduced, replay]);

  const onAction = (r: Recovery) => {
    if (r === "recorded") router.push("/");
    else if (r === "retry") window.location.reload();
  };

  return (
    <main className="permalink">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Untorn
        </Link>
        <nav aria-label="Site">
          <Link href="/#tear">Tear your own</Link>
          <Link href="/accuracy">Accuracy</Link>
        </nav>
      </header>
      {missing ? (
        <ErrorPanel error={{ code: missing, message: "" }} onAction={onAction} actions={missing === "not-found" ? ["recorded"] : ["retry", "recorded"]} />
      ) : !result ? (
        <p role="status">Loading the run…</p>
      ) : (
        <RunView
          run={run}
          onAction={onAction}
          label={
            <div className="run-label">
              <span className="run-label-text">
                Replay of a {result.source === "sample" ? "sample" : result.source === "phone" ? "phone" : result.source === "health" ? "health-check" : "uploaded"} run ·{" "}
                {new Date(result.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
              </span>
              <span className="run-label-actions">
                <button type="button" className="btn" onClick={() => replay(result, { instant: reduced })}>
                  Replay
                </button>
              </span>
            </div>
          }
        />
      )}
    </main>
  );
}
