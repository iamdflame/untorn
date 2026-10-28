"""Bench-S: torn-document cases for the Rejoin solver, with exact ground truth.

Each case tears one or more real page images into pieces along ragged, fractal tear paths (a white fibre rim on one
side of every tear) or straight cuts, scatters the pieces on a wood desk with shadows, and writes a phone-like photo
plus the ground truth. Masks come in two versions: exact (`masks_gt.png`) and with SAM-like boundary noise
(`masks_sam.png`, median ~0.65 px and p90 ~1.8 px boundary error, as SAM 3.1 measured in the spike).

Usage (from the repo root, with numpy, Pillow and shapely):
  python -I scripts/bench/generate.py                       # every family, into scripts/bench/out/
  python -I scripts/bench/generate.py --family single --limit 3
  python -I scripts/bench/generate.py --calibrate           # print the noise model's boundary-error statistics
Families and their fixed seeds are listed in FAMILIES below; pages come from scripts/bench/pages/ (fetch_pages.py).

Per case directory:
  photo.jpg       the scattered pieces (JPEG 88)
  masks_gt.png    8-bit labels: 0 = desk, k + 1 = fragment k (exact rasterization at pixel centres)
  masks_sam.png   the same labels with SAM-like boundary noise (what the solver gets)
  gt.json         pages, fragments (page polygon, pose page→photo), ground-truth joins, twin classes, cuts
Conventions: x right, y down; pixel (c, r) covers [c, c+1) × [r, r+1); a pose maps page → photo as
p' = R(theta)·p + (tx, ty) with R = [[cos, −sin], [sin, cos]], the same as the solver's Pose.
"""
import argparse, json, math, sys, time
from pathlib import Path

import numpy as np
import shapely
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import LineString, Polygon, box
from shapely.ops import split

HERE = Path(__file__).resolve().parent
PAGE_WIDTH = 1000

# family: (seeds, pieces per page range, pages per case, kind)
FAMILIES = {
    "single": (list(range(1001, 1025)), (8, 12), 1, "tear"),
    "small": (list(range(1101, 1107)), (6, 7), 1, "tear"),
    "large": (list(range(2001, 2009)), (20, 40), 1, "tear"),
    "mixed": (list(range(3001, 3009)), (6, 10), (2, 3), "tear"),
    "stack": (list(range(4001, 4009)), (6, 10), 3, "stack"),
    "cut": (list(range(5001, 5007)), (8, 12), 1, "cut"),
    # tuning set: never used for the reported numbers
    "dev": (list(range(9001, 9013)), (8, 12), 1, "tear"),
    "devstack": (list(range(9101, 9105)), (6, 10), 3, "stack"),
}


# ---------------------------------------------------------------- pages

def load_page(path, width=PAGE_WIDTH):
    """A page image cropped of scanner borders and resized to `width`, as float RGB."""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(float)
    lum = a.mean(axis=2)
    rows = np.where(np.median(lum, axis=1) > 90)[0]
    cols = np.where(np.median(lum, axis=0) > 90)[0]
    if len(rows) > 10 and len(cols) > 10:
        im = im.crop((int(cols[0]) + 4, int(rows[0]) + 4, int(cols[-1]) - 4, int(rows[-1]) - 4))
    h = round(im.height * width / im.width)
    return np.asarray(im.resize((width, h), Image.LANCZOS)).astype(np.float32)


def match_paper(page, ref):
    """Shift a page's colours so its paper tone matches `ref` (stacked pages are one paper stock)."""
    def tone(a):
        lum = a.mean(axis=2)
        m = lum > np.percentile(lum, 60)
        return a[m].mean(axis=0)
    return np.clip(page * (tone(ref) / np.maximum(tone(page), 1))[None, None, :], 0, 255)


# ---------------------------------------------------------------- tears

