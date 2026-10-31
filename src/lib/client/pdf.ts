// A searchable PDF of the rebuilt pages, made in the browser with no library: each rebuilt page as a JPEG with Muse's
// transcript laid over it as invisible text (search and copy find the words; the transcript carries no word positions,
// so a highlight sits on the right line, not on the exact word), then the transcripts in plain sight and how the pages
// were rebuilt. Text is Helvetica in WinAnsi (Latin scripts, German included); a character outside it
// becomes "?" in the PDF only.

export type PdfPage = {
  /** The rebuilt page as JPEG bytes, and its size in pixels. */
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** Muse's transcript of the page (its own language). */
  transcript: string;
  /** Muse's English translation, for a page in another language. */
  translation?: { text: string; from: string } | null;
};

export type PdfInput = {
  pages: PdfPage[];
  title: string;
  /** Plain lines on how the pages were rebuilt (pieces, joins, the run's address). */
  summary: string[];
  created?: Date;
};

const W = 595; // A4 width in points; the first page takes the image's aspect
const A4H = 842;
const MARGIN = 48;

// WinAnsi bytes for the characters Latin-1 lacks (0x80–0x9F)
const WIN: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** A PDF string literal in WinAnsi: (…) with the delimiters escaped. */
export function pdfString(s: string): number[] {
  const out = [0x28];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    let b: number;
    if (ch in WIN) b = WIN[ch];
    else if (c === 0x0a || c === 0x0d || c === 0x09) b = 0x20;
    else if (c >= 0x20 && c <= 0xff && !(c >= 0x7f && c <= 0x9f)) b = c;
    else if (ch === "│") b = 0x7c;
    else b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return out;
}

