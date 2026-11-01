# YouTube upload

**Uploaded:** https://youtu.be/fwXAsfIqFug (1 Nov 2026). **File:** `out/untorn-demo.mp4` (2:07.6, 1920x1080, 30 fps, stereo 48 kHz). **Captions:** `out/untorn-demo.srt`, English
(the film also has them burned in). **Thumbnail:** `out/thumbnail-real.png` (the hand-torn page: its one photo, and the
page whole again; `out/thumbnail.png` is the 1927-letter alternative).

## Title

```text
Untorn: torn pages put back together from one photo (Meta SAM 3.1 + Muse Spark)
```

## Description

Copy it with the copy button at the top right of the box (on GitHub), not by selecting the page text: the box keeps
every line break, and YouTube needs each chapter on its own line to show chapters.

```text
Untorn puts torn documents back together from one photo. Meta's SAM 3.1 cuts out every piece to the pixel, a geometry solver proposes joins from the shape of each tear, and Muse Spark reads the half-words across each tear to confirm them, then reads the rebuilt page back.

Try it: https://untorn.vercel.app (free, no sign-up: tear a printed page into about 6 pieces, take one photo with your phone, and watch it rebuild live)
How accurate is it: https://untorn.vercel.app/accuracy
Code: https://github.com/iamdflame/untorn

On real paper: a printed page torn by hand into 6 pieces came back whole in 5 of 5 live runs on the site. That page is the one rebuilt live at 1:06.

Why it matters: in 1989 the Stasi began tearing up its files by hand, about 16,000 sacks of them, and about 15,400 are still in pieces (Federal Government evaluation report, Bundestag Drucksache 21/6550, 2026). At the current pace, Germany's Federal Court of Audit puts the job at about 847 years (Bundesrechnungshof, Bundestag Drucksache 20/6530, 2023).

When pages are torn together as a stack, their pieces share the very same edge, so shape alone can't tell them apart. Untorn reads: only the true neighbour completes the words. In 22 stack reads, Muse picked the true neighbour 22 times (chance: 1 in 3). If shape can't decide, the reading must agree, or the piece is set aside, never forced.

Muse also reads pages in other languages and translates them: the film ends on a German letter of 1922, rebuilt, read and translated (German is the language of the Stasi's files).

On a 64-document replica of the ShredBench protocol (Findings of ACL 2026; 8 pieces each), Muse Spark alone gets a normalised edit distance of 0.404 against the true text; Untorn, the same Muse Spark with SAM 3.1 and the solver, gets 0.050, 8× fewer errors. On ShredBench's 3 official images with known text: 0.528 and 0.002.

What you see: the "Tear your own" part (1:06) is a printed page torn by hand into 6 pieces and photographed from above. The photo goes from the phone page (in an emulated phone) to a live run on untorn.vercel.app, with the waits cut and the real elapsed time shown (55 s). The letters elsewhere are simulated tears of real public-domain letters, and every run is labelled on screen as a recorded run or a live run. The proof part uses ShredBench's own benchmark image.

Chapters
0:00 One photo, put back together
0:14 The Stasi's torn files
0:34 Twins: pages torn as a stack
0:53 Proof: the same shredded photos, read two ways
1:06 Tear your own, live
1:26 Under the hood
1:46 Read whole again

Credits
Narration: ElevenLabs library voice "Peter" (an AI voice).
Score and sound: original synthesis made for this film.
Archive photos: Maximilian Schönherr, "Archivalien im Depot der Stasiunterlagenbehörde 1 – 360° Foto" and "… 3 – 360° Foto", Wikimedia Commons, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), reprojected and cropped.
Letters (public domain): Franklin D. Roosevelt to Julian Goldman, 1927 (Science History Institute, via DPLA and Wikimedia Commons); C. W. Ayars to Esther E. Leonard, 1918 (Missouri History Museum, via Wikimedia Commons); Ho Chi Minh to the US Secretary of State, 22 October 1945, page 2 (Wikimedia Commons); Gustav Stresemann to Gustav Reimann, 1922 (Wikimedia Commons).
The hand-torn page: a printed page of our own.
Benchmark image: ShredBench official image news_041 (github.com/ythere-y/ShredBench, Apache-2.0).
Built with Meta SAM 3.1 and Muse Spark. Film made with Remotion.
```

## Upload settings

- **Video:** `out/untorn-demo.mp4`. **Thumbnail:** `out/thumbnail-real.png` (YouTube asks for a verified account to
  upload a custom thumbnail; verify by phone first if the option is greyed out).
- **Title and description:** paste the two boxes above as they are. The chapter list must stay in the description,
  one chapter per line, starting at 0:00, for YouTube to show chapters.
- **Subtitles:** upload `out/untorn-demo.srt` as English.
- **Audience:** "No, it's not made for kids".
- **Altered or synthetic content:** YouTube asks this for realistic content that could pass for real: a real person
  shown saying or doing something they didn't, real footage altered, or a made-up scene that looks real. None of the
  film does that: the narrator is an AI library voice credited above, and every simulated tear is labelled on screen.
- **Category:** Science & Technology.
- **Visibility:** Public (Unlisted also plays for judges; Public lets the launch posts share it).
- **After upload:** put the link in the repository README ("Demo video") and in the submission form.

Chapter times are the scene starts (from `scripts/tools/timeline.mts`) rounded up to the second; the film is 2:07.6.
