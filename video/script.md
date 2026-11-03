# Untorn: the demo film (script)

Untorn is a project that puts torn documents back together from one photo, for archivists facing millions of hand-torn pages.

Film: 1920×1080, 30 fps, 2:26.5 (v2, 3 Nov 2026: the people who asked for their files, and the archive record). Narrator: Peter (ElevenLabs library voice, eleven_v4), chosen by evidence (`out/voice-auditions/README.md`). Captions are burned in from the narration's own timestamps, and the same text ships as `out/untorn-demo.srt`.

**Spoken vs shown.** The narrator reads numbers as words; the captions and the screen show figures. Every figure on screen carries its source or its label (simulated tear, recorded run, live run, real tear, benchmark). Numbers about the Stasi files come only from `docs/FACTS.md`; measured numbers come only from `src/data/numbers.json`, which names the report each one comes from.

## 1 · Cold open (0:00–0:11)
One continuous camera move on the light table: macro on real torn fibres, pull back to the whole photo, SAM 3.1's outlines draw on, the pieces lift and fly home with their real poses, one word reads across a tear in violet, and the torn "Untorn" wordmark slides together as the last piece seats.
Label: *Simulated tear of a real 1927 letter, recorded run.*

> Untorn puts torn documents back together from a single photo. Meta's SAM 3.1 cuts out every piece, and Muse reads the half-words across each tear, like a crossword.

## 2 · The people, then the sacks (0:13–0:40)
The rebuilt page pulls apart along its seams, and the archive shows through: the Stasi Records Archive's depot, two sacks on the floor. First the people: 3,499,663 set in type, "people have asked to see the files the Stasi kept on them", with its source. Then the counts: about 16,000 sacks, then about 15,400 still in pieces. A beat of silence. Then 847 years, alone.

> Three and a half million people have asked to see the files the Stasi kept on them.
> In 1989, the Stasi began tearing up its files by hand: about sixteen thousand sacks. About fifteen thousand four hundred are still in pieces.
> At this pace, Germany's auditors say it would take about eight hundred and forty-seven years.

Sources on screen: Federal Government evaluation report, Bundestag Drucksache 21/6550 (2026) for the sacks; Bundesrechnungshof, Drucksache 20/6530 (2023) for the 847 years.

## 3 · The twins (0:28–0:43)
Staged like a trick, with the real pieces of the recorded stack run: one torn piece with an empty slot, three scraps from three different letters with the very same torn edge. Each is tried in the slot: two make no words and get a red pencil strike. A beat. The third completes the words in violet.
Label: *Simulated stack tear of three real letters, recorded run. Muse Spark picked C at 0.97.*

> When pages are torn together, as a stack, their pieces share the very same edge. Shape alone can't tell them apart.
> So Untorn reads. Only the true neighbour completes the words.

## 4 · Proof (0:43–0:57)
The same shredded photo, read two ways. On ShredBench's own image news_041, Muse Spark alone (given the scattered photo and ShredBench's prompt) drops whole phrases; Untorn, the same Muse Spark with SAM 3.1 and the solver, returns the text word for word. Then the measured scores, labelled as a benchmark, and tiles for the recorded runs (each labelled "simulated tear, recorded run").
Label: *ShredBench (2026): 3 official images; a 64-document replica of its protocol, our re-implementation. NED, lower is better.*

> Given the same shredded photos, Muse Spark alone gets about forty percent of the text wrong. Untorn, the same Muse Spark with SAM 3.1 and the geometry solver, gets about five percent wrong.

## 5 · Tear your own (0:56–1:21)
The real app, run live from this repository's production build: "Tear your own" and the QR code, the phone's capture page, the laptop picking the photo up, the live stages, the rebuilt page and the transcript. The waits are cut, and a clock in the corner shows the real elapsed time.
Label: *Simulated tear of a real 1903 letter, sent from a phone. Live run, waits cut.*

> Tear a page and take one photo with your phone. The laptop picks it up, and the real pipeline runs live: SAM 3.1 finds the pieces, Muse reads across the tears, and the page comes back together. Then Muse reads it back to you.

## 6 · Under the hood (1:21–1:41)
Built from the recorded run's own data: a mask's edge at pixel scale with the traced outline, two edge traces sliding into a fit, the exact image Muse read and its answer, a twin set aside, the page, then the app's join map with both clues for every seam.

> Under the hood, the solver traces SAM's masks to a fraction of a pixel and proposes joins from the shape of each tear. Muse Spark reads across them. Where the shape can't decide, the reading must agree, or the piece is set aside. Untorn never forces a fit.

## 7 · Read whole again (1:46–2:08)
The rebuilt 1927 letter on the light table; the line Muse transcribed lights up as it is read. The 1927 page lifts away and the first screen's German letter (Stresemann to Reimann, 1922, its recorded run's own page render) drops into its place: the sentence Muse read underlines in violet, and its translation types beside it.
Label: *Gustav Stresemann to Gustav Reimann, 1922. Simulated tear, recorded run: 10 of 10 pieces placed, 16 of 16 joins right.*
Back to the sacks. End card: the wordmark, one line, the address and the credits.

> Ten pieces, whole again, and read: “I am starting a Patients' Aid Fund to help these poor children.”
> It reads German too, the language of the Stasi's files.

