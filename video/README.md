# Untorn · demo film (Remotion)

The demo film for Untorn, built from captures of the real product. Everything here is its own project: it has its
own `package.json` and is excluded from the app's typecheck, lint, tests, install and deploys.

| Output (in `out/`, gitignored) | Composition | What |
|---|---|---|
| `untorn-demo.mp4` | `UntornDemo` | The film: 1920x1080, 30 fps, 2:07.6, H.264 + AAC 320k, about -14 LUFS |
| `untorn-demo.srt` | | Captions (the narration, timed from the voice's own alignment) |
| `thumbnail.png` | `Thumbnail` | 1280x720 still: the letter whole again, a read in the loupe, the wordmark |
| `untorn-backup.mp4` | `Backup` | The insurance cut: a plain captioned walkthrough from the same captures, 1:17, quiet score |
| `contact.png` | | One frame every 4 s of the film, for review |

## Setup

```sh
cd video
pnpm install                         # Remotion 4.0.539, Playwright (drives the installed Chrome), sharp, tsx
node scripts/assets/kit.mjs          # rebuilds public/kit/ (cut-outs, seam images, the ShredBench image)
node scripts/audio/tempo.mjs         # narration MP3s -> 48 kHz WAV (natural speed: no stretch)
node_modules/.bin/tsx scripts/audio/mix.mts           # public/audio/mix.wav (+ out/mix-report.json)
node_modules/.bin/tsx scripts/audio/backup-score.mts  # public/audio/backup.wav
```

Captures are gitignored too (`capture/`); the next section rebuilds them. Remotion's own ffmpeg is used throughout:
no system installs.

## Capture the product

All captures are 3840x2160 (a 1920x1080 page at 2x), screenshotted frame by frame under a controlled page clock, so
motion is exact and sharp. `APP_URL` picks the server (production: `https://untorn.vercel.app`; a local production
build: `pnpm build && pnpm start -p 3470` in the repo root).

| Footage | Command | Cost |
|---|---|---|
| First screen, recorded run (backup cut) | `node scripts/capture/hero-recorded.mjs` -> `capture/hero/default/` | free |
| Golden path, phase 1: one real live run, phone page to laptop, every streamed event logged with its arrival time | `APP_URL=https://untorn.vercel.app GOLDEN_DIR=golden-prod node scripts/capture/golden-live.mjs` | one live run (about $0.12) |
| Phase 2: the run replayed through the app's own live code path, one frame per 32 ms of page time; long waits shortened (logged) | `APP_URL=https://untorn.vercel.app GOLDEN_DIR=golden-prod node scripts/capture/golden-replay.mjs` | free |
| Phase 3: the film's frame data (and a list of frames the replay caught between two paints) | `node scripts/capture/golden-data.mjs capture/golden-prod` | free |
| The accuracy page | `APP_URL=https://untorn.vercel.app node scripts/capture/accuracy.mjs` | free |

Then pick the cut points from a contact sheet of the capture (`node scripts/tools/sheet.mjs <files...> out.png`) and
write them as `marks` in `src/data/golden.json` (each mark is a capture frame; `frameNotes` says what each shows).

## Render

```sh
node scripts/render.mjs video UntornDemo out/untorn-demo.mp4 --crf 12 --preset slow --concurrency 8
node_modules/.bin/tsx scripts/tools/timeline.mts --srt out/untorn-demo.srt
node scripts/render.mjs still Thumbnail 0 out/stills && cp out/stills/Thumbnail-00000.png out/thumbnail.png
node scripts/render.mjs video Backup out/untorn-backup.mp4 --crf 14
node scripts/tools/review.mjs out/untorn-demo.mp4 out/review --every 4 --stills 3,30,110
node scripts/tools/sheet.mjs out/review/frames out/contact.png --cols 6 --w 320
```

`render.mjs` links `capture/` into Remotion's bundle (Remotion can't copy a Windows junction), renders in the
bt709 colour space, and takes `--props '{"tear":"real"}'` for input props. `npx remotion studio` previews every
scene as its own composition (the captures need the same link: run a still render once first).

