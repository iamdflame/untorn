// /accuracy: the evidence. Every number is measured and every test set is labelled for what it is. Sources:
// docs/SOLVER.md (Bench-S), docs/MODELS.md (the models), and this sample's recorded run scored against its answer key
// (computed here, the same scoring the health run uses).

import type { Metadata } from "next";
import Link from "next/link";
import key from "../../../data/samples/chouteau-1903/key.json";
import recorded from "../../../public/samples/chouteau-1903/result.json";
import { scoreRun, type AnswerKey } from "@/lib/server/accuracy";
import type { RunResult } from "@/lib/run/types";

export const metadata: Metadata = {
  title: "Accuracy · Untorn",
  description: "How well Untorn puts torn pages back together: the benchmark, the stack-tear test, the models, this sample's recorded run, and where it fails.",
};

type Row = (string | number)[];

function Table({ caption, head, rows, note }: { caption: string; head: string[]; rows: Row[]; note?: string }) {
  return (
    <figure className="eval-table">
      <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
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
      {note && <figcaption>{note}</figcaption>}
    </figure>
  );
}

function Section({ id, title, label, children, intro }: { id: string; title: string; label: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="acc-sec" id={id} aria-labelledby={`${id}-t`}>
      <div>
        <h2 id={`${id}-t`}>{title}</h2>
        <span className="label">{label}</span>
      </div>
      <div>
        {intro && <p>{intro}</p>}
        {children}
      </div>
    </section>
  );
}

