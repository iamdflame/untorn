# Untorn threat model

Untorn takes a photo of torn paper and returns the rebuilt page and its text. The photo can contain personal data (a letter, a form, a record), and the server spends real model credits on every run. These are the risks and what the code does about each.

## What we protect
1. **People's photos and the text in them.** These may hold names, addresses or private matters.
2. **The model key and the credit balance** behind it (Meta Model API).
3. **Availability during judging,** and the honesty of what the page shows.

## Data handling
- **Retention:** photos, run results and phone sessions are kept in a private Vercel Blob store and deleted after 23 h by an hourly cleanup cron (`/api/cleanup`). Sample runs are static files.
- **No training use.** Photos go only to Meta's Model API (SAM 3.1 and Muse) to run the pipeline. The capture page says so in one line before the camera opens.
- **IP addresses** are never stored in the clear: rate limiting uses salted hashes (`IP_HASH_SALT`).
- **Run links** (`/r/{runId}`) use unguessable ids. Anyone holding a link can view that run until it expires (23 h).

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| Key theft from the browser | The key lives only in server env vars. The browser never talks to the model API. |
| Credit exhaustion (scripted runs) | Per-IP hourly limits on runs and sessions; a global daily spend cap; a per-instance concurrency cap with a bounded queue; at most 120 pieces per photo; request bodies capped at 4.5 MB. |
| Malicious uploads (polyglots, huge images, decompression bombs) | Type sniffed by content, not by extension or MIME header; size caps before decode; images decoded by `sharp` (its default input-pixel limit applies); HEIC converted server-side; any failure returns a designed error. |
| Prompt injection via the photo's own text ("ignore instructions…") | Muse calls use fixed prompts with strict JSON schemas. The text on the paper is data to read, never instructions. Verdicts only choose between geometric candidates the solver proposed, so a hostile page can at worst mislead its own reconstruction, never act. |
| Invented text in the transcript | The page-reading prompt forbids filling gaps: missing paper is marked `[…]`, uncertain words are listed, and the join map shows the evidence for every seam. |
| Cross-session access (guessing a phone code) | 6-character codes expire, and creating codes is rate-limited per IP. |
| Cron endpoints abused | `/api/health/run` and `/api/cleanup` require `CRON_SECRET`. |
| Store enumeration | `/api/files/{key}` serves allow-listed key shapes only. The store is private. |
| Dependency vulnerabilities | Lockfile-pinned. Audit before each release. |

## Known limits
- **Sensitive documents:** anything run through the hosted demo is sent to Meta's API. Archives with sensitive files would need a deployment that meets their own data rules. The open-weight Muse models (Glimmer, Spark Open) make a local deployment possible, but we haven't built one.
- **Rebuilt pages are a reconstruction, not a certified copy.** The join map and the honesty labels are there so a person can check every seam.
