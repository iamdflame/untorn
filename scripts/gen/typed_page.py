"""Make a synthetic document page (typed or handwritten style) for simulated tears and reading tests.
The text is original filler prose; nothing personal. Usage:
  python typed_page.py <out.png> <style: typed|hand|serif> [seed] [width=820] [height=1071]
"""
import random, sys, textwrap

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

TEXT = {
    "typed": """Harbour Office, North Quay. March 14, 1911.
To the Secretary of the Lighthouse Committee.
Dear Sir, I beg to report that the lamp at the outer mole was relit on the evening of the twelfth after the repairs to the copper hood were finished. The keeper, who has served the station for nineteen years, states that the new wick burns more evenly and with less smoke than the old pattern. The glass of the western pane was cracked by the gale of the ninth and has been replaced from the store at the boat house. I enclose the account of the glazier together with the receipt for twelve gallons of oil delivered by the coastal steamer. The fog bell still sticks in damp weather and I would recommend that the bearings be cleaned and greased before the autumn storms. With respect I remain your obedient servant, the Harbour Master.""",
    "hand": """Tuesday evening
My dear Aunt, the parcel arrived safely this morning and the children were delighted with the books and the striped wool. We walked to the old mill after lunch, where the river was high and brown from all the rain, and counted eleven herons standing in the flooded meadow. Father says the bridge at the ford will need new planks before the market fair. The garden is full of snowdrops and the first crocuses have opened by the south wall. Please tell Uncle Robert that the clock he mended keeps perfect time and chimes a little too loudly at midnight. We all send our love and hope to see you at Easter. Your affectionate niece.""",
    "serif": """Chapter Three. The Survey of the Valley.
The surveyors set out at dawn with two mules, a chain of one hundred links and a brass theodolite borrowed from the college. By noon they had measured the long meadow and marked the boundary stones along the stream. The farmer at the upper crossing told them that the old map was wrong by half a furlong, which they found to be true when they reached the chapel. In the afternoon a thunderstorm drove them into a barn, where they copied the day's figures into the field book by the light of a lantern and argued about the height of the northern ridge.""",
}
FONTS = {"typed": ("C:/Windows/Fonts/cour.ttf", 17, 23), "hand": ("C:/Windows/Fonts/Inkfree.ttf", 22, 31), "serif": ("C:/Windows/Fonts/georgia.ttf", 17, 25)}
PAPER = {"typed": (233, 226, 205), "hand": (240, 240, 236), "serif": (226, 222, 214)}
INK = {"typed": (40, 40, 52), "hand": (28, 44, 110), "serif": (30, 28, 26)}


def main():
    out, style = sys.argv[1], sys.argv[2]
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    W = int(sys.argv[4]) if len(sys.argv) > 4 else 820
    H = int(sys.argv[5]) if len(sys.argv) > 5 else 1071
    rng = np.random.default_rng(seed)
    random.seed(seed)
    path, size, pitch = FONTS[style]
    font = ImageFont.truetype(path, size)
    im = Image.new("RGB", (W, H), PAPER[style])
    d = ImageDraw.Draw(im)
    if style == "hand":  # ruled paper
        for y in range(110, H - 40, pitch):
            d.line([(40, y + 6), (W - 40, y + 6)], fill=(170, 190, 215), width=1)
        d.line([(70, 40), (70, H - 40)], fill=(220, 160, 160), width=1)
    chars = int((W - 160) / (size * (0.6 if style == "typed" else 0.5)))
    y = 90
    for para in TEXT[style].split("\n"):
        for line in textwrap.wrap(para, chars):
            x = 80 + (rng.normal(0, 0.6) if style == "typed" else rng.normal(0, 2))
            d.text((x, y), line, font=font, fill=INK[style])
            y += pitch
        y += pitch // 2
    a = np.asarray(im).astype(float)
    a += rng.normal(0, 3, a.shape)  # paper grain
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.4))
    im.save(out)
    print(out, im.size)


if __name__ == "__main__":
    main()