/** Lines wrapped to about `chars` characters (Helvetica averages half an em). */
function wrap(text: string, chars: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const word of line.split(/\s+/)) {
      if (cur && (cur + " " + word).length > chars) {
        out.push(cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    out.push(cur);
  }
  return out;
}

const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;

export function buildPdf(input: PdfInput): Uint8Array {
  const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const chunks: (number[] | Uint8Array)[] = [];
  let length = 0;
  const offsets: number[] = [];
  const push = (part: number[] | Uint8Array) => {
    chunks.push(part);
    length += part.length;
  };
  const obj = (n: number, body: (number[] | Uint8Array)[]) => {
    offsets[n] = length;
    push(enc(`${n} 0 obj\n`));
    for (const b of body) push(b);
    push(enc("\nendobj\n"));
  };
  const stream = (dict: string, bytes: number[] | Uint8Array): (number[] | Uint8Array)[] => [enc(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, enc("\nendstream")];
  const text = (x: number, y: number, size: number, s: string, mode = 0, scale = 100) => [...enc(`BT /F1 ${size} Tf ${mode} Tr ${scale.toFixed(1)} Tz ${x.toFixed(1)} ${y.toFixed(1)} Td `), ...pdfString(s), ...enc(" Tj ET\n")];

  // one page per rebuilt page: the image, and its transcript's lines spread over it, invisible, each stretched to the
  // text width
  const imagePages = input.pages.map((pg) => {
    const H = Math.round((W * pg.height) / pg.width);
    const lines = pg.transcript.split("\n");
    const top = H * 0.94;
    const step = (H * 0.88) / Math.max(1, lines.length);
    const size = Math.max(4, Math.min(14, step * 0.8));
    const textW = W * 0.8;
    const layer: number[] = [];
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      const natural = 0.5 * size * l.length;
      layer.push(...text(W * 0.1, top - i * step - size, size, l, 3, Math.max(20, Math.min(300, (100 * textW) / natural))));
    });
    return { H, content: (im: string) => [...enc(`q ${W} 0 0 ${H} 0 0 cm /${im} Do Q\n`), ...layer] };
  });

  // pages 2…: the transcript in plain sight
  const body: { s: string; size: number; gap: number }[] = [
    { s: input.title, size: 15, gap: 22 },
    ...input.summary.map((s) => ({ s, size: 9.5, gap: 13 })),
  ];
  input.pages.forEach((pg, i) => {
    const which = input.pages.length > 1 ? ` of page ${i + 1}` : "";
    const head = pg.translation ? `Muse's transcript${which} (${pg.translation.from})` : `Muse's transcript${which}`;
    body.push({ s: "", size: 9.5, gap: 10 }, { s: head, size: 11, gap: 16 }, ...wrap(pg.transcript, 96).map((s) => ({ s, size: 9.5, gap: 12.5 })));
    if (pg.translation) {
      body.push({ s: "", size: 9.5, gap: 10 }, { s: `Muse's English translation${which}`, size: 11, gap: 16 }, ...wrap(pg.translation.text, 96).map((s) => ({ s, size: 9.5, gap: 12.5 })));
    }
  });
  body.push(
    { s: "", size: 9.5, gap: 10 },
    { s: "The text on each page image is its transcript, laid invisibly over it: searching finds the right line, not the exact", size: 8, gap: 11 },
    { s: "word. Pieces that weren't placed are missing from the image and the text.", size: 8, gap: 11 },
  );
  const pages: number[][] = [];
  let cur: number[] = [];
  let y = A4H - MARGIN;
  for (const b of body) {
    if (y - b.gap < MARGIN) {
      pages.push(cur);
      cur = [];
      y = A4H - MARGIN;
    }
    y -= b.gap;
    if (b.s) cur.push(...text(MARGIN, y, b.size, b.s));
  }
  pages.push(cur);

  // objects: 1 catalog, 2 pages, 3 font, 4 info, then per rebuilt page an image, a page and its content, then a page
  // and its content per text page
  const nImg = imagePages.length;
  const imgObj = (i: number) => 5 + 3 * i;
  const textObj = (i: number) => 5 + 3 * nImg + 2 * i;
  const kids = [...imagePages.map((_, i) => imgObj(i) + 1), ...pages.map((_, i) => textObj(i))];
  push(enc("%PDF-1.4\n"));
  push([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
  obj(1, [enc("<< /Type /Catalog /Pages 2 0 R >>")]);
  obj(2, [enc(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`)]);
  obj(3, [enc("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")]);
  obj(4, [enc("<< /Title "), pdfString(input.title), enc(` /Producer (Untorn) /CreationDate (${pdfDate(input.created ?? new Date())}) >>`)]);
  const fonts = "/Font << /F1 3 0 R >>";
  imagePages.forEach((ip, i) => {
    const pg = input.pages[i];
    const im = `Im${i + 1}`;
    obj(imgObj(i), stream(`/Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, pg.jpeg));
    obj(imgObj(i) + 1, [enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${ip.H}] /Resources << ${fonts} /XObject << /${im} ${imgObj(i)} 0 R >> >> /Contents ${imgObj(i) + 2} 0 R >>`)]);
    obj(imgObj(i) + 2, stream("", ip.content(im)));
  });
  pages.forEach((content, i) => {
    obj(textObj(i), [enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${A4H}] /Resources << ${fonts} >> /Contents ${textObj(i) + 1} 0 R >>`)]);
    obj(textObj(i) + 1, stream("", content));
  });
  const n = textObj(pages.length);
  const xref = length;
  push(enc(`xref\n0 ${n}\n0000000000 65535 f \n`));
  for (let i = 1; i < n; i++) push(enc(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`));
  push(enc(`trailer\n<< /Size ${n} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** In the browser: each page image (any format the browser draws) to JPEG, then the PDF. */
export async function pagesPdf(pages: (Omit<PdfPage, "jpeg" | "width" | "height"> & { image: string })[], rest: Omit<PdfInput, "pages">): Promise<Blob> {
  const out: PdfPage[] = [];
  for (const { image, ...pg } of pages) out.push({ ...pg, ...(await toJpeg(image)) });
  const bytes = buildPdf({ ...rest, pages: out });
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
}

async function toJpeg(imageUrl: string): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const blob = await (await fetch(imageUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!jpeg) throw new Error("no jpeg");
  return { jpeg: new Uint8Array(await jpeg.arrayBuffer()), width: canvas.width, height: canvas.height };
}
