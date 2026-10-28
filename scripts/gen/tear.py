"""Rejoin spike: tear a real page image into N pieces with ragged fractal edges, scatter them on a desk, and save
a phone-like photo plus the ground truth (each piece's polygon in page and photo coordinates).

Usage: python tear.py <page.jpg> <out_dir> [n_pieces=10] [seed=7] [--canvas WxH] [--page-width N] [--buffer PX]
                      [--smooth-desk] [--quality Q] [--stack page2.jpg page3.jpg]
With --stack, the SAME tear paths cut every page (pieces with identical outlines, as when a folded stack is torn). Stack
pages are centre-cropped to the first page's aspect (not stretched) and re-levelled to its paper tone (one paper stock).
(Copied from the spike, spikes/v3/tear.py; added --canvas and --page-width for the 30-piece stack photo, and --buffer,
--smooth-desk and --quality for the first screen's high-resolution samples. --smooth-desk interpolates the desk's
coarse noise instead of repeating it in 8 px blocks, from the same random draws, so a seed gives the same tear.)
"""
import json, math, random, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.affinity import rotate, translate
from shapely.geometry import LineString, Polygon, box
from shapely.ops import split


def fit_aspect(im, aspect):
    """Centre-crop to width/height = aspect (trims the side margins of a wider page, the foot of a taller one)."""
    if im.width / im.height > aspect:
        w = round(im.height * aspect)
        x = (im.width - w) // 2
        return im.crop((x, 0, x + w, im.height))
    h = round(im.width / aspect)
    return im.crop((0, 0, im.width, h))


def match_paper(im, ref):
    """Re-level a page so its paper tone matches `ref` (stacked pages are one paper stock)."""
    def tone(a):
        lum = a.mean(axis=2)
        return a[lum > np.percentile(lum, 60)].mean(axis=0)
    a = np.asarray(im).astype(float)
    a = a * (tone(np.asarray(ref).astype(float)) / np.maximum(tone(a), 1))[None, None, :]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def load_page(path, width=820):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(int)
    # crop a scanner's black border: keep rows/cols whose median brightness is paper-like
    rows = np.where(np.median(a.mean(axis=2), axis=1) > 90)[0]
    cols = np.where(np.median(a.mean(axis=2), axis=0) > 90)[0]
    im = im.crop((cols[0] + 4, rows[0] + 4, cols[-1] - 4, rows[-1] - 4))
    h = round(im.height * width / im.width)
    return im.resize((width, h), Image.LANCZOS)


def fractal_line(p0, p1, rng, depth=8, rough=0.07, decay=0.56):
    pts = [np.array(p0, float), np.array(p1, float)]
    amp = rough * np.linalg.norm(pts[1] - pts[0])
    for _ in range(depth):
        out = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            d = b - a
            n = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-9)
            out += [(a + b) / 2 + n * rng.normal(0, amp), b]
        pts, amp = out, amp * decay
    return LineString([tuple(p) for p in pts])


def tear_paths(w, h, n, rng):
    """Recursively split the page rectangle with ragged lines until n pieces; returns the pieces and the cut lines."""
    pieces, cuts = [box(0, 0, w, h)], []
    tries = 0
    while len(pieces) < n and tries < 500:
        tries += 1
        i = max(range(len(pieces)), key=lambda k: pieces[k].area * rng.uniform(0.7, 1.3))
        poly = pieces[i]
        c = poly.centroid
        ang = rng.uniform(0, math.pi)
        L = 2 * max(w, h)
        off = rng.normal(0, 0.12) * math.sqrt(poly.area)
        cx, cy = c.x + off * math.cos(ang + math.pi / 2), c.y + off * math.sin(ang + math.pi / 2)
        line = fractal_line((cx - L * math.cos(ang), cy - L * math.sin(ang)), (cx + L * math.cos(ang), cy + L * math.sin(ang)), rng)
        parts = [g for g in split(poly, line).geoms if g.geom_type == "Polygon"]
        if len(parts) != 2 or min(p.area for p in parts) < 0.035 * w * h:
            continue
        pieces[i:i + 1] = parts
        cuts.append(line)
    return pieces, cuts


