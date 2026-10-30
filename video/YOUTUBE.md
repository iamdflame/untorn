# YouTube upload

**File:** `out/untorn-demo.mp4` (1:59.6, 1920x1080, 30 fps). **Captions:** upload `out/untorn-demo.srt` as English
subtitles (the film also has them burned in). **Thumbnail:** `out/thumbnail.png`.

## Title

Untorn: torn pages, read whole again (Meta SAM 3.1 + Muse Spark)

## Description

Untorn puts torn documents back together from a single photo. Meta's SAM 3.1 cuts out every piece, a geometry solver proposes joins from the shape of each tear, and Muse Spark reads the half-words across each tear to confirm them, then reads the rebuilt page back.

Try it: https://untorn.vercel.app (tear a page, take one photo with your phone, and watch it rebuild live)
How accurate is it: https://untorn.vercel.app/accuracy
Code: [REPO URL]

Why it matters: in 1989 the Stasi began tearing up its files by hand, about 16,000 sacks of them, and about 15,400 are still in pieces (Federal Government evaluation report, Bundestag Drucksache 21/6550, 2026). At the current pace, Germany's Federal Court of Audit puts the job at about 847 years (Bundesrechnungshof, Bundestag Drucksache 20/6530, 2023).

When pages are torn together as a stack, their pieces share the very same edge, so shape alone can't tell them apart. Untorn reads: only the true neighbour completes the words. If shape can't decide, the reading must agree, or the piece is set aside, never forced.

On a 64-document replica of the ShredBench protocol (8 pieces each), Muse Spark alone gets a normalised edit distance of 0.404 against the true text; Untorn, the same Muse Spark with SAM 3.1 and the solver, gets 0.050. On ShredBench's 3 official images with known text: 0.528 and 0.002.

What you see: the letters are simulated tears of real public-domain letters; every run is labelled on screen as a recorded run or a live run. The "Tear your own" part is a live run on untorn.vercel.app (photo sent from the phone page in an emulated phone), with the waits cut and the real elapsed time shown.

Chapters
0:00 One photo, put back together
0:13 The Stasi's torn files
0:33 Twins: pages torn as a stack
0:51 Proof: the same shredded photos, read two ways
1:04 Tear your own, live
1:24 Under the hood
1:43 Read whole again

Credits
Narration: ElevenLabs library voice "Peter".
Score and sound: original synthesis made for this film.
Archive photos: Maximilian Schönherr, "Archivalien im Depot der Stasiunterlagenbehörde 1 – 360° Foto" and "… 3 – 360° Foto", Wikimedia Commons, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), reprojected and cropped.
Letters (public domain): Franklin D. Roosevelt to Julian Goldman, 1927 (Science History Institute, via DPLA and Wikimedia Commons); Pierre Chouteau to Mary Louise Dalton, 1903 (Missouri Historical Society, via DPLA and Wikimedia Commons); C. W. Ayars to Esther E. Leonard, 1918 (Missouri History Museum, via Wikimedia Commons); Ho Chi Minh to the US Secretary of State, 22 October 1945, page 2 (Wikimedia Commons).
Benchmark image: ShredBench official image news_041 (github.com/ythere-y/ShredBench, Apache-2.0).
Built with Meta SAM 3.1 and Muse Spark. Film made with Remotion.

## Before publishing

- Replace `[REPO URL]` with the public repository's address.
- If the real-tear variant is cleared and rendered, change "What you see" to say which part shows a page torn by hand.
- Chapter times are the scene starts rounded up to the second; check them against the final upload.
