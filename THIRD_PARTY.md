# Third-party materials and licences

Untorn's code, design and writing were made for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). This page
lists everything else the project uses, with its licence and credit. The torn-page photos used to test real paper belong
to the entrant and are not in this repository.

## Meta models and tools
- **SAM 3.1, Muse Spark 1.3 and Muse Wonder 1.0**, called through the Meta Model API under Meta's API terms. No model
  weights are included here.
- **Muse Voice Transcribe**, used only to check the demo film's narration takes.
- **`@meta-sam/parser` 0.1.0**, Meta's parser for SAM responses, under the SAM License (last updated Nov 19, 2025);
  the full text ships with the package (`node_modules/@meta-sam/parser/LICENSE`).

## Open-source packages
| Package | Version | Licence |
|---|---|---|
| next | 16.4.3 | MIT |
| react, react-dom | 19.3.0 | MIT |
| sharp (libvips) | 0.35.5 | Apache-2.0 (libvips: LGPL-3.0) |
| @vercel/blob | 2.8.2 | Apache-2.0 |
| heic-convert | 2.1.0 | ISC |
| fast-png | 8.0.0 | MIT |
| qrcode | 1.5.4 | MIT |
| zod | 4.6.7 | MIT |
| Development: vitest, eslint, tailwindcss, tsx | – | MIT |
| Development: typescript, @playwright/test | – | Apache-2.0 |
| Development: jpeg-js | 0.4.4 | BSD-3-Clause |
| Demo film (`video/`): remotion and @remotion/* | 4.0.539 | Remotion License: free for individuals and for companies of up to 3 people |

## Fonts
- **Gambetta**: Indian Type Foundry, via Fontshare, ITF Free Font License.
- **Schibsted Grotesk**: SIL Open Font License 1.1.
- **IBM Plex Mono**: SIL Open Font License 1.1.

## Documents
All are public domain. The tears in the samples are simulated, and the app labels them as such.
- Franklin D. Roosevelt to Julian Goldman, 8 April 1927. Science History Institute, via DPLA and Wikimedia Commons.
- Pierre Chouteau to Mary Louise Dalton, 5 September 1903. Missouri Historical Society, via DPLA and Wikimedia Commons.
- C. W. Ayars (War Department, Office of the Surgeon General) to Esther E. Leonard, 18 May 1918. Missouri History
  Museum, via Wikimedia Commons.
- Ho Chi Minh to the US Secretary of State, 22 October 1945, page 2. Wikimedia Commons.
- Gustav Stresemann to Gustav Reimann, 11 May 1922 (German). Wikimedia Commons, "Stresemann, Brief.jpg".
- **The benchmark pages:** listed with their sources in [`scripts/bench/PAGES.md`](scripts/bench/PAGES.md).

## Benchmark
- **ShredBench** (Findings of ACL 2026), https://github.com/ythere-y/ShredBench, Apache-2.0.
- Its official renders and reference texts are fetched for evaluation. One example (news_041, with its reference text) is included in the demo film's data (`video/src/data/shredbench-example.json`), with credit, as Apache-2.0 allows.
- The NED metric and the replica generator are our own re-implementations
  ([`docs/SHREDBENCH.md`](docs/SHREDBENCH.md)).

## Demo film
- **Narration:** the ElevenLabs library voice "Peter", made with model eleven_v4 on a paid ElevenLabs plan, whose
  terms allow commercial use. It is no one's voice clone.
- **Music and sound:** original, synthesized for the film by `video/scripts/audio/synth.mjs`.
- **Photographs:** Maximilian Schönherr, "Archivalien im Depot der Stasiunterlagenbehörde 1 – 360° Foto" and "… 3 – 360°
  Foto" (2018), Wikimedia Commons, CC BY-SA 4.0. They are reprojected and cropped in the film and credited on its end
  card. The attribution is in `video/public/archival/LICENSE.txt`.
- **Details:** [`video/CREDITS.md`](video/CREDITS.md).

## Facts
Every figure about the Stasi files and earlier reconstruction projects comes from public documents, listed in
[`docs/FACTS.md`](docs/FACTS.md).
