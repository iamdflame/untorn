// The fixed sample photos: the first screen replays a recorded run of one; "Run it live" sends the same photo through
// the real pipeline; the hourly health run checks it against its answer key.

export type Sample = {
  name: string;
  title: string;
  /** Shown with the photo, so a simulated tear is never mistaken for a real one. */
  caption: string;
  /** The recorded run (a stored RunResult) the first screen replays. */
  recorded: string;
  /** Full-resolution photo, bundled with the server functions (repo path). */
  file: string;
  /** The display photo of the recorded run, for the first paint (before the recording loads). */
  photo: { url: string; width: number; height: number };
};

export const SAMPLES: Record<string, Sample> = {
  "chouteau-1903": {
    name: "chouteau-1903",
    title: "A letter of 1903, torn into 10 pieces",
    caption:
      "Simulated tear of a real public-domain letter (Pierre Chouteau to Mary Louise Dalton, 5 September 1903, Missouri Historical Society via DPLA). The outlines, seam readings and joins are the real pipeline's.",
    recorded: "/samples/chouteau-1903/result.json",
    file: "data/samples/chouteau-1903/photo.jpg",
    photo: { url: "/samples/chouteau-1903/photo.jpg", width: 2400, height: 1800 },
  },
  "fdr-1927": {
    name: "fdr-1927",
    title: "A letter of 1927, torn into 10 pieces",
    caption:
      "Simulated tear of a real public-domain letter (Franklin D. Roosevelt to Julian Goldman, 8 April 1927, Science History Institute via DPLA). The outlines, seam readings and joins are the real pipeline's.",
    recorded: "/samples/fdr-1927/result.json",
    file: "data/samples/fdr-1927/photo.jpg",
    photo: { url: "/samples/fdr-1927/photo.jpg", width: 4800, height: 3600 },
  },
  "stack-3-letters": {
    name: "stack-3-letters",
    title: "Three letters torn together, 24 pieces",
    caption:
      "Simulated stack tear of three real public-domain letters (F. D. Roosevelt 1927, Science History Institute; C. W. Ayars 1918, Missouri History Museum; Ho Chi Minh 1945, p. 2), torn along the same paths so their outlines repeat. The outlines, readings and joins are the real pipeline's.",
    recorded: "/samples/stack-3-letters/result.json",
    file: "data/samples/stack-3-letters/photo.jpg",
    photo: { url: "/samples/stack-3-letters/photo.jpg", width: 6000, height: 4400 },
  },
};

export const DEFAULT_SAMPLE = "chouteau-1903";
