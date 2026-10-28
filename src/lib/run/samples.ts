// The fixed samples, from public/samples/manifest.json: the first screen replays a recorded run of one; "Run it live"
// sends the same photo through the real pipeline; the hourly health run checks one against its answer key. A new
// sample drops in by adding its files and a manifest entry (see the manifest's note).

import manifest from "../../../public/samples/manifest.json";

export type PhotoSource = { url: string; w: number };

export type Sample = {
  name: string;
  title: string;
  /** Shown with the photo, so a simulated tear is never mistaken for a real one. */
  caption: string;
  /** The one-line honesty label on the stage ("Simulated tear of a real 1903 letter, recorded run."). */
  honesty: string;
  /** Where the page comes from, for the footer. */
  credit: string;
  /** The recorded run (a stored RunResult) the first screen replays: without the seam images, for a light first load. */
  recorded: string;
  /** The full recorded run, for the download. */
  download?: string;
  /** Full-resolution photo, bundled with the server functions (repo path). */
  file: string;
  /** The display photo of the recorded run, for the first paint (before the recording loads). */
  photo: { url: string; width: number; height: number; sources?: PhotoSource[]; hires?: string };
  /** A stack trial for the twins beat. */
  twins?: string;
};

/** A stack trial: one piece, three scraps with the same torn edge, and what Muse picked. */
export type StackTrial = {
  name: string;
  label: string;
  images: Record<"L" | "A" | "B" | "C", { url: string; w: number; h: number }>;
  /** Where the slot starts on the left piece (px of the left image). */
  slotX: number;
  truth: "A" | "B" | "C";
  choice: "A" | "B" | "C";
  confidence: number;
  /** The joined words, split where the tear cuts them ("bo|rn"). */
  words: string[];
  reason: string;
  /** Where the words cross the tear on the left image (px). */
  rings: [number, number][];
  summary: { trials: number; answered: number; correct: number; chance: number; model: string; source: string };
};

type Manifest = { default: string; health: string; samples: Record<string, Sample>; stacks: Record<string, StackTrial> };
const M = manifest as unknown as Manifest;

export const SAMPLES: Record<string, Sample> = M.samples;
export const STACKS: Record<string, StackTrial> = M.stacks;
export const DEFAULT_SAMPLE: string = M.default;
/** The sample the hourly health run scores (it needs data/samples/<name>/key.json). */
export const HEALTH_SAMPLE: string = M.health;

export const sampleOrDefault = (name: string | null | undefined): Sample => (name && SAMPLES[name]) || SAMPLES[DEFAULT_SAMPLE];

/** The stage photo's display width: the photo covers the stage (the right 58% on a laptop, full-bleed on a phone). */
export const PHOTO_SIZES = "(max-width: 760px) 190vw, 86vw";