Then the German letter is filed: the column beside it becomes its archive record, the recorded run's own record by Muse Wonder, row by row as the narrator names them (From: Gustav Stresemann, "DR. GUSTAV STRESEMANN"; To: Gustav Reimann; Date: 11 May 1922, "11. Mai 1922"; Written at: Berlin), and the page's words under each name light violet on "quoted". A microphone, and a spoken note types in: "A scan from Wikimedia Commons, letter of May 1922. The tear is simulated." (a synthetic voice sent through the live site's POST /api/notes on 3 Nov 2026, written down by Muse Voice Transcribe in 1.7 s).
Label: *Every field quotes the page; the app checked each quote against the transcript.*

> Then Muse Wonder files it for the archive: who wrote it, to whom, when and where, each quoted from the page.
> And Muse Voice Transcribe writes down where it came from.
> About fifteen thousand four hundred sacks are still waiting. Untorn reads across the tears.

End card: **Untorn** · Reads across the tears. · https://untorn.vercel.app · Built with Meta SAM 3.1, Muse Spark, Muse Wonder and Muse Voice Transcribe. Archive photo: Maximilian Schönherr, CC BY-SA 4.0, cropped and reprojected. Letters: public domain (Science History Institute; Missouri History Museum; Missouri Historical Society; Wikimedia Commons).

## Fact check (each spoken claim, and where it comes from)
| Claim | Source |
|---|---|
| 3.5 million people have asked to see the files the Stasi kept on them (on screen: 3,499,663) | `docs/FACTS.md`: Bundesarchiv, "Das Stasi-Unterlagen-Archiv in Zahlen": 3,499,663 citizens have asked to see their files, as of 31 Dec 2025 |
| Muse Wonder files it: who wrote it, to whom, when and where, each quoted from the page (on screen: the record's rows and quotes) | The recorded run's record, `public/samples/stresemann-1922/result.json` (`catalogs`), made by the app's record step (`src/lib/server/catalog.ts`, `record.ts`: every quote checked against the transcript); copied verbatim to `src/data/record-stresemann.json` |
| Muse Voice Transcribe writes down where it came from (on screen: the note and 1.7 s) | POST https://untorn.vercel.app/api/notes, 3 Nov 2026, with a synthetic-voice WAV of that sentence: the answer, word for word, in 1,679 ms (`src/data/record-stresemann.json`) |
| The Stasi began tearing its files by hand in (autumn) 1989 | `docs/FACTS.md`: Bundesrechnungshof, Drucksache 20/6530: "Im Herbst 1989 begann die Stasi damit, in großem Umfang Unterlagen zu vernichten. Sie lagerte das von Hand zerrissene Material in etwa 16 000 Säcken." |
| About 16,000 sacks; about 15,400 not yet reconstructed ("still in pieces") | `docs/FACTS.md`: Drucksache 21/6550 (17 Jun 2026): "rund 16.000 Behältnisse (meist Säcke)" … "circa 15.400 Behältnissen (Säcken) noch nicht rekonstruierter Unterlagen" |
| At this pace, about 847 years | `docs/FACTS.md`: Bundesrechnungshof, Drucksache 20/6530: "Bei diesem Arbeitstempo wären die Unterlagen erst in rund 847 Jahren wiederhergestellt." |
| Pages torn as a stack share the same edge; shape alone can't separate them | `docs/FACTS.md`: Diem, TU Wien, 2014 ("snippets have the same rupture edges"); `docs/SOLVER.md`: geometry alone places 0 % of stack pieces and leaves every twin for reading |
| Same shredded photos: Muse Spark alone about 40 % of the text wrong, Untorn about 5 % | `.apex/build/S5-SHREDBENCH.md`: NED 0.404 (Muse Spark alone) vs 0.050 (Untorn) on the 64-document replica at 8 pieces; 0.528 vs 0.002 on the 3 official images with ground truth; NED = Levenshtein / longer length, so 0.40 is about 40 % of the text |
| On screen: news_041, Muse alone drops "was connected to the grid and started" and "…day, with the remaining capacity to be connected in May," | S5 run files `runs/baseline` and `runs/v2` for official-8/news_041 against `official/my_dataset/news_041.md` (`src/data/shredbench-example.json`) |
| On screen (twins): 22 of 22 stack reads right, chance 1 in 3 | `public/samples/manifest.json` stacks.stack-3-letters summary; `.apex/build/S6B-SAMPLES.md` (run rec-stack-3-letters-5cc28e) |
| On screen (proof tiles): 10/10 placed, 13/13 joins on the 1927 letter; 18 placed, 0 misplaced, 6 set aside on the stack | `.apex/build/S6B-SAMPLES.md` |
| The live run: SAM finds the pieces, Muse reads across the tears, then reads the page | `src/lib/server/pipeline.ts`; the run shown on screen |
| Outlines traced to a fraction of a pixel | `docs/SOLVER.md` (marching squares at iso-level 0.5, subpixel outline); `docs/MODELS.md` (median boundary error 0.36–0.52 px on simulated photos) |
| Where shape can't decide, the reading must agree, or the piece is set aside; never forced | `docs/SOLVER.md` (two-clue acceptance; twins need two concordant reads; "Nothing is forced") |
| “I am starting a Patients' Aid Fund to help these poor children.” | Muse's transcript of the rebuilt FDR letter (recorded run, CER 0.0 % against the reference) |
| It reads German too (on screen: the German sentence and its English translation) | Muse's transcript and translation of the rebuilt Stresemann letter, verbatim (`public/samples/stresemann-1922/result.json`, run rec-stresemann-1922-54cafd; transcript CER 0.0 % against `data/samples/stresemann-1922/ref-page0.txt`) |
| The Stasi's files are in German | General knowledge: the Stasi was East Germany's Ministry for State Security. The torn files are held by the Bundesarchiv's Stasi Records Archive (`docs/FACTS.md`, its reconstruction page) |
| On screen (German letter): 10 of 10 pieces placed, 16 of 16 joins right | `pnpm tsx scripts/score-sample.ts public/samples/stresemann-1922/result.json data/samples/stresemann-1922/gt.json` (10/10 placed correctly, 0 misplaced, joins right 16/16) |
| About 15,400 sacks still waiting | as above, Drucksache 21/6550 |