def wood(W, H, rng, smooth=False):
    y = np.arange(H)[:, None]
    x = np.arange(W)[None, :]
    grain = np.sin((y + 18 * np.sin(x / 240 + rng.uniform(0, 6)) + 9 * np.sin(x / 57)) / 7.0)
    noise = rng.normal(0, 1, (H // 8 + 1, W // 8 + 1))
    if smooth:
        im = Image.fromarray(noise.astype(np.float32), mode="F").resize(((W // 8 + 1) * 8, (H // 8 + 1) * 8), Image.BICUBIC)
        noise = np.asarray(im)[:H, :W]
    else:
        noise = np.kron(noise, np.ones((8, 8)))[:H, :W]
    base = np.array([128, 92, 62], float)
    img = base[None, None, :] * (1 + 0.06 * grain[..., None] + 0.04 * noise[..., None])
    img += rng.normal(0, 3, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def piece_image(page, poly, cuts, rng):
    """RGBA crop of the page inside poly, with a white fibrous rim along torn (non-page-edge) boundary points."""
    minx, miny, maxx, maxy = [int(v) for v in poly.bounds]
    minx, miny = max(minx - 2, 0), max(miny - 2, 0)
    crop = page.crop((minx, miny, maxx + 3, maxy + 3)).convert("RGBA")
    m = Image.new("L", crop.size, 0)
    local = [(x - minx, y - miny) for x, y in poly.exterior.coords]
    ImageDraw.Draw(m).polygon(local, fill=255)
    rim = Image.new("L", crop.size, 0)
    dr = ImageDraw.Draw(rim)
    W, H = page.size
    for (x0, y0), (x1, y1) in zip(local[:-1], local[1:]):
        gx, gy = (x0 + x1) / 2 + minx, (y0 + y1) / 2 + miny
        on_page_edge = min(gx, gy, W - gx, H - gy) < 1.5
        if not on_page_edge and rng.random() < 0.85:
            dr.line([(x0, y0), (x1, y1)], fill=int(rng.uniform(150, 255)), width=int(rng.integers(2, 5)))
    rim = rim.filter(ImageFilter.GaussianBlur(0.7))
    white = Image.new("RGBA", crop.size, (246, 244, 236, 255))
    crop = Image.composite(white, crop, rim)
    crop.putalpha(m)
    return crop, (minx, miny)


def scatter(pages, polys, cuts, out, rng, W=2400, H=1800, buffer=12, smooth=False, quality=88):
    canvas = wood(W, H, rng, smooth).convert("RGBA")
    shadow = Image.new("L", (W, H), 0)
    placed, gt = [], []
    layers = []
    for pi, page in enumerate(pages):
        for k, poly in enumerate(polys):
            img, (ox, oy) = piece_image(page, poly, cuts, rng)
            ang = rng.uniform(0, 360)
            rot = img.rotate(ang, expand=True, resample=Image.BICUBIC)
            # the piece polygon, in page coords -> rotated about the crop centre like PIL does
            cx, cy = ox + img.width / 2, oy + img.height / 2
            g = rotate(poly, -ang, origin=(cx, cy))
            for _ in range(3000):
                tx = rng.uniform(40, W - rot.width - 40)
                ty = rng.uniform(40, H - rot.height - 40)
                gp = translate(g, tx - (cx - rot.width / 2), ty - (cy - rot.height / 2))
                if all(not gp.buffer(buffer).intersects(q) for q in placed):
                    break
            else:
                raise SystemExit("could not place all pieces; use a bigger canvas or fewer pieces")
            placed.append(gp)
            layers.append((rot, (int(round(tx)), int(round(ty)))))
            ImageDraw.Draw(shadow).polygon([(x + 7, y + 9) for x, y in gp.exterior.coords], fill=120)
            gt.append({"page": pi, "piece": k, "angle_deg": ang, "page_polygon": [list(map(float, p)) for p in poly.exterior.coords],
                       "photo_polygon": [list(map(float, p)) for p in gp.exterior.coords]})
    shadow = shadow.filter(ImageFilter.GaussianBlur(9))
    canvas = Image.composite(Image.new("RGBA", (W, H), (30, 20, 12, 255)), canvas, shadow.point(lambda v: int(v * 0.55)))
    for rot, (x, y) in layers:
        canvas.alpha_composite(rot, (x, y))
    # phone-like finish: gentle vignette, noise, JPEG
    a = np.asarray(canvas.convert("RGB")).astype(float)
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.18 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    a = a * v[..., None] + rng.normal(0, 2.5, a.shape)
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(out / "photo.jpg", quality=quality)
    return gt


def main():
    args = sys.argv[1:]
    canvas, page_w = None, 820
    if "--canvas" in args:
        i = args.index("--canvas")
        canvas = tuple(int(v) for v in args[i + 1].split("x"))
        args = args[:i] + args[i + 2:]
    if "--page-width" in args:
        i = args.index("--page-width")
        page_w = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    buffer, quality, smooth = 12, 88, False
    if "--buffer" in args:
        i = args.index("--buffer")
        buffer = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    if "--quality" in args:
        i = args.index("--quality")
        quality = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    if "--smooth-desk" in args:
        smooth = True
        args.remove("--smooth-desk")
    stack = []
    if "--stack" in args:
        i = args.index("--stack")
        stack, args = args[i + 1:], args[:i]
    page_path, out = args[0], Path(args[1])
    n = int(args[2]) if len(args) > 2 else 10
    seed = int(args[3]) if len(args) > 3 else 7
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)
    first = load_page(page_path, page_w)
    aspect = first.width / first.height
    pages = [first] + [match_paper(fit_aspect(load_page(p, page_w), aspect).resize(first.size, Image.LANCZOS), first) for p in stack]
    W, H = pages[0].size
    polys, cuts = tear_paths(W, H, n, rng)
    for i, p in enumerate(pages):
        p.save(out / f"page{i}.png")
    big = len(pages) > 1
    W0, H0 = canvas or ((3000, 2200) if big else (2400, 1800))
    gt = scatter(pages, polys, cuts, out, rng, W=W0, H=H0, buffer=buffer, smooth=smooth, quality=quality)
    json.dump({"page_size": [W, H], "photo_size": [W0, H0], "pages": [page_path] + stack, "seed": seed, "n_pieces": len(polys) * len(pages), "cuts": [list(map(list, c.coords)) for c in cuts], "pieces": gt},
              open(out / "gt.json", "w"), indent=1)
    print(f"{len(polys)} pieces per page x {len(pages)} page(s) -> {out / 'photo.jpg'}")


if __name__ == "__main__":
    main()
