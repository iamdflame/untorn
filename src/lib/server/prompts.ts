// Every Muse prompt and output schema Untorn sends, in one versioned file.
//
// Bump PROMPTS_VERSION whenever a prompt's wording or a schema changes: the version rides on every call log, so a
// measured accuracy can always be traced to the exact wording that produced it (docs/MODELS.md has the numbers).
// Schemas use the strict subset (plain object root, additionalProperties false, every key required), so the server
// validates them and decoding is constrained to them.

// .1: the measured bench runs (seam v1/v2/flush, choice v1). .2: verifySeam defaults to seam v2 after the bench.
// 2026-10-30.1: orient v1 (pageOrientation: is a rebuilt page upright? asked only where the solver is unsure).
export const PROMPTS_VERSION = "2026-10-30.1";

type JsonSchema = Record<string, unknown>;

const words = { type: "array", items: { type: "string" } } as const;

// ---------------------------------------------------------------------------------------------------------------
// verifySeam: is this a true join? (binary)

export const SEAM_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["same_place", "confidence", "words_across", "reason"],
  properties: {
    same_place: { type: "boolean" },
    confidence: { type: "number" },
    words_across: words,
    reason: { type: "string" },
  },
};

/** v1: the spike's wording (spikes/v3/crossword.py), kept as the measured baseline. */
const SEAM_V1 =
  "Two torn paper fragments are laid edge to edge; the dark ragged line is the tear between them. " +
  "Decide whether they really belong together at this spot (the same place on the same page) or are two different " +
  "places that merely line up. Read the typed words that cross the tear: on a true join, the letters and words " +
  "split by the tear continue across it (half-letters complete each other, words and sentences read on). " +
  "Return same_place, your confidence 0-1, the words you read across the tear, and a one-line reason.";

/** v2: reads line by line, like a crossword, and says what to do when the evidence is thin. */
const SEAM_V2 =
  "This image shows two torn paper fragments placed edge to edge along a ragged tear. Some candidate placements are " +
  "true (both pieces come from this exact spot on one page); others are two different spots that only happen to line " +
  "up, with the text lines at the same height. Only the words can tell them apart.\n" +
  "Work like a crossword: for every text line that crosses the tear, read the end of the line on the left piece and " +
  "the start of the line on the right piece, then read them joined. On a true join, letters cut in half by the tear " +
  "complete each other and the joined words are real words that continue the sentence. On a false join, at least one " +
  "line breaks: a cut letter does not complete, a joined word is not a word, or the sentence stops making sense.\n" +
  "One broken line is enough to reject. Judge only from what you can read; if the text is too sparse to decide, say " +
  "so with a low confidence.\n" +
  "Return same_place, your confidence from 0 to 1, the joined words you read across the tear, and a one-line reason " +
  "that names the deciding words.";

/** flush: v1 for a seam drawn without the dark gap line (the two pieces simply meet). */
const SEAM_FLUSH =
  "Two torn paper fragments are laid edge to edge with no gap: a ragged tear runs from top to bottom near the middle " +
  "of the image, where the left piece meets the right piece. Decide whether they really belong together at this " +
  "spot (the same place on the same page) or are two different places that merely line up. Read the typed words " +
  "that cross the tear: on a true join, the letters and words split by the tear continue across it (half-letters " +
  "complete each other, words and sentences read on). Return same_place, your confidence 0-1, the words you read " +
  "across the tear, and a one-line reason.";

// ---------------------------------------------------------------------------------------------------------------
// chooseContinuation: which candidate continues the fragment? (k-way)

export const LETTERS = "ABCDEFGHIJKLMNOP";

export function choiceSchema(k: number): JsonSchema {
  if (!Number.isInteger(k) || k < 2 || k > LETTERS.length) throw new RangeError(`k must be 2..${LETTERS.length}`);
  return {
    type: "object",
    additionalProperties: false,
    required: ["choice", "confidence", "words_across", "reason"],
    properties: {
      choice: { type: "string", enum: LETTERS.slice(0, k).split("") },
      confidence: { type: "number" },
      words_across: words,
      reason: { type: "string" },
    },
  };
}

const letterList = (k: number) => LETTERS.slice(0, k).split("").join(", ");

/** v1: the spike's wording (spikes/v3/crossword3.py), generalised to k candidates. */
const CHOICE_V1 = (k: number) =>
  "A typed page was torn, together with other pages stacked on it, so several fragments share exactly the same " +
  "torn outline. The top strip is a LEFT fragment. Each candidate below is a RIGHT fragment with the identical " +
  `tear shape, taken from a different page. Exactly one of the ${k} candidates (${letterList(k)}) truly continues ` +
  "the left fragment. Mentally slide each candidate against the left edge and read across the tear: on the true " +
  "one, half-letters complete each other and words and sentences read on. Return the choice, your confidence 0-1, " +
  "the words you read across the tear for your choice, and a one-line reason.";

/** v2: reads every candidate line by line before choosing, and rules candidates out by broken words. */
const CHOICE_V2 = (k: number) =>
  "Pages stacked together were torn in one go, so several fragments share exactly the same torn outline and only " +
  "the words can tell them apart. The top strip, labelled LEFT FRAGMENT, is one piece. Below it are " +
  `${k} candidates (${letterList(k)}), each a RIGHT piece with the identical tear shape; exactly one of them comes ` +
  "from the same page and continues the left piece.\n" +
  "Work like a crossword. For each candidate in turn, slide it against the right edge of the left piece and, line by " +
  "line, join the end of each left line to the start of the candidate's line at the same height. On the true " +
  "candidate, letters cut by the tear complete each other and every joined word is a real word that continues the " +
  "sentence. A wrong candidate breaks somewhere: a cut letter that does not complete, a non-word, or a sentence that " +
  "stops making sense. Rule candidates out by their broken lines and choose the one where every line reads on.\n" +
  "Return the choice, your confidence from 0 to 1, the joined words you read across the tear for your choice, and a " +
  "one-line reason that names the deciding words.";

