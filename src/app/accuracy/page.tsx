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

/** Whether this deployment reads with Meta's open weights (src/lib/server/live.ts: the host's key, not set aside). */
const OPEN_WEIGHTS_LIVE = Boolean(process.env.BASETEN_API_KEY) && process.env.OPEN_WEIGHTS !== "off";

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
            <p className="lede">Every number here was measured, and every test set says what it is. Simulated tears have known answers. Two real hand-torn pages have been scored so far, each against a photo of it taken before it was torn.</p>
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
              <dt>Text errors on shredded documents</dt>
              <dd>
                0.050
                <small>NED on 64 documents (ShredBench protocol, our replica); Muse Spark alone on the same photos: 0.404</small>
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

        <Section
          id="shredbench"
          title="Shredded documents: Untorn against one model alone"
          label="ShredBench protocol"
          intro="ShredBench (ACL Findings 2026) scores a model that reads a photo of scattered fragments and writes out the document, by normalised edit distance (NED, lower is better). We gave Muse Spark the same photos with the benchmark's own prompt, and ran Untorn (the same Muse Spark with SAM 3.1 and the solver) on them."
        >
          <Table
            caption="Text errors (NED) of the rebuilt document"
            head={["Set", "Documents", "Untorn", "Shape only, no reads", "Muse Spark alone"]}
            rows={[
              ["ShredBench's own images with published answers (English news, 8 pieces)", 3, "0.002", "0.063", "0.528"],
              ["Replica, 8 pieces (news, Chinese news, code, tables)", 64, "0.050", "0.074", "0.404"],
              ["Replica, 12 pieces", 32, "0.050", "–", "0.436"],
              ["Replica, 16 pieces", 32, "0.077", "–", "0.469"],
            ]}
            note="Only 3 of ShredBench's published renders come with ground truth, so the broad test is our own re-implementation of its protocol (fragments composited in 2D, no 3D render), labelled as a replica. SAM 3.1 found all 2,592 replica pieces. The paper's frontier results (Gemini 3 Pro 0.33–0.41) are on its full set, not these images. Repeated reads of the 3 official images vary between 0.002 and 0.006 on average. Method, caveats and failure cases: docs/SHREDBENCH.md."
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

        <Section
          id="record"
          title="The archive record"
          label="Recorded transcripts, real model calls"
          intro="After a page is rebuilt, Muse Wonder catalogues it from its transcript: kind, date, place, sender, recipient, and the names it mentions. Every name and date must quote the transcript; the app checks each quote and leaves out any that isn't there. Scored against an answer key read off 7 sample pages: five letters, a page from the middle of a letter, and a printed page with no sender or date."
        >
          <Table
            caption="Archive records against the answer key"
            head={["Model, effort", "Field checks right", "Quotes not on the page", "Names found", "Median time"]}
            rows={[
              ["Muse Wonder, minimal (in the app), 4 rounds", "108 of 112", "0", "102 of 104", "6–7 s"],
              ["Muse Spark 1.3, minimal, 3 rounds", "83 of 84", "1, left out by the check", "75 of 78", "10–11 s"],
            ]}
            note="Field checks: kind, date, place, sender, recipient. Wonder's repeated miss calls the mid-letter page “other”. Source: docs/MODELS.md and scripts/eval/catalog.ts."
          />
        </Section>

        <Section
          id="open-weights"
          title="Meta’s open weights"
          label="Real model calls: simulated seams, sample pages, real tears"
          intro={
            OPEN_WEIGHTS_LIVE
              ? "Muse Spark Open is Meta’s open-weights Muse Spark, served here by Baseten. It gets the same questions as Muse Spark, with the same prompts. The site asks Muse Spark first and Muse Spark Open when a read is slow; the switch “Read on open weights only” sends every read, the transcript and the record to it. Both run while Baseten takes our key: while it turns the key away, the switch is hidden and Muse Spark reads alone, and each read names the model that gave it."
              : "Muse Spark Open is Meta’s open-weights Muse Spark, served by Baseten. It gets the same questions as Muse Spark, with the same prompts. These runs used the site’s code on our machine; this deployment of the site reads on Meta’s API alone until its open-weights host is set up."
          }
        >
          <Table
            caption="The same tests, one run each (3 Nov 2026)"
            head={["Test", "Muse Spark Open", "Muse Spark 1.3"]}
            rows={[
              ["Seam reads, 24 simulated seams (half true)", "23 of 24", "22 of 24"],
              ["Stacks, 12 choices between identical outlines", "11 of 12", "12 of 12"],
              ["Transcripts of 5 rebuilt pages, mean character errors", "2.4%", "2.6%"],
              ["Median time per call", "10.4 s", "15.5 s"],
            ]}
            note="On the real 10-piece tear’s seams, over 10 runs: Muse Spark Open never called a wrong neighbour the same place (0 of 63 reads), and turned down true ones somewhat more often than Muse Spark. Source: docs/MODELS.md, scripts/eval/open-weights.ts and scripts/eval/real-reads.ts."
          />
          <Table
            caption="The whole pipeline, run with each choice of readers on the same photos (our machine, the site’s code)"
            head={["Readers", "6-piece real tear: whole page", "10-piece real tear (pieces touching): placed correctly"]}
            rows={[
              ["Muse Spark alone (until now)", "2 of 3 runs, 60–65 s", "6, 7, 7, 9 of 10; 2 misplaced in 4 runs"],
              ["Muse Spark, open weights for slow reads (now)", "3 of 3 runs, 53–59 s", "5, 8, 5, 6, 8 of 10; 6 misplaced in 5 runs"],
              ["Open weights first, Muse Spark for slow reads", "1 of 3 runs, 45–53 s", "5, 6, 9 of 10; 2 misplaced in 3 runs"],
              ["Open weights only (the switch)", "1 of 1 run, 63 s", "not run"],
            ]}
            note="Each cell is 1 to 5 runs, so a difference of one run is within the noise. On the 10-piece photo every choice varies; most misplaced pieces are true neighbours set a few pixels or degrees off on curled paper, confirmed by both models in proportion to the reads each gave. Every read on the open weights also rebuilt the 1927 letter 10 of 10 and the German letter 9 of 10, none misplaced. Two runs that lost their reads to our machine’s connection are left out."
          />
        </Section>

        <Section id="live" title="The health-check letter, recorded" label="Recorded run of the live pipeline" intro="A simulated tear of a real 1903 letter, 10 pieces, run once through the whole live pipeline and scored against the tear's answer key. The health check reruns it on the live site every 12 hours.">
          <Table
            caption="The recorded run, scored against the answer key"
            head={["Pieces placed correctly", "Joins right", "Joins confirmed by reading", "Photo to page", "Model cost"]}
            rows={[[`${score.placedCorrectly} of ${score.pieces}`, `${score.correctJoins} of ${score.joins}`, `${reads} of ${run.joins.length}`, `${(run.timings.total / 1000).toFixed(1)} s`, `$${run.cost.usd.toFixed(2)}`]]}
            note={`${placed} pieces on one page. The other joins rest on the edge: little text crosses those tears. Live status: /api/health.`}
          />
        </Section>

        <Section id="real" title="Real tears" label="Measured: 3 pages" intro="Hand-torn paper photographed on a table with a phone. Pages 1 and 2 are scored against a photo of the page taken before tearing: each piece's printing is registered on the intact page, which gives every piece its true place. Page 3 has no such photo, so it is judged by whether the whole page comes back and reads straight across every tear.">
          <Table
            caption="Page 3: a printed report page, torn by hand into 6 pieces, laid apart and photographed from above (live site, 1 Nov 2026)"
            head={["Run", "How it arrived", "Pieces on one page", "Photo to page"]}
            rows={[
              [1, "upload", "6 of 6", "56.1 s"],
              [2, "upload", "6 of 6", "51.8 s"],
              [3, "upload", "6 of 6", "47.9 s"],
              [4, "upload (fresh browser)", "6 of 6", "51.3 s"],
              [5, "sent from a phone (QR code)", "6 of 6", "60.8 s"],
            ]}
            note="Every page read line by line against the photo: each line continues straight across every tear. The two halves of this page meet along a tear that runs in the gap between two text lines, so no letter is cut there and a reading has nothing to go on; the page's own border joins them (its straight edges line up only when the halves are placed right). Earlier versions on this photo: two groups (4 + 2) or one piece set aside in 3 of 4 runs. The page's text is not shown here."
          />
          <Table
            caption="Page 1: a printed report page, torn by hand into 10 pieces and photographed with several pieces touching (current version, 1 Nov 2026, the live site's code run on our machine)"
            head={["Run", "Placed correctly", "Misplaced", "Set aside", "Page upright", "Photo to page"]}
            rows={[
              [1, "8 of 10", 0, 2, "yes", "52.2 s"],
              [2, "7 of 10", "1 (a true neighbour, just past the tolerance)", 2, "yes", "47.9 s"],
              [3, "6 of 10", "1 (the same)", 3, "yes", "55.3 s"],
            ]}
            note="Pieces that aren't placed are set aside, never forced. A misplaced piece here is its true neighbour set just past the tolerance (1.5% of the page width, 39 px; 2°). The pieces left out lie against the middle piece in this photo: where pieces touch, their torn edges can't be seen whole, and the run says so. Results vary between runs: SAM's outlines and Muse's reads differ a little each time. Earlier versions, on the live site: 6, 9 and 6 of 10 (31 Oct); 8, 8 and 8; 9, 7, 9 and 9 (63–85 s a run); and, before the real-paper work, 0 of 10. The page's text is not shown here."
          />
          <Table
            caption="Page 2: another page of the same report, torn into 10 small pieces laid apart, photographed 11.6° off straight down (current version, 1 Nov 2026, the live site's code run on our machine)"
            head={["Run", "Placed correctly", "Misplaced", "Set aside", "Photo to page"]}
            rows={[
              [1, "5 of 10", 2, 3, "53.9 s"],
              [2, "4 of 10", 1, 5, "49.1 s"],
              [3, "2 of 10", 3, 5, "67.4 s"],
            ]}
            note="The hardest page we have: small pieces that curl. The phone recorded its tilt in the photo, and every run straightens it first (as taken, the far pieces' text lines were 63 px apart and the near ones' 90 px). Every run now keeps the placed pieces on one page; on 31 Oct (3, 3 and 4 of 10) the page split into fragments. The misplacements are true neighbours set a little off: a curled piece bends its own edge and lines, so on a short seam it can land turned a few degrees. The blank corner piece can only be placed by shape. The page's text is not shown here."
          />
        </Section>

        <Section id="method" title="Method" label="How a page comes back">
          <ol>
            <li>SAM 3.1 outlines every piece in one call; each outline is snapped to the paper&apos;s edge at full resolution.</li>
            <li>Torn edges are matched by shape: candidate joins where two edges are mirror images.</li>
            <li>Muse Spark reads across each plausible seam. Where shapes tie (stack tears), it picks which twin continues the words.</li>
            <li>A join needs two clues that agree: the shape fits and the reading agrees, or reading breaks a tie. Where no letters cross a tear, the second clue is the page itself: text lines that run on in step, or, between two halves of a page, its straight border lining up. Nothing is forced; pieces that fit nowhere stay unplaced.</li>
            <li>Muse transcribes the rebuilt page. Gaps stay gaps: nothing is written that isn&apos;t on the paper.</li>
          </ol>
        </Section>

        <Section id="failures" title="Where it fails" label="Known weaknesses">
          <ul>
            <li>Straight cuts give little shape to match: 87.7% placed on pages with 35% straight cuts.</li>
            <li>Blank pieces can only be placed by shape.</li>
            <li>Stacks need many reads: a median of about 95 choice sheets for a 3-page stack.</li>
            <li>Real hand-torn paper is harder than our simulations. A page torn into 6 pieces came back whole in 5 of 5 live runs; pages torn into 10 small pieces, with curl and pieces touching, put 6 to 8 and 2 to 5 of 10 in the right place. The rest are set aside, and some runs set a piece just past the tolerance or turned on a short seam.</li>
            <li>A curled piece bends its own edges and text lines. On a short seam the reading can&apos;t see a turn of a few degrees, so the piece can land turned.</li>
            <li>Pieces that touch in the photo lose the edges between them; so do photos shrunk by a messaging app (the same page at 1920 px: 5 of 10).</li>
            <li>A live run on a real photo takes 45–65 s; most of it is Muse reading across the tears.</li>
          </ul>
        </Section>
      </div>
    </main>
  );
}
