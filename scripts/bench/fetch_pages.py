"""Fetch Bench-S page images (public domain, Wikimedia Commons) into scripts/bench/pages/ and write PAGES.md.

Usage (from the repo root): python -I scripts/bench/fetch_pages.py [--force]
Requests carry a generic User-Agent and no personal data. Each file's licence is read from Commons' metadata and
recorded; a file whose licence is not public domain is skipped. Commons rate-limits bursts, so requests back off.
"""
import io, json, sys, time
from pathlib import Path

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "pages"
UA = {"User-Agent": "research-script/1.0"}
API = "https://commons.wikimedia.org/w/api.php"

# slug, Commons file title (a DjVu/PDF title takes "#page=N"), kind, language, optional crop box (fractions of
# width/height: left, top, right, bottom)
MANIFEST = [
    ("en-typed-chouteau-1903", "Typewritten letter of Pierre Chouteau, St. Louis, to Miss Mary Louise Dalton, Missouri Historical Society, September 5, 1903 - DPLA - f7afaf7cc9d87b0cfc2d154272e31ea9.jpg", "typed", "en", None),
    ("en-typed-roosevelt-polio", "Letter by Franklin Delano Roosevelt concerning the construction of polio rehabilitation facility - DPLA - 1fcd5b8d2d4fa2e9a6f2e1ab9c3a0f8a.jpg", "typed", "en", None),
    ("en-typed-hochiminh-1945-p2", "1945 Oct 22 Ho Chi Minh letter to US Secretary of State p2.jpg", "typed", "en", None),
    ("de-typed-einstein-1929-p1", "Albert Einstein Brief an Ernst Klug 1929 S01.jpg", "typed", "de", (0.03, 0.02, 0.97, 0.98)),
    ("de-typed-einstein-1929-p2", "Albert Einstein Brief an Ernst Klug 1929 S02.jpg", "typed", "de", (0.03, 0.02, 0.97, 0.98)),
    ("de-typed-stresemann-1922", "Stresemann, Brief.jpg", "typed", "de", (0.05, 0.03, 0.95, 0.97)),
    ("en-printed-psm-1-p40", "Popular Science Monthly Volume 1.djvu#page=40", "printed", "en", (0.04, 0.03, 0.96, 0.97)),
    ("en-printed-psm-1-p120", "Popular Science Monthly Volume 1.djvu#page=120", "printed", "en", (0.04, 0.03, 0.96, 0.97)),
    ("de-printed-gartenlaube-1891-728", "Die Gartenlaube (1891) 728.jpg", "printed", "de", None),
    ("de-printed-gartenlaube-1863-1", "Die Gartenlaube (1863) 001.jpg", "printed", "de", None),
    ("en-hand-lincoln-1854", "Abraham Lincoln Letter to Mr. Brayman September 23, 1854 - NARA - 192847.jpg", "handwritten", "en", None),
    ("en-hand-grover-1863", "Leonard Grover to Abraham Lincoln, March 24, 1863 (front side).jpg", "handwritten", "en", None),
    ("de-hand-goethe-1801", "Goethe an Tieck 1801-11-17.jpg", "handwritten", "de", None),
    ("de-hand-kafka-vater-1", "De Kafka Brief an den Vater 001.jpg", "handwritten", "de", None),
    ("de-hand-planck-1942", "Max Planck an Emil Michelmann 1942-01-11.jpg", "handwritten", "de", None),
]


def get(url, params=None, binary=False):
    for k in range(10):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=(15, 60))
            if r.status_code == 200 and (binary or r.text.startswith("{")):
                return r.content if binary else r.json()
            wait = int(r.headers.get("retry-after", 0) or 0) or 5 * (k + 1)
        except requests.exceptions.RequestException:
            wait = 5 * (k + 1)
        time.sleep(min(60, wait))
    raise SystemExit(f"giving up on {url}")


def search_title(title):
    """Resolve a title that may have changed (DPLA hashes) with a search on its stable prefix."""
    stem = title.split(" - DPLA - ")[0]
    j = get(API, {"action": "query", "list": "search", "srsearch": f'intitle:"{stem}"', "srnamespace": 6, "srlimit": 5, "format": "json"})
    hits = [s["title"] for s in j.get("query", {}).get("search", []) if s["title"].lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff"))]
    return hits[0][5:] if hits else None


def main():
    force = "--force" in sys.argv
    OUT.mkdir(exist_ok=True)
    rows = []
    for slug, title, kind, lang, crop in MANIFEST:
        dest = OUT / f"{slug}.jpg"
        title, _, page_no = title.partition("#page=")
        j = get(API, {"action": "query", "titles": "File:" + title, "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": 1600, "format": "json"})
        page = next(iter(j["query"]["pages"].values()))
        if "imageinfo" not in page:
            alt = search_title(title)
            if not alt:
                print(f"skip {slug}: not found")
                continue
            title = alt
            j = get(API, {"action": "query", "titles": "File:" + title, "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": 1600, "format": "json"})
            page = next(iter(j["query"]["pages"].values()))
        ii = page["imageinfo"][0]
        md = ii.get("extmetadata", {})
        lic = md.get("LicenseShortName", {}).get("value", "")
        if "public domain" not in lic.lower():
            print(f"skip {slug}: licence {lic!r}")
            continue
        if force or not dest.exists():
            url = ii.get("thumburl") or ii["url"]
            if page_no:
                url = url.replace("/page1-", f"/page{page_no}-")
            data = get(url, binary=True)
            im = Image.open(io.BytesIO(data)).convert("RGB")
            if crop:
                w, h = im.size
                im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
            if im.width > 1600:
                im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
            im.save(dest, quality=90)
            time.sleep(2)
        rows.append({"slug": slug, "title": title + (f" (page {page_no})" if page_no else ""), "kind": kind, "language": lang, "licence": lic, "source": ii["descriptionurl"],
                     "artist": md.get("Artist", {}).get("value", ""), "date": md.get("DateTimeOriginal", {}).get("value", ""), "crop": crop})
        print(f"ok {slug} ({lic})")
    lines = ["# Bench-S pages", "",
             "Real page images used by `generate.py`, all public domain, fetched from Wikimedia Commons by `fetch_pages.py`",
             "(generic User-Agent, no personal data). Stored downscaled to at most 1600 px wide; some are cropped to the paper.", "",
             "| File | Kind | Language | Licence | Source |", "|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| `{r['slug']}.jpg` | {r['kind']} | {r['language']} | {r['licence']} | [{r['title']}]({r['source']}) |")
    (HERE / "PAGES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (HERE / "pages.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} pages")


if __name__ == "__main__":
    main()