## Swap the numbers

Every number the film shows or says is in `src/data/numbers.json`, each with its source and the quote it rests on.

1. Edit the entry (for a benchmark, `proof[...]`: `replica`, `official`, `bySize`, `sam`, `imageCredit`).
2. If the spoken line changes, edit that scene in `src/data/narration.json` (`[spoken, shown]` pairs: the spoken
   text is respelled for the voice where needed, e.g. "tare" for the rip; the shown text is the caption) and
   re-take only that scene: `node scripts/voice/retake.mjs proof 2` writes two auditioned takes to
   `out/retakes/proof/` (each checked for starting and ending in silence), `--use <n>` installs one (ElevenLabs,
   about 0.4 credits per character; logged in `src/data/elevenlabs-ledger.json`). Then `node scripts/audio/tempo.mjs`.
3. Re-run the mix and the render. The timeline is computed from the voice's alignment, so cuts and sound cues follow.

## Swap the real-tear beat

The "Tear your own" beat (1:06-1:26) has a swap flag in `src/data/golden.json`: `use: "sim"` (built and rendered:
a simulated tear of a real 1903 letter, run live on untorn.vercel.app) or `use: "real"` (the user's own hand-torn
page). **Use `real` only after the main loop confirms the page may be shown publicly.** Its photos stay out of git
and go nowhere except through the app's own run.

1. Film it: `APP_URL=https://untorn.vercel.app GOLDEN_DIR=golden-real node scripts/capture/golden-live.mjs <photo>`
   (one live run), then `GOLDEN_DIR=golden-real node scripts/capture/golden-replay.mjs`.
2. `node scripts/capture/golden-data.mjs capture/golden-real golden-frames-real.json`.
3. Contact-sheet `capture/golden-real/seq-*`, and fill `variants.real.marks` with the same keys as `sim` (the QR
   frame and its hold, the hero taking the run, the lift, a read in the loupe and its hold plus the loupe's centre
   `readAt`, the pieces coming home, the climax close-up, the transcript typing, the whole page).
4. Check the label in `variants.real.label`, set `use: "real"` (or render with `--props '{"tear":"real"}'`), render.

The film throws a clear error if `real` is selected before it has a capture and marks.

## Voice, sound, captions

- Narrator: **Peter** (ElevenLabs library voice `ZthjuvLPty3kTMaNKVKb`) on **eleven_v4**, stability 0.5, similarity
  0.75, speed 1.0, chosen by evidence (auditions, scores and the top three takes in `out/voice-auditions/`). The
  scripts refuse cloned voices. Played at the speed it was spoken: no time-stretch (an earlier 3.5 %
  ffmpeg atempo speed-up was dropped). The proof scene is a re-take (the first take started mid-sound).
- Joins: the mix cuts the narration into caption clips and joins them on the audio's own silence
  (`scripts/audio/voice.mts`): where the edit keeps the voice's timing the clips meet at one sample (the original
  audio), a beat fades out and in at the quietest point of the pause, a shortened pause loses its quietest stretch
  under an equal-power crossfade. The mix throws if any audio would play twice; `out/voice-joins.json` lists every
  cut with its level (all at -64 dBFS or quieter).
- Score and sound: original synthesis (`scripts/audio/synth.mjs`), placed on the picture's own cue times
  (`src/film/sfx.ts`), ducked 10 dB under the voice, mastered to about -14 LUFS with a true peak under -1 dBTP.
- Captions: burned in from the alignment (Schibsted Grotesk on a calm band) and written to the SRT.

## Layout

```
src/Root.tsx            compositions
src/film/               timeline (from the narration), captions' cues, sound cues, the film, the backup's edit
src/scenes/             ColdOpen, Sacks, Twins, Proof, Golden, Hood, Peak, Thumbnail, Backup
src/data/               numbers, narration, voice, scene data built by the app's own code, golden-path frame data
scripts/capture|assets|voice|audio|tools    capture, kits, narration, sound, review tools
```
