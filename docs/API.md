# Untorn HTTP API

All routes live under `/api` on the deployed app. JSON in and out, unless noted. Errors are always `{ "error": { "code", "message" } }` with a matching HTTP status, never a stack trace. The model key (`MODEL_API_KEY`) stays on the server.

## `POST /api/runs`: rebuild a torn page (streaming)
Runs the full pipeline: SAM 3.1 segmentation → edge matching → Muse reads across candidate seams → assembly → Muse reads the page.

**Body:** one of
- `multipart/form-data` with `photo` (JPEG, PNG or HEIC; up to 15 MB before the browser downsizes it, and Vercel accepts request bodies up to 4.5 MB);
- `{ "photoId": "<id>" }`, a photo already uploaded from a phone session;
- `{ "sample": "<sampleId>" }`, the first screen's sample photo.

**Response:** `application/x-ndjson`, one `RunEvent` per line, in order (types in `src/lib/run/types.ts`):

| Event | Meaning |
|---|---|
| `queued` | waiting for a slot on this instance (`position`) |
| `start` | the run id, its source, an optional caption |
| `photo` | the stored photo URL and its size |
| `stage` | a stage became active or finished (`segment`, `match`, `read`, `assemble`, `transcribe`), with its duration |
| `segment` | every piece SAM 3.1 found: outline, box, confidence |
| `match` | candidate joins from edge geometry, and the questions that will go to Muse |
| `read` | one Muse answer as it lands: the seam image it read, its verdict, confidence, the words read across the tear and its reason |
| `assemble` | pages with each piece's pose, the accepted joins (with which clue decided), unplaced pieces |
| `transcribe` | Muse's reading of each rebuilt page, with gaps marked `[…]` and uncertain words listed |
| `warning` | a non-fatal problem (e.g. blur), with what to do |
| `tick` | keep-alive |
| `done` | the full `RunResult` |
| `error` | a designed error code and a plain message |

**Limits** (env-configurable): runs per IP per hour (`RUNS_PER_IP_PER_HOUR`, default 12) and per UTC day (`RUNS_PER_IP_PER_DAY`, default 6), a daily model-spend cap across all runs (`DAILY_SPEND_CAP_USD`; by default $4 a day on the judging days, 4–9 Nov 2026, and $1.50 on other days, so the remaining model credit lasts to 10 Nov), concurrent pipelines per instance (`MAX_CONCURRENT_RUNS`, default 4) with a queue (`MAX_QUEUE`, default 12), and at most 120 pieces per photo. `maxDuration` is 300 s.

**Example:**
```bash
curl -N -X POST https://untorn.vercel.app/api/runs \
  -H 'content-type: application/json' -d '{"sample":"chouteau-1903"}'
```

## `GET /api/runs/{runId}`: a stored run
Returns the stored result of a finished run (the same data `/r/{runId}` replays). `404` if unknown or expired.

## Phone handoff
- **`POST /api/sessions`**: creates a 6-character code and returns `{ code, url, … }`. The laptop shows `url` as a QR code. Rate-limited per IP (`SESSIONS_PER_IP_PER_HOUR`, default 30).
- **`GET /api/sessions/{code}`**: returns `{ status: "waiting" | "photo" | "expired", photoId? }`. The laptop polls it every 1.5 s.
- **`POST /api/sessions/{code}/photo`** (multipart `photo`): the phone's capture page uploads here. Returns `{ ok: true }`.

## `GET /api/files/{key}`
Serves stored run images (photos, seam crops) from the private store, by allow-listed key only.

## Health and housekeeping
- **`GET /api/health`**: whether live runs can start (`live`: `ok`, or `paused` with `pausedSince` when Meta's model API refused our key), and the last successful sample run, its accuracy against the answer key and its age. With `?warm`, it returns `{ ok: true, live }` (a warm-up ping the first screen sends; on `paused` the page says so before anyone tears a page).
- **`GET|POST /api/health/run`**: runs the fixed sample through the full pipeline and scores it against its answer key. Cron only (`CRON_SECRET`); `200` when it passes, `503` when it doesn't.
- **`GET /api/cleanup`**: deletes uploaded photos, runs and phone sessions older than 23 h, and old ledger and health records. Cron only.