/** joined: the sheet shows each candidate already joined, flush, to the left piece (one strip per candidate). */
const CHOICE_JOINED = (k: number) =>
  "Pages stacked together were torn in one go, so several fragments share exactly the same torn outline. The top " +
  "strip, labelled LEFT FRAGMENT, is one piece on its own. Each row below it shows that same left piece joined, flush " +
  `along the tear, to a different right piece: ${k} candidates (${letterList(k)}) with the identical tear shape. ` +
  "Exactly one row is a true join, where the right piece comes from the same page. Read each row straight across " +
  "the tear: on the true join, letters cut in half complete each other and every line reads on as real words and a " +
  "sensible sentence; on the others some line breaks into a non-word or nonsense. Return the choice, your confidence " +
  "0-1, the joined words you read across the tear for your choice, and a one-line reason.";

// ---------------------------------------------------------------------------------------------------------------
// readPage: transcribe a reassembled page, marking gaps instead of guessing.

export const GAP = "[…]";

export const READ_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "language", "uncertain"],
  properties: {
    text: { type: "string" },
    language: { type: "string" },
    uncertain: words,
  },
};

const READ_V1 =
  "This is a document that was torn into pieces and has been put back together; some pieces may still be missing, " +
  "so parts of the page can be blank background, a dark gap, or cut off.\n" +
  "Transcribe the text exactly as written, line by line, keeping the original spelling, punctuation, and line " +
  "breaks. Never invent, complete, or guess text that is not visible: wherever a word or part of a word is missing " +
  `because paper is missing or torn away, write ${GAP} in its place, and keep the visible part of a cut word (for ` +
  `example "Missis${GAP}"). Write ${GAP} for illegible text too.\n` +
  "Return the transcription as text, the language as a BCP 47 code (for example en, de, fr), and in uncertain list " +
  "each word you transcribed but are not sure of, exactly as it appears in text.";

// ---------------------------------------------------------------------------------------------------------------
// pageOrientation: is a rebuilt page upright? (asked only where the solver's own evidence is weak)

export const ORIENTATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["upright", "confidence", "reason"],
  properties: {
    upright: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
};

const ORIENT_V1 =
  "This image shows a page of printed or typed text that was torn into pieces and put back together; parts may be " +
  "missing. Look at the letters: is the page upright (the text reads normally, left to right, top to bottom) or " +
  "upside down (turned by 180 degrees, so the letters are inverted)? Return upright true or false, your confidence " +
  "from 0 to 1, and a short reason naming a word you can read the right way up.";

// ---------------------------------------------------------------------------------------------------------------
// translate

export const TRANSLATE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "source_language"],
  properties: {
    text: { type: "string" },
    source_language: { type: "string" },
  },
};

const TRANSLATE_V1 = (to: string) =>
  `Translate the transcription below into the language with BCP 47 code "${to}". Keep the line breaks. The marker ` +
  `${GAP} stands for text that is missing from the torn original: copy every ${GAP} through unchanged, at the matching ` +
  "place, and never fill it in. Translate the visible fragments of cut words as well as you can without completing " +
  "them. Return the translation as text and the source language as a BCP 47 code.";

// ---------------------------------------------------------------------------------------------------------------
// sortFragments: Muse Wonder groups a mixed pile into pages.

export const SORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fragments", "reason"],
        properties: {
          fragments: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
      },
    },
  },
};

const SORT_V1 = (n: number) =>
  `Below are ${n} torn paper fragments, numbered 1 to ${n}, from one or more different pages mixed together. Group ` +
  "them by the page they came from. Compare what does not change within a page: paper tone and texture, ink colour, " +
  "typeface or handwriting, letter size, line spacing and ruling, margins, and the language and subject of the text. " +
  "Ignore the shape of the tear and the rotation of each fragment. Put every fragment in exactly one group; a " +
  "fragment that matches no other forms its own group. Return the groups, each with its fragment numbers and a " +
  "one-line reason naming the shared features.";

const fragmentLabel = (i: number) => `Fragment ${i}:`;

export const PROMPTS = {
  seam: { v1: SEAM_V1, v2: SEAM_V2, flush: SEAM_FLUSH },
  choice: { v1: CHOICE_V1, v2: CHOICE_V2, joined: CHOICE_JOINED },
  read: { v1: READ_V1 },
  orient: { v1: ORIENT_V1 },
  translate: { v1: TRANSLATE_V1 },
  sort: { v1: SORT_V1, fragmentLabel },
  /** Added when the seam image is also sent rotated by 180°. */
  bothOrientations:
    "The same seam is shown twice: as photographed and turned by 180 degrees, because the pieces' upright direction " +
    "is unknown. Read whichever copy has upright text.",
} as const;

export type SeamPromptVersion = keyof typeof PROMPTS.seam;
export type ChoicePromptVersion = keyof typeof PROMPTS.choice;

/** The wording each function uses by default, chosen from the measured runs in docs/MODELS.md. */
export const DEFAULT_PROMPT = { seam: "v2" as SeamPromptVersion, choice: "v1" as ChoicePromptVersion };
