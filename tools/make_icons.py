"""駅スタンプ帳のアイコンを描く（外部画像は使わない）。

和紙色の地に、朱色の二重丸の判子で「駅」。
python -X utf8 tools/make_icons.py で eki-stamp/icons/ に書き出す。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "icons"
PAPER = (245, 240, 230)
INK = (200, 67, 43)
FONTS = ["C:/Windows/Fonts/YuGothB.ttc", "C:/Windows/Fonts/meiryob.ttc", "C:/Windows/Fonts/msgothic.ttc"]


def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    raise SystemExit("日本語フォントが見つからない")


def draw(size, scale):
    """scale = 判子の半径 / 画像の半分。maskable は端が切られるので小さめにする"""
    big = size * 4  # 大きく描いて縮小し、縁をなめらかにする
    img = Image.new("RGB", (big, big), PAPER)
    d = ImageDraw.Draw(img)
    c = big / 2
    r = c * scale
    w = r * 0.07
    d.ellipse([c - r, c - r, c + r, c + r], outline=INK, width=round(w))
    r2 = r * 0.84
    d.ellipse([c - r2, c - r2, c + r2, c + r2], outline=INK, width=round(w * 0.45))
    f = font(round(r * 1.05))
    d.text((c, c + r * 0.02), "駅", font=f, fill=INK, anchor="mm")
    img = img.rotate(-8, resample=Image.BICUBIC, fillcolor=PAPER)  # 判子らしく少し傾ける
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
draw(192, 0.80).save(OUT / "icon-192.png")
draw(512, 0.80).save(OUT / "icon-512.png")
draw(512, 0.62).save(OUT / "icon-maskable-512.png")
draw(180, 0.80).save(OUT / "apple-touch-icon.png")
print("書き出し:", *sorted(p.name for p in OUT.iterdir()))