export default function AccuracyPage() {
  const run = recorded as unknown as RunResult;
  const score = scoreRun(run, key as unknown as AnswerKey);
  const placed = run.pages.reduce((n, p) => n + p.pieces.length, 0);
  const reads = run.joins.filter((j) => j.read?.agrees === true).length;
  return (
    <main className="page">
      <header className="page-rail">
        <Link className="mark" href="/" aria-label="Untorn, home">
          Un<span className="bar" aria-hidden="true" />
          torn
        </Link>
        <nav aria-label="Site">
          <Link href="/#tear">Tear your own</Link>
          <Link href="/accuracy" aria-current="page">
            Accuracy
          </Link>
        </nav>
      </header>
      <div className="page-body">
        <div className="acc-top">
          <div>
            <h1>How accurate is it?</h1>
            <p className="lede">Every number here was measured, and every test set says what it is. Simulated tears have known answers. One real hand-torn page has been scored so far, against a photo of it taken before it was torn.</p>
          </div>
          <dl className="acc-keys">
            <div>
              <dt>Pieces placed correctly, shape only</dt>
              <dd>
                99.5%
                <small>218 pieces, single pages of 8 to 12 pieces (Bench-S, simulated)</small>
              </dd>
            </div>
            <div>
              <dt>Pieces misplaced by shape</dt>
              <dd>
                0
                <small>of 938 pieces across all six simulated families</small>
              </dd>
            </div>
            <div>
              <dt>Seams Muse judged right</dt>
              <dd>
                23 of 24
                <small>12 true and 12 adversarial seams (cw1)</small>
              </dd>
            </div>
            <div>
              <dt>This sample, recorded run</dt>
              <dd>
                {score.placedCorrectly} of {score.pieces}
                <small>
                  pieces placed correctly; {score.correctJoins} of {score.joins} joins right
                </small>
              </dd>
            </div>
          </dl>
        </div>

        <Section id="benchmark" title="Benchmark: simulated tears" label="Simulated (Bench-S)" intro="14 real public-domain pages (typed, printed and handwritten; English and German), torn by a simulator calibrated to real tears, with SAM-like outline noise. Fixed seeds, disjoint from the cases used for tuning.">
          <Table
            caption="Shape only (no reading)"
            head={["Family", "Cases", "Pieces", "Placed correctly", "Misplaced", "Join precision", "Perfect pages"]}
            rows={[
              ["Single page, 8–12 pieces", 24, 218, "99.5%", 0, "100%", "23 of 24"],
              ["Single page, 6–7 pieces", 6, 40, "100%", 0, "100%", "6 of 6"],
              ["Single page, 26–38 pieces", 8, 271, "99.3%", 0, "100%", "6 of 8"],
              ["Mixed bag, 2–3 pages", 8, 160, "98.1%", 0, "100%", "17 of 20"],
              ["35% straight cuts", 6, 57, "87.7%", 0, "100%", "4 of 6"],
              ["Stack, 3 pages × 6–10", 8, 192, "0%: every twin left for reading", 0, "–", "0 of 24"],
            ]}
            note="Placed correctly: within 3 px and 1° of the truth, up to one rigid move per page. Measured on the deployed solver (scripts/eval/solver.ts), 30 Oct 2026."
          />
          <Table
            caption="Shape alone, and shape with reading"
            head={["Method", "Placed correctly", "Misplaced"]}
            rows={[
              ["Shape only, single pages", "99.5%", 0],
              ["Shape + a reader right 90% of the time, single pages", "99.5%", 0],
              ["Shape + a reader right 90% of the time, mixed bags", "98.1%", 0],
              ["Reading only", "not measured", "–"],
            ]}
            note="On ordinary tears the shape already decides; reading is what decides stacks (below). The simulated reader errs at a set rate on every request."
          />
        </Section>

        <Section id="stack" title="Stack tears: identical outlines" label="Simulated" intro="Pages torn together share every outline, so shape is a tie. Only reading across the tear can tell the twins apart.">
          <Table
            caption="3 pages × 6–10 pieces, 8 cases, 192 pieces"
            head={["Reader", "Placed correctly", "Misplaced", "Perfect pages"]}
            rows={[
              ["None (shape only)", "0%: every twin left for reading", 0, "0 of 24"],
              ["Simulated reader, right 100% of the time", "99.5%", 0, "23 of 24"],
              ["Simulated reader, right 90% of the time", "96.4%", 0, "19 of 24"],
              ["Simulated reader, right 82% of the time", "89.1%", "2 (1.0%)", "15 of 24"],
            ]}
            note="Shape alone flags 85.4% of the twin seams as ties for reading. The live recording of three real letters torn as one stack: 22 of 22 readings picked the right piece. Pixel appearance alone ranks the true twin first in 48% of twin groups (chance is about 33%)."
          />
        </Section>

        <Section id="models" title="The models, measured" label="Simulated tears, real model calls">
          <Table
            caption="SAM 3.1 outlines and Muse Spark reads"
            head={["Test", "Result", "Latency"]}
            rows={[
              ["SAM 3.1: pieces found (9 photos, 104 pieces)", "100%, no extras", "1.9–7.1 s per photo"],
              ["SAM 3.1: median outline error, 12 pieces", "0.46 px", "one call"],
              ["SAM 3.1: ShredBench renders (5 photos)", "40 of 40 pieces found", "5.1–7.1 s"],
              ["Muse Spark: is this seam a join? (24 seams, half adversarial)", "23 of 24", "median 9.3 s"],
              ["Muse Spark: which twin continues? (12 stack sheets)", "12 of 12", "median 6.9 s"],
            ]}
            note="Source: docs/MODELS.md."
          />
        </Section>

        <Section id="live" title="This sample, recorded" label="Recorded run of the live pipeline" intro="The letter on the first screen: a simulated tear of a real 1903 letter, 10 pieces, run once through the whole live pipeline and scored against the tear's answer key. A health check reruns it every 3 hours.">
          <Table
            caption="The recording the first screen plays"
            head={["Pieces placed correctly", "Joins right", "Joins confirmed by reading", "Photo to page", "Model cost"]}
            rows={[[`${score.placedCorrectly} of ${score.pieces}`, `${score.correctJoins} of ${score.joins}`, `${reads} of ${run.joins.length}`, `${(run.timings.total / 1000).toFixed(1)} s`, `$${run.cost.usd.toFixed(2)}`]]}
            note={`${placed} pieces on one page. The other joins rest on the edge: little text crosses those tears. Live status: /api/health.`}
          />
        </Section>

        <Section id="real" title="Real tears" label="Measured: 1 page" intro="Hand-torn paper photographed on a table with a phone, scored against a photo of the page taken before tearing: each piece's printing is registered on the intact page, which gives every piece its true place.">
          <Table
            caption="Real tears (Bench-R), the whole live pipeline"
            head={["Page", "Pieces", "Placed correctly", "Joins right", "Transcript errors"]}
            rows={[["A printed report page, torn by hand", 10, "8 of 10; 2 set aside, 0 misplaced", "8 of 9", "11.6% of characters"]]}
            note="Run on 30 Oct 2026 with the deployed solver. Before the real-paper work, the same photo had 0 of 10 placed correctly and 77–88% transcript errors. The page's text is not shown here."
          />
        </Section>

        <Section id="method" title="Method" label="How a page comes back">
          <ol>
            <li>SAM 3.1 outlines every piece in one call; each outline is snapped to the paper&apos;s edge at full resolution.</li>
            <li>Torn edges are matched by shape: candidate joins where two edges are mirror images.</li>
            <li>Muse Spark reads across each plausible seam. Where shapes tie (stack tears), it picks which twin continues the words.</li>
            <li>A join is accepted only when the shape fits and the reading agrees, or when reading breaks a tie. Nothing is forced; pieces that fit nowhere stay unplaced.</li>
            <li>Muse transcribes the rebuilt page. Gaps stay gaps: nothing is written that isn&apos;t on the paper.</li>
          </ol>
        </Section>

        <Section id="failures" title="Where it fails" label="Known weaknesses">
          <ul>
            <li>Straight cuts give little shape to match: 87.7% placed on pages with 35% straight cuts.</li>
            <li>Blank pieces can only be placed by shape.</li>
            <li>Stacks need many reads: a median of about 95 choice sheets for a 3-page stack.</li>
            <li>Real hand-torn paper is harder than our simulations: fibrous rims, curl and a tilted camera cost 2 of 10 pieces on the one real page measured so far.</li>
            <li>On real paper a rebuilt page has come out upside down; the fix is in progress.</li>
          </ul>
        </Section>
      </div>
    </main>
  );
}