def fractal_path(p0, p1, rng, a100=20.0, hurst=0.75, finest=1.5, fine=12.0):
    """A ragged path from p0 to p1 by midpoint displacement: the displacement at scale s px has std ½·a100·(s/100)^H,
    tapering below `fine` px (paper fibres are fuzz, not spikes; a mask never resolves them)."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    pts = [p0, p1]
    while np.linalg.norm(pts[1] - pts[0]) > finest:
        out = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            d = b - a
            s = np.linalg.norm(d)
            n = np.array([-d[1], d[0]]) / (s + 1e-9)
            amp = a100 * (s / 100) ** hurst * 0.5 * min(1.0, s / fine) ** 0.6
            out += [(a + b) / 2 + n * rng.normal(0, amp), b]
        pts = out
    return LineString([tuple(p) for p in pts])


def tear_page(w, h, n, rng, cut_share=0.0):
    """Split the page rectangle recursively along ragged tears (or straight cuts) until n pieces.
    Returns pieces (polygons), cuts (LineStrings), each cut's rim side (+1 left, -1 right, 0 none) and per-piece
    {cut index: side} for the cuts it was split by."""
    pieces = [box(0, 0, w, h)]
    sides = [{}]
    cuts, rim = [], []
    tries = 0
    while len(pieces) < n and tries < 2000:
        tries += 1
        i = max(range(len(pieces)), key=lambda k: pieces[k].area * rng.uniform(0.6, 1.4))
        poly = pieces[i]
        c = poly.centroid
        # tear across the piece's shorter direction more often (people tear big pieces in half)
        minx, miny, maxx, maxy = poly.bounds
        across = 0 if (maxx - minx) > (maxy - miny) else math.pi / 2
        ang = across + math.pi / 2 + rng.normal(0, 0.45)
        L = 1.2 * math.hypot(maxx - minx, maxy - miny)
        off = rng.normal(0, 0.15) * math.sqrt(poly.area)
        cx, cy = c.x + off * math.cos(ang + math.pi / 2), c.y + off * math.sin(ang + math.pi / 2)
        a = (cx - L * math.cos(ang), cy - L * math.sin(ang))
        b = (cx + L * math.cos(ang), cy + L * math.sin(ang))
        straight = rng.random() < cut_share
        line = LineString([a, b]) if straight else fractal_path(a, b, rng)
        parts = [g for g in split(poly, line).geoms if g.geom_type == "Polygon"]
        if len(parts) != 2 or min(p.area for p in parts) < 0.03 * w * h / max(1, n / 10):
            continue
        k = len(cuts)
        cuts.append(line)
        rim.append(0 if straight else int(rng.choice([-1, 1])))
        new_sides = []
        for p in parts:
            s = dict(sides[i])
            s[k] = side_of(line, p)
            new_sides.append(s)
        pieces[i:i + 1] = parts
        sides[i:i + 1] = new_sides
    return pieces, cuts, rim, sides


def side_of(line, poly):
    """+1 when the polygon lies left of the line's direction, -1 when right."""
    p = poly.representative_point()
    d = line.project(p)
    q = line.interpolate(d)
    q2 = line.interpolate(min(line.length, d + 1.0))
    q1 = line.interpolate(max(0.0, d - 1.0))
    t = np.array([q2.x - q1.x, q2.y - q1.y])
    v = np.array([p.x - q.x, p.y - q.y])
    return 1 if t[0] * v[1] - t[1] * v[0] < 0 else -1  # y down: negative cross = left on screen


# ---------------------------------------------------------------- rendering

def piece_texture(page, poly, cuts, rim, sides, rng):
    """The page pixels of a piece's bounding box with a white fibre rim along its torn edges on the rim side."""
    minx, miny, maxx, maxy = poly.bounds
    x0, y0 = max(int(minx) - 3, 0), max(int(miny) - 3, 0)
    x1, y1 = min(int(maxx) + 4, page.shape[1]), min(int(maxy) + 4, page.shape[0])
    tex = page[y0:y1, x0:x1].copy()
    rim_img = Image.new("L", (x1 - x0, y1 - y0), 0)
    dr = ImageDraw.Draw(rim_img)
    coords = np.asarray(poly.exterior.coords)
    mid = (coords[:-1] + coords[1:]) / 2
    for k, side in sides.items():
        if rim[k] == 0 or side != rim[k]:
            continue
        near = cuts[k].buffer(0.75)
        shapely.prepare(near)
        on = shapely.contains_xy(near, mid[:, 0], mid[:, 1])
        for j in np.nonzero(on)[0]:
            if rng.random() < 0.9:
                (ax, ay), (bx, by) = coords[j], coords[j + 1]
                dr.line([(ax - x0, ay - y0), (bx - x0, by - y0)], fill=int(rng.uniform(150, 255)), width=int(rng.integers(2, 5)))
    rim_a = np.asarray(rim_img.filter(ImageFilter.GaussianBlur(0.7))).astype(np.float32)[..., None] / 255
    fibre = np.array([246, 244, 236], np.float32) + rng.normal(0, 4, tex.shape).astype(np.float32)
    tex = tex * (1 - rim_a) + fibre * rim_a
    return tex, (x0, y0)


