# Untorn HTTP API

All routes live under `/api` on the deployed app. JSON in and out, unless noted. Errors are always `{ "error": { "code", "message" } }` with a matching HTTP status, never a stack trace. The model key (`MODEL_API_KEY`) stays on the server.

## `POST /api/runs`: rebuild a torn page (streaming)
Runs the full pipeline: SAM 3.1 segmentation → edge matching → Muse reads across candidate seams → assembly → Muse reads the page.

**Body:** one of
- `multipart/form-data` with `photo` (JPEG, PNG or HEIC; up to 15 MB before the browser downsizes it, and Vercel accepts request bodies up to 4.5 MB);
- `{ "photoId": "<id>" }`, a photo already uploaded from a phone session;
- `{ "sample": "<sampleId>" }`, the first screen's sample photo.

Optional, with any of these: `reader: "open"` (a form field, or a JSON key) sends every read, the transcript and the
record to Muse Spark Open, Meta's open weights; the server answers `bad-type` when it has no open-weights host
(`BASETEN_API_KEY`). A read that host turns away for our account (no credit left there, say) goes to Muse Spark,
and the run warns `open-refused` with how many reads Muse Spark gave. Without it, Muse Spark reads first and Muse
Spark Open answers the reads it is slow on.

**Response:** `application/x-ndjson`, one `RunEvent` per line, in order (types in `src/lib/run/types.ts`):

| Event | Meaning |
|---|---|
| `queued` | waiting for a slot on this instance (`position`) |
| `start` | the run id, its source, an optional caption |
| `photo` | the stored photo URL and its size |
| `stage` | a stage became active or finished (`segment`, `match`, `read`, `assemble`, `transcribe`), with its duration |
| `segment` | every piece SAM 3.1 found: outline, box, confidence |
| `match` | candidate joins from edge geometry, and the questions that will go to Muse |
| `read` | one Muse answer as it lands: the seam image it read, its verdict, confidence, the words read across the tear, its reason and the model that gave it (`muse-spark-1.3` or `muse-spark-open`) |
| `assemble` | pages with each piece's pose, the accepted joins (with which clue decided), unplaced pieces |
| `transcribe` | Muse's reading of each rebuilt page, with gaps marked `[…]` and uncertain words listed |
| `warning` | a non-fatal problem (e.g. blur), with what to do |
| `tick` | keep-alive |
| `done` | the full `RunResult` |
| `catalog` | after `done`: each transcribed page's archive record by Muse Wonder, first `pending`, then `done` (only the fields whose quotes are on the page, and how many were left out) or `failed`; the stored run is rewritten with them (`catalogs`) |
| `error` | a designed error code and a plain message |

**Limits** (env-configurable): runs per IP per hour (`RUNS_PER_IP_PER_HOUR`, default 12) and per UTC day (`RUNS_PER_IP_PER_DAY`, default 6), a daily model-spend cap across all runs (`DAILY_SPEND_CAP_USD`; by default $4 a day on the judging days, 4–9 Nov 2026, and $1.50 on other days, so the remaining model credit lasts to 10 Nov), concurrent pipelines per instance (`MAX_CONCURRENT_RUNS`, default 4) with a queue (`MAX_QUEUE`, default 12), and at most 120 pieces per photo. `maxDuration` is 300 s.

**Example:**
```bash
curl -N -X POST https://untorn.vercel.app/api/runs \
  -H 'content-type: application/json' -d '{"sample":"chouteau-1903"}'
```

## `POST /api/notes`: a spoken provenance note
Muse Voice Transcribe writes down a short spoken note (where a page was found) for its archive record. The page keeps
the note and writes it into the record's downloads; the server stores neither the audio nor the text.

**Body:** `multipart/form-data` with `audio`: a mono 16-bit PCM WAV at 16 or 24 kHz, at most a minute (the browser
records, then converts). **Response:** `{ text, audioMs, ms, costUsd, model }`. **Limits:** notes per IP per hour
(`NOTES_PER_IP_PER_HOUR`, default 20); notes count towards the daily spend cap (about $0.003 a minute) but never
towards a visitor's live runs.

## `GET /api/runs/{runId}`: a stored run
Returns the stored result of a finished run (the same data `/r/{runId}` replays). `404` if unknown or expired.

## Phone handoff
- **`POST /api/sessions`**: creates a 6-character code and returns `{ code, url, … }`. The laptop shows `url` as a QR code. Rate-limited per IP (`SESSIONS_PER_IP_PER_HOUR`, default 30).
- **`GET /api/sessions/{code}`**: returns `{ status: "waiting" | "photo" | "expired", photoId? }`. The laptop polls it every 1.5 s.
- **`POST /api/sessions/{code}/photo`** (multipart `photo`): the phone's capture page uploads here. Returns `{ ok: true }`.

## `GET /api/files/{key}`
Serves stored run images (photos, seam crops) from the private store, by allow-listed key only.

## Health and housekeeping
- **`GET /api/health`**: how live runs go (`live`: `ok`; or, when Meta's model API refused our key, `open-weights` (runs outlined by the paper finder and read by Muse Spark Open) or `outlines-only` (placed by their edges alone), with `pausedSince`; `openWeights`: whether the open-weights host is set up and hasn't turned our key away in the last 13 hours, or has answered since; the first screen shows the switch only then), and the last successful sample run, its accuracy against the answer key and its age. With `?warm`, it returns `{ ok: true, live, openWeights }` (a warm-up ping the first screen sends; on `paused` the page says so before anyone tears a page).
- **`GET|POST /api/health/run`**: runs the fixed sample through the full pipeline and scores it against its answer key. Cron only (`CRON_SECRET`); `200` when it passes, `503` when it doesn't.
- **`GET /api/cleanup`**: deletes uploaded photos, runs and phone sessions older than 23 h, and old ledger and health records. Cron only.
