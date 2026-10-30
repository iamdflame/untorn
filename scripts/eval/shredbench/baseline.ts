// The Muse-alone baseline: ShredBench's task exactly as their benchmark poses it to multimodal LLMs. The scattered
// photo, scaled to at most 2,048 px on its long side (as their inference script does), with their prompt, verbatim
// (github.com/ythere-y/ShredBench, qwen-vl-flash.py, Apache-2.0). Muse Spark answers through our structured client,
// the markdown in one text field, so no code-fence stripping is needed.

import { museCall, type ImageInput, type MuseOptions, type MuseOutcome } from "../../../src/lib/server/muse";

export const SHREDBENCH_PROMPT = String.raw`You are an AI assistant specialized in reconstructing and converting torn document fragments to Markdown format. The input image contains scattered fragments of a single original document. Your task is to mentally "stitch" them together and recover the original content exactly as it was.

Please follow these instructions for the reconstruction and conversion:

1. Reconstruction & Text Processing:
   - **Stitching Logic**: Visually analyze the fragments to determine their logical order. If a sentence or word is cut by a tear (e.g., "pro" on one piece, "cess" on another), merge them into the complete word ("process").
   - **Ignore Artifacts**: Ignore physical damage, tear lines, shadows, and background noise. Do not output text describing the damage.
   - **Verbatim Transcription**: Accurately recognize all text. **Do not summarize, interpret, or hallucinate content.** If the document appears to be code, transcribe the code exactly.
   - Convert the reconstructed text into Markdown format.
   - Maintain the original document structure (headings, paragraphs, lists).

2. Mathematical Formula Processing:
   - Convert all mathematical formulas to LaTeX format.
   - **Reconstruction**: If a formula is split across fragments, reconstruct the valid, complete LaTeX formula.
   - Enclose inline formulas with \( \). For example: This is an inline formula \( E = mc^2 \)
   - Enclose block formulas with \\[ \\]. For example: \[ \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \]

3. Table Processing:
   - Convert tables to HTML format.
   - **Reconstruction**: Realign columns or rows that are split across fragments.
   - Wrap the entire table with <table> and </table>.

4. Figure Handling:
   - Ignore figures content in the image. Do not attempt to describe or convert images.

5. Output Format:
   - Ensure the output Markdown document has a clear structure with appropriate line breaks between elements.
   - **Strict Constraint**: Output ONLY the converted Markdown content. Do not add any introductory text (like "Here is the reconstructed text") or concluding remarks.

Please strictly follow these guidelines. Your primary goal is high-fidelity restoration of the text, formulas, and tables into the specified format.
`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["markdown"],
  properties: { markdown: { type: "string" } },
};

/** Muse alone on the scattered photo (already scaled as their script scales it). */
export function museAlone(photo: ImageInput, opts: MuseOptions = {}): Promise<MuseOutcome<{ markdown: string }>> {
  return museCall(
    {
      fn: "shredbenchAlone",
      schemaName: "reconstruction",
      schema: SCHEMA,
      content: [
        { type: "input_text", text: SHREDBENCH_PROMPT + "\nReturn the Markdown in the markdown field." },
        { type: "input_image", image_url: "url" in photo ? photo.url : `data:${photo.mime};base64,${Buffer.from(photo.data).toString("base64")}` },
      ],
      promptVersion: "shredbench-qwen-vl-flash",
      defaults: { model: "muse-spark-1.3", effort: "low", maxOutputTokens: 12000, timeoutMs: 120_000, deadlineMs: 240_000, hedgeAfterMs: 90_000 },
      check: (j) => (j && typeof j === "object" && typeof (j as { markdown?: unknown }).markdown === "string" ? { markdown: (j as { markdown: string }).markdown } : null),
    },
    opts,
  );
}
