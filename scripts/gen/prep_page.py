"""Prepare a scanned page for a stack tear: crop to the sheet and flatten its paper to one tone.

Usage: python -I scripts/gen/prep_page.py <scan.jpg> <out.png> [--crop l,t,r,b] [--tone R,G,B | --tone-from ref.png]
                                         [--width N] [--aspect A] [--ink G]
--crop    fractions of the scan to keep (drops the scanner's background and edge strips)
--tone    the paper colour to flatten to; --tone-from takes it from another page (its bright 40%)
--aspect  pad with paper to width/height = A (side margins on a taller page, a foot on a wider one): pages of one
          stack need one size, and padding never cuts text
--ink     darken faint ink: the ink-to-paper ratio is raised to this power (1 = unchanged)
Flattening divides each channel by a smooth estimate of the local paper colour (ink removed by a max filter), so
stains, yellowing and fold shadows go and every page of the stack shares one paper stock; ink keeps its contrast.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter


def paper_tone(a):
    lum = a.mean(axis=2)
    return a[lum > np.percentile(lum, 60)].mean(axis=0)


def flatten(im, tone, ink=1.0):
    small = im.resize((max(1, im.width // 8), max(1, im.height // 8)), Image.BILINEAR)
    bg = small.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(6)).resize(im.size, Image.BILINEAR)
    a = np.asarray(im).astype(np.float32)
    b = np.maximum(np.asarray(bg).astype(np.float32), 1)
    r = np.clip(a / b, 0, 1.2)
    if ink != 1.0:
        r = np.where(r < 1, r ** ink, r)
    return Image.fromarray(np.clip(r * np.asarray(tone, np.float32)[None, None, :], 0, 255).astype(np.uint8))


def pad_to(im, aspect, tone, rng):
    w, h = im.size
    W, H = (round(h * aspect), h) if w / h < aspect else (w, round(w / aspect))
    a = np.asarray(tone, np.float32)[None, None, :] + rng.normal(0, 2.0, (H, W, 1)).astype(np.float32)
    canvas = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8).repeat(1, axis=2) if a.shape[2] == 3 else np.clip(np.repeat(a, 3, axis=2), 0, 255).astype(np.uint8))
    canvas.paste(im, ((W - w) // 2, 0))
    return canvas


def main():
    args = sys.argv[1:]
    opt = lambda k: args[args.index(k) + 1] if k in args else None
    im = Image.open(args[0]).convert("RGB")
    if opt("--crop"):
        l, t, r, b = (float(v) for v in opt("--crop").split(","))
        im = im.crop((round(l * im.width), round(t * im.height), round(r * im.width), round(b * im.height)))
    if opt("--width"):
        w = int(opt("--width"))
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    if opt("--tone"):
        tone = [float(v) for v in opt("--tone").split(",")]
    elif opt("--tone-from"):
        tone = paper_tone(np.asarray(Image.open(opt("--tone-from")).convert("RGB")).astype(np.float32))
    else:
        tone = paper_tone(np.asarray(im).astype(np.float32))
    out = flatten(im, tone, float(opt("--ink") or 1))
    if opt("--aspect"):
        out = pad_to(out, float(opt("--aspect")), tone, np.random.default_rng(1))
    out.save(args[1])
    print(args[1], out.size, "tone", [round(float(v)) for v in tone])


if __name__ == "__main__":
    main()
