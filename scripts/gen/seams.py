"""Seam test items for the reading bench, without any API calls. Derived from the spike generators
(spikes/v3/crossword.py for binary joins, spikes/v3/crossword3.py for the stack-tear k-way case), with switches for
the conditions we compare: window size and how the seam is shown.

Usage: python seams.py <binary|kway> <page.png> <out_dir> [--n 12] [--seed 3] [--win 420x150] [--seam gap|flush]
                       [--page-width 1500] [--k 3]
binary: n true joins (both sides from the same place, right side misplaced by up to 2 px) and n false joins (two
        different places with the text lines at the same phase, stitched along the same ragged tear).
kway:   n trials; a LEFT fragment and k RIGHT candidates cut by the same tear; exactly one continues the left.
Writes <out_dir>/<name>.jpg and <out_dir>/manifest.json ({items: [{file, truth}]}; truth is "true"/"false" or a letter).
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from tear import fractal_line, load_page  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["binary", "kway"])
ap.add_argument("page")
ap.add_argument("out")
ap.add_argument("--n", type=int, default=12)
ap.add_argument("--seed", type=int, default=3)
ap.add_argument("--win", default="420x150")
ap.add_argument("--seam", choices=["gap", "flush"], default="gap")
ap.add_argument("--page-width", type=int, default=1500)
ap.add_argument("--k", type=int, default=3)
a = ap.parse_args()

rng = np.random.default_rng(a.seed)
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
page = load_page(a.page, width=a.page_width)
P = np.asarray(page.convert("L")).astype(float)
Wp, Hp = page.size
WIN_W, WIN_H = (int(v) for v in a.win.split("x"))
_ink = (P < 120).mean(axis=1) - (P < 120).mean()
_ac = np.correlate(_ink, _ink, "full")[len(_ink) - 1:]
PITCH = int(np.argmax(_ac[20:80]) + 20)


def inky(x, y):
    w = P[y - WIN_H // 2:y + WIN_H // 2, x - WIN_W // 2:x + WIN_W // 2]
    return w.shape == (WIN_H, WIN_W) and (w[:, : WIN_W // 2 - 20] < 120).mean() > 0.035 and (w[:, WIN_W // 2 + 20:] < 120).mean() > 0.035


def window(x, y):
    return page.crop((x - WIN_W // 2, y - WIN_H // 2, x + WIN_W // 2, y + WIN_H // 2))


def tear_line():
    return fractal_line((WIN_W / 2 + rng.normal(0, 12), -10), (WIN_W / 2 + rng.normal(0, 12), WIN_H + 10), rng, depth=7, rough=0.10)


def left_mask(line):
    m = Image.new("L", (WIN_W, WIN_H), 0)
    ImageDraw.Draw(m).polygon(list(line.coords) + [(-50, WIN_H + 10), (-50, -10)], fill=255)
    return m


cands = [(x, y) for y in range(WIN_H // 2 + 25, Hp - WIN_H // 2 - 25, 9) for x in range(WIN_W // 2 + 50, Wp - WIN_W // 2 - 50, 13) if inky(x, y)]
rng.shuffle(cands)
items = []

if a.mode == "binary":
    def compose(left_img, right_img):
        line = tear_line()
        comp = Image.composite(left_img, right_img, left_mask(line))
        if a.seam == "gap":
            ImageDraw.Draw(comp).line(list(line.coords), fill=(70, 55, 40), width=3)
        return comp

    made = []
    for i in range(a.n):
        x, y = cands[i]
        dx, dy = int(rng.integers(-2, 3)), int(rng.integers(-2, 3))
        made.append(("true", compose(window(x, y), window(x + dx, y + dy))))
    for i in range(a.n):
        x1, y1 = cands[a.n + i]
        for x2, y2 in cands[2 * a.n:]:
            ph = (y2 - y1) % PITCH
            if (abs(y2 - y1) > 60 or abs(x2 - x1) > 200) and (ph <= 2 or ph >= PITCH - 2):
                break
        made.append(("false", compose(window(x1, y1), window(x2, y2))))
    for k, i in enumerate(rng.permutation(len(made))):
        kind, img = made[i]
        name = f"{k:02d}-{kind}.jpg"
        img.save(out / name, quality=92)
        items.append({"file": name, "truth": kind})
else:
    font = ImageFont.load_default()
    used = 0
    letters = "ABCDEFGHIJKLMNOP"[: a.k]
    for t in range(a.n):
        x, y = cands[used]
        used += 1
        decoys = []
        for x2, y2 in cands[used:]:
            ph = (y2 - y) % PITCH
            if (abs(y2 - y) > 60 or abs(x2 - x) > 200) and (ph <= 2 or ph >= PITCH - 2) and all(abs(y2 - d[1]) > 40 or abs(x2 - d[0]) > 150 for d in decoys):
                decoys.append((x2, y2))
            if len(decoys) == a.k - 1:
                break
        line = tear_line()
        lm = left_mask(line)
        rm = Image.eval(lm, lambda v: 255 - v)
        bg = Image.new("RGB", (WIN_W, WIN_H), (126, 92, 62))
        left = Image.composite(window(x, y), bg, lm)
        if a.seam == "flush":
            pass  # the left piece alone; candidates are shown on their own rows either way
        sources = [(x, y)] + decoys
        order = rng.permutation(a.k)
        sheet = Image.new("RGB", (WIN_W + 40, (WIN_H + 34) * (a.k + 1) + 10), (126, 92, 62))
        d = ImageDraw.Draw(sheet)
        d.text((20, 6), "LEFT FRAGMENT", fill=(255, 255, 255), font=font)
        sheet.paste(left, (20, 20))
        for slot, k in enumerate(order):
            sx, sy = sources[k]
            dx, dy = (int(rng.integers(-2, 3)), int(rng.integers(-2, 3))) if k == 0 else (0, 0)
            right = Image.composite(window(sx + dx, sy + dy), bg, rm)
            top = 20 + (WIN_H + 34) * (slot + 1)
            d.text((20, top - 14), f"CANDIDATE {letters[slot]}", fill=(255, 255, 255), font=font)
            if a.seam == "flush":
                # show the candidate already joined to the left piece, flush, so it reads as one strip
                right = Image.composite(left, right, lm)
            sheet.paste(right, (20, top))
        name = f"trial-{t:02d}-truth-{letters[list(order).index(0)]}.jpg"
        sheet.save(out / name, quality=90)
        items.append({"file": name, "truth": letters[list(order).index(0)]})

json.dump({"mode": a.mode, "page": a.page, "seed": a.seed, "win": [WIN_W, WIN_H], "seam": a.seam, "pitch": PITCH, "items": items},
          open(out / "manifest.json", "w"), indent=1)
print(f"{len(items)} {a.mode} items -> {out} (pitch {PITCH})")
