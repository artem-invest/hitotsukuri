"""日本付近の陸地を0.1度（約10km）のマス目にした表（eki-stamp/land.json）を作る。船の見分けに使う

  python -X utf8 tools/build_land.py <ne_10m_land.geojson> <ne_10m_minor_islands.geojson>

材料：Natural Earth（パブリックドメイン）の 10m 陸地と小さな島
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_minor_islands.geojson
2.7.0 は「駅・施設・高速の無い所＝海」と推し量っていたため、鉄道の無い宮古島の中を車で走った移動が船になった（2026-10-14）。
陸地そのものの形で判定し直すために作った。

マス目の中心が陸の中なら陸。海岸線の点を含むマスも陸（小さな島を落とさないため）。
出力: {"lat0", "lng0", "step", "rows", "cols", "bits": base64（行ごと、1マス1ビット）}
"""
import base64
import json
import math
import sys
from pathlib import Path

LAT0, LAT1, LNG0, LNG1, STEP = 20.0, 46.0, 122.0, 154.0, 0.1
ROWS, COLS = round((LAT1 - LAT0) / STEP), round((LNG1 - LNG0) / STEP)
OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "land.json"


def rings(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"] if geom["type"] == "MultiPolygon" else []
    for poly in polys:
        if poly:
            yield poly[0]  # 外側の輪だけ（湖の穴は陸のままでよい）


def main(*paths):
    land = bytearray(ROWS * COLS)
    n_rings = 0
    for p in paths:
        for f in json.loads(Path(p).read_text(encoding="utf-8"))["features"]:
            for ring in rings(f["geometry"]):
                lngs = [c[0] for c in ring]
                lats = [c[1] for c in ring]
                if max(lats) < LAT0 or min(lats) > LAT1 or max(lngs) < LNG0 or min(lngs) > LNG1:
                    continue
                n_rings += 1
                # 海岸線の点のあるマス
                for lng, lat in zip(lngs, lats):
                    r, c = math.floor((lat - LAT0) / STEP), math.floor((lng - LNG0) / STEP)
                    if 0 <= r < ROWS and 0 <= c < COLS:
                        land[r * COLS + c] = 1
                # 行ごとに、マス目の中心の緯度で輪を横切る点を求め、その間を陸で塗る
                r0 = max(0, math.floor((min(lats) - LAT0) / STEP))
                r1 = min(ROWS - 1, math.floor((max(lats) - LAT0) / STEP))
                edges = list(zip(ring, ring[1:]))
                for r in range(r0, r1 + 1):
                    y = LAT0 + (r + 0.5) * STEP
                    xs = sorted(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
                                for a, b in edges if (a[1] <= y < b[1]) or (b[1] <= y < a[1]))
                    for x0, x1 in zip(xs[::2], xs[1::2]):
                        c0 = max(0, math.ceil((x0 - LNG0) / STEP - 0.5))
                        c1 = min(COLS - 1, math.floor((x1 - LNG0) / STEP - 0.5))
                        for c in range(c0, c1 + 1):
                            land[r * COLS + c] = 1
    bits = bytearray((ROWS * COLS + 7) // 8)
    for i, v in enumerate(land):
        if v:
            bits[i >> 3] |= 1 << (i & 7)
    OUT.write_text(json.dumps({"lat0": LAT0, "lng0": LNG0, "step": STEP, "rows": ROWS, "cols": COLS,
                               "bits": base64.b64encode(bytes(bits)).decode("ascii"),
                               "source": "Natural Earth（パブリックドメイン）"}, ensure_ascii=False), encoding="utf-8")
    print(f"輪 {n_rings}・陸のマス {sum(land)}/{ROWS * COLS}・{OUT.stat().st_size // 1024}KB")

    def at(lat, lng):
        r, c = math.floor((lat - LAT0) / STEP), math.floor((lng - LNG0) / STEP)
        return "陸" if land[r * COLS + c] else "海"
    for name, lat, lng in [("宮古島", 24.79, 125.28), ("石垣島", 24.40, 124.18), ("伊豆大島", 34.75, 139.39), ("佐渡", 38.05, 138.40),
                           ("日高山脈", 42.70, 142.80), ("東京", 35.68, 139.77), ("福岡の沖", 34.17, 130.12), ("東京湾の中", 35.50, 139.85),
                           ("小呂島", 33.86, 130.03), ("相模湾", 35.10, 139.30)]:
        print(f"  {name}: {at(lat, lng)}")


if __name__ == "__main__":
    main(*sys.argv[1:])
