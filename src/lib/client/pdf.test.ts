import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildPdf, pdfString } from "./pdf";

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

describe("buildPdf", () => {
  it("writes a well-formed PDF: every xref offset lands on its object, the JPEG goes in untouched", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 60, height: 80, channels: 3, background: "#eeeae0" } }).jpeg().toBuffer());
    const transcript = "Sehr geehrter Herr Reimann !\n\nIch danke Ihnen für Ihr Schreiben (vom 6. d. Mts.)\ndaß die Ihnen gemachte Mitteilung unrichtig ist.";
    const pdf = buildPdf({ pages: [{ jpeg, width: 60, height: 80, transcript, translation: { text: "Dear Mr Reimann !", from: "German" } }], title: "Untorn: a rebuilt page", summary: ["10 pieces, one page."], created: new Date("2026-10-31T09:00:00Z") });
    const s = latin1(pdf);
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    // the xref table points at each "n 0 obj"
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe("xref");
    const [, count] = /xref\n0 (\d+)\n/.exec(s.slice(start))!;
    const rows = s.slice(start).split("\n").slice(3, 2 + Number(count));
    rows.forEach((row, i) => {
      const off = Number(row.slice(0, 10));
      expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    // two pages: the image page and the transcript page
    expect(/\/Count (\d+)/.exec(s)![1]).toBe("2");
    // the image stream holds the JPEG byte for byte
    const at = s.indexOf("/Filter /DCTDecode");
    const len = Number(/\/Length (\d+)/.exec(s.slice(at))![1]);
    const data = s.indexOf("stream\n", at) + "stream\n".length;
    expect(len).toBe(jpeg.length);
    expect(pdf.slice(data, data + len)).toEqual(jpeg);
    // German text in WinAnsi, parentheses escaped, invisible on page 1 (3 Tr) and plain on page 2
    expect(s).toContain("(da\xdf die Ihnen gemachte Mitteilung unrichtig ist.)");
    expect(s).toContain("\\(vom 6. d. Mts.\\)");
    expect(s).toContain("3 Tr");
    expect(s).toContain("(Muse's English translation)");
  });

  it("puts each rebuilt page on its own image page, before the text pages", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 40, height: 50, channels: 3, background: "#ffffff" } }).jpeg().toBuffer());
    const s = latin1(buildPdf({ pages: [{ jpeg, width: 40, height: 50, transcript: "one" }, { jpeg, width: 40, height: 50, transcript: "two" }], title: "t", summary: [] }));
    expect(/\/Count (\d+)/.exec(s)![1]).toBe("3");
    expect(s).toContain("/Im2 Do");
    expect(s).toContain("(Muse's transcript of page 2)");
  });

  it("encodes WinAnsi: curly quotes and dashes map, other scripts become ?", () => {
    expect(latin1(Uint8Array.from(pdfString("“ok” – Ü 書")))).toBe("(\x93ok\x94 \x96 \xdc ?)");
  });
});