def wood(W, H, rng):
    y = np.arange(H)[:, None]
    x = np.arange(W)[None, :]
    grain = np.sin((y + 18 * np.sin(x / 240 + rng.uniform(0, 6)) + 9 * np.sin(x / 57)) / 7.0)
    noise = np.kron(rng.normal(0, 1, (H // 8 + 1, W // 8 + 1)), np.ones((8, 8)))[:H, :W]
    base = np.array([128, 92, 62], np.float32)
    img = base[None, None, :] * (1 + 0.06 * grain[..., None] + 0.04 * noise[..., None])
    return (img + rng.normal(0, 3, img.shape)).astype(np.float32)


def bilinear(img, u, v):
    """Sample img (H, W, C) at continuous coords (pixel centres at +0.5)."""
    H, W = img.shape[:2]
    fu, fv = u - 0.5, v - 0.5
    x0 = np.clip(np.floor(fu).astype(int), 0, W - 1)
    y0 = np.clip(np.floor(fv).astype(int), 0, H - 1)
    x1 = np.clip(x0 + 1, 0, W - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    tx = np.clip(fu - np.floor(fu), 0, 1)[..., None]
    ty = np.clip(fv - np.floor(fv), 0, 1)[..., None]
    return (img[y0, x0] * (1 - tx) * (1 - ty) + img[y0, x1] * tx * (1 - ty) + img[y1, x0] * (1 - tx) * ty + img[y1, x1] * tx * ty)


def pose_apply(pose, pts):
    c, s = math.cos(pose["theta"]), math.sin(pose["theta"])
    pts = np.asarray(pts, float)
    return np.stack([c * pts[:, 0] - s * pts[:, 1] + pose["tx"], s * pts[:, 0] + c * pts[:, 1] + pose["ty"]], axis=1)


def pose_inverse_apply(pose, pts):
    c, s = math.cos(pose["theta"]), math.sin(pose["theta"])
    pts = np.asarray(pts, float) - [pose["tx"], pose["ty"]]
    return np.stack([c * pts[:, 0] + s * pts[:, 1], -s * pts[:, 0] + c * pts[:, 1]], axis=1)


def raster_polygon(poly, W, H):
    """Pixels whose centres lie inside poly: (rows, cols) index arrays."""
    minx, miny, maxx, maxy = poly.bounds
    c0, r0 = max(int(math.floor(minx)), 0), max(int(math.floor(miny)), 0)
    c1, r1 = min(int(math.ceil(maxx)) + 1, W), min(int(math.ceil(maxy)) + 1, H)
    if c1 <= c0 or r1 <= r0:
        return np.zeros(0, int), np.zeros(0, int)
    cc, rr = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    shapely.prepare(poly)
    inside = shapely.contains_xy(poly, cc.ravel() + 0.5, rr.ravel() + 0.5)
    return rr.ravel()[inside], cc.ravel()[inside]


# ---------------------------------------------------------------- SAM-like mask noise

def noisy_polygon(poly, rng, sigma=0.72, corr=5.0, smooth=1.2, blob_rate=1 / 380, blob_amp=2.6):
    """The outline as SAM might return it: lightly smoothed, displaced along its normals by a smooth random field
    (std `sigma` px, correlation `corr` px) plus occasional bumps (SAM errs in blobs)."""
    ring = np.asarray(poly.exterior.coords)[:-1]
    seg = np.linalg.norm(np.diff(np.vstack([ring, ring[:1]]), axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    m = max(16, int(total))
    s = np.linspace(0, total, m, endpoint=False)
    x = np.interp(s, cum, np.append(ring[:, 0], ring[0, 0]))
    y = np.interp(s, cum, np.append(ring[:, 1], ring[0, 1]))

    def circ_smooth(v, sd):
        if sd <= 0:
            return v
        r = int(3 * sd) + 1
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sd) ** 2)
        k /= k.sum()
        return np.convolve(np.concatenate([v[-r:], v, v[:r]]), k, mode="valid")

    x, y = circ_smooth(x, smooth), circ_smooth(y, smooth)
    tx, ty = np.roll(x, -2) - np.roll(x, 2), np.roll(y, -2) - np.roll(y, 2)
    nrm = np.hypot(tx, ty) + 1e-9
    nx, ny = ty / nrm, -tx / nrm
    field = circ_smooth(rng.normal(0, 1, m), corr)
    field *= sigma / (field.std() + 1e-9)
    for _ in range(rng.poisson(total * blob_rate)):
        c = rng.integers(0, m)
        width = rng.uniform(8, 30)
        d = np.minimum(np.abs(np.arange(m) - c), m - np.abs(np.arange(m) - c))
        field += rng.choice([-1, 1]) * rng.uniform(0.5, 1) * blob_amp * np.exp(-0.5 * (d / width) ** 2)
    out = Polygon(np.stack([x + nx * field, y + ny * field], axis=1))
    if not out.is_valid:
        out = out.buffer(0)
        if out.geom_type != "Polygon":
            out = max(out.geoms, key=lambda g: g.area)
    return out


def boundary_error(mask_rc, poly, W, H):
    """Distance from each boundary pixel centre of a mask to the true outline (median, p90), like eval_masks.py."""
    rr, cc = mask_rc
    if not len(rr):
        return None
    r0, c0 = rr.min() - 1, cc.min() - 1
    m = np.zeros((rr.max() - r0 + 2, cc.max() - c0 + 2), bool)
    m[rr - r0, cc - c0] = True
    pad = np.pad(m, 1)
    edge = m & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    ys, xs = np.nonzero(edge)
    pts = shapely.points(xs + c0 + 0.5, ys + r0 + 0.5)
    d = shapely.distance(pts, poly.exterior)
    return float(np.median(d)), float(np.percentile(d, 90))


# ---------------------------------------------------------------- cases

def place(polys, W, H, rng, margin=40, gap=14):
    """Random rotation and position for each polygon (page coords) so that none touch. Returns poses."""
    poses, placed = [], []
    tree_boxes = []
    for poly in polys:
        poly = poly.simplify(1.5)
        for _ in range(4000):
            theta = rng.uniform(-math.pi, math.pi)
            c = poly.centroid
            pose = {"theta": theta, "tx": 0.0, "ty": 0.0}
            q = pose_apply(pose, np.asarray(poly.exterior.coords) - [c.x, c.y])
            minx, miny = q.min(axis=0)
            maxx, maxy = q.max(axis=0)
            if maxx - minx > W - 2 * margin or maxy - miny > H - 2 * margin:
                continue
            ox = rng.uniform(margin - minx, W - margin - maxx)
            oy = rng.uniform(margin - miny, H - margin - maxy)
            g = Polygon(q + [ox, oy])
            bx0, by0, bx1, by1 = g.bounds
            clash = False
            for p, (px0, py0, px1, py1) in zip(placed, tree_boxes):
                if bx0 - gap > px1 or px0 - gap > bx1 or by0 - gap > py1 or py0 - gap > by1:
                    continue
                if g.distance(p) < gap:
                    clash = True
                    break
            if not clash:
                # pose: page → photo = R(theta)·(p − c) + o = R(theta)·p + (o − R(theta)·c)
                ct, st = math.cos(theta), math.sin(theta)
                pose = {"theta": theta, "tx": ox - (ct * c.x - st * c.y), "ty": oy - (st * c.x + ct * c.y)}
                poses.append(pose)
                placed.append(g)
                tree_boxes.append(g.bounds)
                break
        else:
            return None
    return poses


def make_case(family, seed, page_files, out_dir, sample=False):
    seeds, nrange, npages, kind = FAMILIES[family]
    rng = np.random.default_rng(seed)
    if isinstance(npages, tuple):
        npages = int(rng.integers(npages[0], npages[1] + 1))
    picks = rng.choice(len(page_files), size=npages, replace=False)
    pages = [load_page(page_files[i]) for i in picks]
    if kind == "stack":
        H0, W0 = pages[0].shape[:2]
        pages = [pages[0]] + [match_paper(np.asarray(Image.fromarray(p.astype(np.uint8)).resize((W0, H0), Image.LANCZOS)).astype(np.float32), pages[0]) for p in pages[1:]]
    tears = []
    for pi, page in enumerate(pages):
        if kind == "stack" and pi > 0:
            tears.append(tears[0])
            continue
        n = int(rng.integers(nrange[0], nrange[1] + 1))
        h, w = page.shape[:2]
        tears.append(tear_page(w, h, n, rng, cut_share=0.35 if kind == "cut" else 0.0))
    frags = []
    for pi, (page, (pieces, cuts, rim, sides)) in enumerate(zip(pages, tears)):
        for k, poly in enumerate(pieces):
            frags.append({"page": pi, "piece": k, "poly": poly, "sides": sides[k]})
    order = rng.permutation(len(frags))
    frags = [frags[i] for i in order]
    area = sum(f["poly"].area for f in frags)
    for scale in (2.8, 3.4, 4.2, 5.2):
        W = int(math.sqrt(area * scale * 1.45))
        H = int(W / 1.45)
        poses = place([f["poly"] for f in frags], W, H, rng)
        if poses:
            break
    else:
        raise SystemExit(f"{family}/{seed}: could not place the pieces")
    photo = wood(W, H, rng)
    shadow = Image.new("L", (W, H), 0)
    sd = ImageDraw.Draw(shadow)
    labels_gt = np.zeros((H, W), np.uint8)
    labels_sam = np.zeros((H, W), np.uint8)
    errs = []
    layers = []
    for idx, (f, pose) in enumerate(zip(frags, poses)):
        pieces, cuts, rim, _ = tears[f["page"]]
        tex, (ox, oy) = piece_texture(pages[f["page"]], f["poly"], cuts, rim, f["sides"], rng)
        photo_poly = Polygon(pose_apply(pose, np.asarray(f["poly"].exterior.coords)))
        rr, cc = raster_polygon(photo_poly, W, H)
        labels_gt[rr, cc] = idx + 1
        sam_poly = noisy_polygon(photo_poly, rng)
        sr, sc = raster_polygon(sam_poly, W, H)
        labels_sam[sr, sc] = idx + 1
        e = boundary_error((sr, sc), photo_poly, W, H)
        if e:
            errs.append(e)
        sd.polygon([(x + 7, y + 9) for x, y in photo_poly.exterior.coords], fill=120)
        pg = pose_inverse_apply(pose, np.stack([cc + 0.5, rr + 0.5], axis=1))
        layers.append((rr, cc, bilinear(tex, pg[:, 0] - ox, pg[:, 1] - oy)))
        f["pose"] = pose
        f["label"] = idx + 1
    sh = np.asarray(shadow.filter(ImageFilter.GaussianBlur(9))).astype(np.float32)[..., None] / 255 * 0.55
    photo = photo * (1 - sh) + np.array([30, 20, 12], np.float32) * sh
    for rr, cc, rgb in layers:
        photo[rr, cc] = rgb
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.18 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    photo = photo * v[..., None] + rng.normal(0, 2.5, photo.shape)
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(photo, 0, 255).astype(np.uint8)).save(out_dir / "photo.jpg", quality=85 if sample else 88)
    Image.fromarray(labels_gt).save(out_dir / "masks_gt.png", optimize=True)
    Image.fromarray(labels_sam).save(out_dir / "masks_sam.png", optimize=True)
    # ground-truth joins: fragments of one page sharing at least 20 px of boundary
    joins = []
    for i in range(len(frags)):
        for j in range(i + 1, len(frags)):
            if frags[i]["page"] != frags[j]["page"]:
                continue
            shared = frags[i]["poly"].boundary.intersection(frags[j]["poly"].buffer(0.75)).length
            if shared >= 20:
                joins.append({"a": i, "b": j, "length": round(shared, 1)})
    # stack twins: same piece index on different pages share an outline
    twins = []
    if kind == "stack":
        for k in range(len(tears[0][0])):
            twins.append([i for i, f in enumerate(frags) if f["piece"] == k])
    gt = {
        "family": family, "seed": seed, "kind": kind,
        "photo": {"width": W, "height": H},
        "pages": [{"source": Path(page_files[i]).name, "width": int(p.shape[1]), "height": int(p.shape[0])} for i, p in zip(picks, pages)],
        "fragments": [{"id": f"f{i:02d}", "label": f["label"], "page": f["page"], "piece": f["piece"],
                       "pose": {k: round(v, 6) for k, v in f["pose"].items()},
                       "page_polygon": [[round(x, 2), round(y, 2)] for x, y in f["poly"].exterior.coords[:-1]]}
                      for i, f in enumerate(frags)],
        "joins": joins,
        "twins": twins,
        "noise": {"median_px": round(float(np.median([e[0] for e in errs])), 3), "p90_px": round(float(np.median([e[1] for e in errs])), 3),
                  "worst_p90_px": round(float(max(e[1] for e in errs)), 3)},
    }
    (out_dir / "gt.json").write_text(json.dumps(gt, separators=(",", ":")))
    return gt


def page_list():
    files = sorted(p for p in (HERE / "pages").glob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if not files:
        raise SystemExit("no pages in scripts/bench/pages/: run fetch_pages.py first")
    return files


def calibrate():
    rng = np.random.default_rng(5)
    errs = []
    for k in range(12):
        poly = tear_page(1000, 1300, 10, rng)[0][k % 10]
        c = poly.centroid
        th = rng.uniform(-3, 3)
        pose = {"theta": th, "tx": 2000.0 - (math.cos(th) * c.x - math.sin(th) * c.y), "ty": 2000.0 - (math.sin(th) * c.x + math.cos(th) * c.y)}
        pp = Polygon(pose_apply(pose, np.asarray(poly.exterior.coords)))
        sam = noisy_polygon(pp, rng)
        e = boundary_error(raster_polygon(sam, 4000, 4000), pp, 4000, 4000)
        exact = boundary_error(raster_polygon(pp, 4000, 4000), pp, 4000, 4000)
        errs.append(e)
        print(f"piece {k}: noisy median {e[0]:.2f} p90 {e[1]:.2f} | exact raster median {exact[0]:.2f} p90 {exact[1]:.2f}")
    print(f"median of medians {np.median([e[0] for e in errs]):.2f} px, worst p90 {max(e[1] for e in errs):.2f} px (SAM spike: 0.65, 1.83)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--family", default="all")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--sample", action="store_true", help="write a small committed sample to scripts/bench/sample/")
    args = ap.parse_args()
    if args.calibrate:
        return calibrate()
    pages = page_list()
    if args.sample:
        for family, seed in (("single", 1001), ("stack", 4001)):
            t0 = time.time()
            make_case(family, seed, pages, HERE / "sample" / f"{family}-{seed}", sample=True)
            print(f"sample {family}-{seed} in {time.time() - t0:.1f}s")
        return
    fams = list(FAMILIES) if args.family == "all" else args.family.split(",")
    for fam in fams:
        seeds = FAMILIES[fam][0][: args.limit or None]
        for seed in seeds:
            t0 = time.time()
            gt = make_case(fam, seed, pages, Path(args.out) / f"{fam}-{seed}")
            print(f"{fam}-{seed}: {len(gt['fragments'])} fragments, {len(gt['joins'])} joins, noise median "
                  f"{gt['noise']['median_px']} p90 {gt['noise']['p90_px']} ({time.time() - t0:.1f}s)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
