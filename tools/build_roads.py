"""SA・PA・道の駅の位置と、高速道路の線（eki-stamp/roads.json）を作る。

出典:
  SA・PA・道の駅：© OpenStreetMap contributors（ODbL）。Overpass API で取得した JSON
    [out:json];area["ISO3166-1"="JP"][admin_level=2]->.jp;
    (nwr["highway"~"^(services|rest_area)$"](area.jp););out center tags;
  高速道路の線：国土数値情報（高速道路時系列データ N06）国土交通省
使い方:
  python -X utf8 tools/build_roads.py <osm_sapa.json> <N06-24_GML.zip>

出力:
  spots:    [[ID, 名前, 種類(sa|pa|michi), 緯度, 経度], ...]
  highways: [[路線名, [緯度, 経度, 緯度, 経度, ...]], ...]  （約15mの精度に間引いた線）
"""
import json
import math
import re
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "roads.json"


def kind_of(name):
    if "道の駅" in name:
        return "michi"
    if re.search(r"SIC|スマート", name):
        return None  # スマートIC（SA・PAに付いた出入口）は施設ではない
    if re.search(r"SA\b|SA[ （(]|サービスエリア", name + " "):
        return "sa"
    if re.search(r"PA\b|PA[ （(]|パーキングエリア", name + " "):
        return "pa"
    return None


def tidy(name, kind):
    n = name.replace("　", " ").strip()
    n = n.replace("サービスエリア", "SA").replace("パーキングエリア", "PA")
    n = re.sub(r"\s*[（(]\s*(上り|下り|上下|東行き|西行き|内回り|外回り)[^）)]*[）)]", r"（\1）", n)
    if kind == "michi":
        n = re.sub(r"^道の駅\s*", "道の駅 ", n)
    return n


def meters(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * k)


def simplify(pts, tol=15.0):
    """ダグラス・ポイカー法：線の形を保ったまま点を間引く（tol メートル以内のずれは許す）"""
    if len(pts) < 3:
        return pts
    # 緯度経度をメートルの平面座標に直してから測る
    k = math.cos(math.radians(pts[0][0]))
    xy = [(p[1] * 111320 * k, p[0] * 110540) for p in pts]

    def seg_dist(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        far, idx = 0.0, None
        for m in range(i + 1, j):
            d = seg_dist(xy[m], xy[i], xy[j])
            if d > far:
                far, idx = d, m
        if idx is not None and far > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def main(osm_path, n06_zip):
    osm = json.load(open(osm_path, encoding="utf-8"))["elements"]
    spots = []
    for e in osm:
        name = e.get("tags", {}).get("name", "")
        kind = kind_of(name)
        if not kind:
            continue
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lng = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None:
            continue
        nm = tidy(name, kind)
        # 同じ名前で300m以内に重複があれば1つにする（敷地と建物が別々に登録されている等）
        if any(s[1] == nm and meters((s[3], s[4]), (lat, lng)) < 300 for s in spots):
            continue
        spots.append([f"{kind}-{e['type'][0]}{e['id']}", nm, kind, round(lat, 5), round(lng, 5)])

    z = zipfile.ZipFile(n06_zip)
    name = next(n for n in z.namelist() if n.startswith("UTF-8/") and n.endswith("HighwaySection.geojson"))
    highways = []
    total = 0
    for f in json.loads(z.read(name))["features"]:
        pr = f["properties"]
        if pr["N06_003"] != 9999:  # 廃止された区間は除く
            continue
        pts = [(c[1], c[0]) for c in f["geometry"]["coordinates"]]
        total += len(pts)
        flat = []
        for la, lo in simplify(pts):
            flat += [round(la, 5), round(lo, 5)]
        highways.append([pr["N06_007"], flat])

    data = {
        "source": "SA・PA・道の駅：© OpenStreetMap contributors（ODbL）／高速道路：国土数値情報（高速道路時系列データ）（国土交通省）を加工して作成",
        "spots": sorted(spots, key=lambda s: s[0]),
        "highways": highways,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kinds = {k: sum(1 for s in spots if s[2] == k) for k in ("sa", "pa", "michi")}
    kept = sum(len(h[1]) // 2 for h in highways)
    print(f"SA・PA・道の駅 {kinds}  高速 {len(highways)}区間 {total}→{kept}点  {OUT.stat().st_size / 1024:.0f}KB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
