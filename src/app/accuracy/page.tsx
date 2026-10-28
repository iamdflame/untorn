// /accuracy: the evidence. Sections mirror docs/EVALS.md; the tables hold the numbers measured so far (all on
// simulated tears, labelled), and are refilled from docs/EVALS.md as the evals land.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accuracy · Untorn",
  description: "How well Untorn puts torn pages back together: the benchmark, the stack-tear test, real tears and the method.",
};

type Row = (string | number)[];

function Table({ caption, head, rows, note }: { caption: string; head: string[]; rows: Row[]; note?: string }) {
  return (
    <figure className="eval-table">
      <div className="table-wrap">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <figcaption className="muted small">{note}</figcaption>}
    </figure>
  );
}

export default function AccuracyPage() {
  return (
    <main className="plain-page accuracy">
      <header className="site-header">
        <Link href="/" className="wordmark">
          Untorn
        </Link>
        <nav aria-label="Site">
          <Link href="/#tear">Tear your own</Link>
          <Link href="/accuracy" aria-current="page">
            Accuracy
          </Link>
        </nav>
      </header>
      <h1>How accurate is it?</h1>
      <p className="lede">
        Every number here was measured, and every test set is labelled for what it is. Simulated tears have known answers; real tears are checked against a photo of the page taken before it was torn.
      </p>

      <section id="benchmark" aria-labelledby="b-title">
        <h2 id="b-title">Benchmark: simulated tears (Bench-S)</h2>
        <p>14 real public-domain pages (typed, printed and handwritten; English and German), torn by a simulator calibrated to real tears, with SAM-like outline noise. Held-out seeds.</p>
        <Table
          caption="Shape only (no reading)"
          head={["Family", "Cases", "Pieces", "Placed correctly", "Misplaced", "Join precision", "Perfect pages"]}
          rows={[
            ["Single page, 8–12 pieces", 24, 218, "97.2%", 0, "100%", "22 of 24"],
            ["Single page, 26–38 pieces", 8, 271, "100%", 0, "100%", "8 of 8"],
            ["Mixed bag, 2–3 pages", 8, 160, "99.4%", 0, "100%", "19 of 20"],
            ["35% straight cuts", 6, 57, "87.7%", 0, "100%", "4 of 6"],
          ]}
          note="Placed correctly: within 3 px and 1° of the truth, up to one rigid move per page. Source: docs/SOLVER.md."
        />
        <Table
          caption="Shape only vs reading only vs both"
          head={["Method", "Placed correctly", "Join precision"]}
          rows={[
            ["Shape only", "97.2% (single pages)", "100%"],
            ["Reading only", "to be measured", "to be measured"],
            ["Both (Untorn)", "96.3% with a simulated reader that is right 90% of the time", "100%"],
          ]}
          note="The live reader's own accuracy is below; the full three-way table is filled from docs/EVALS.md."
        />
      </section>

      <section id="stack" aria-labelledby="s-title">
        <h2 id="s-title">Stack tears: identical outlines</h2>
        <p>Three pages torn together share every outline, so shape is a tie. Only reading across the tear can tell the twins apart.</p>
        <Table
          caption="3 pages × 6–10 pieces, 8 cases"
          head={["Reader", "Placed correctly", "Misplaced", "Choice sheets per case"]}
          rows={[
            ["None (shape only)", "0%: every twin left for reading", 0, "–"],
            ["Simulated reader, 90% right", "92.2%", 0, "median 95"],
            ["Muse Spark, k-way picks (12 trials)", "12 of 12 picks right", "–", "–"],
          ]}
        />
      </section>

      <section id="models" aria-labelledby="m-title">
        <h2 id="m-title">The models, measured</h2>
        <Table
          caption="SAM 3.1 outlines and Muse Spark reads (simulated tears)"
          head={["Test", "Result", "Latency"]}
          rows={[
            ["SAM 3.1: pieces found (9 photos, 104 pieces)", "100%, no extras", "1.9–7.1 s per photo"],
            ["SAM 3.1: median outline error, 12 pieces", "0.46 px", "one call"],
            ["Muse Spark: is this seam a join? (24 seams)", "23 of 24", "median 9.3 s"],
            ["Muse Spark: which twin continues? (12 sheets)", "12 of 12", "median 6.9 s"],
          ]}
          note="Source: docs/MODELS.md."
        />
      </section>

      <section id="real" aria-labelledby="r-title">
        <h2 id="r-title">Real tears</h2>
        <p>Hand-torn paper photographed on a table, scored against a photo of each page taken before tearing. No real tears have been scored yet; this table is filled from docs/EVALS.md when they are.</p>
        <Table caption="Real tears (Bench-R)" head={["Page", "Pieces", "Placed correctly", "Joins right", "Transcript CER"]} rows={[["–", "–", "–", "–", "–"]]} />
      </section>

      <section id="live" aria-labelledby="l-title">
        <h2 id="l-title">This sample, live</h2>
        <p>The letter on the first screen (a simulated tear of a real 1903 letter, 10 pieces) through the whole live pipeline. An hourly health check reruns it and asserts the join accuracy.</p>
        <Table
          caption="Recorded run"
          head={["Pieces placed", "Joins right", "Time", "Model cost"]}
          rows={[["9 of 10 (8 correctly)", "12 of 13", "40.8 s", "$0.14"]]}
          note="Live status: /api/health."
        />
      </section>

      <section id="method" aria-labelledby="h-title">
        <h2 id="h-title">Method</h2>
        <ol>
          <li>SAM 3.1 outlines every piece in one call; each outline is snapped to the paper&apos;s edge at full resolution.</li>
          <li>Torn edges are matched by shape: candidate joins where two edges are mirror images.</li>
          <li>Muse Spark reads across each plausible seam. Where shapes tie (stack tears), it picks which twin continues the words.</li>
          <li>A join is accepted only when the shape fits and the reading agrees, or when reading breaks a tie. Nothing is forced; pieces that fit nowhere stay unplaced.</li>
          <li>Muse transcribes the rebuilt page. Gaps stay gaps: nothing is written that isn&apos;t on the paper.</li>
        </ol>
      </section>

      <section id="failures" aria-labelledby="f-title">
        <h2 id="f-title">Where it fails</h2>
        <ul>
          <li>Straight cuts give little shape to match: 87.7% placed on pages with 35% straight cuts.</li>
          <li>Blank pieces can only be placed by shape.</li>
          <li>Real hand-torn paper (fibres, curl, glare) is not yet measured.</li>
        </ul>
      </section>
    </main>
  );
}
