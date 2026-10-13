"""全国の駅と路線のデータ（eki-stamp/stations.json）を作る。

出典：国土数値情報（鉄道データ N02）国土交通省
  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html
ZIPを手元に落としてから:
  python -X utf8 tools/build_stations.py <N02-24_GML.zip>

元データは「ホーム1本＝1行（線）」。乗り換え駅は同じ駅グループコード（N02_005g）を持つので、
グループごとに1駅にまとめる。位置はホームごとの中点を全部持つ（新宿のような大きな駅でも
「どれかのホームから何m」で測れるように）。

路線は「事業者＋路線名」で1本。元データに駅の並び順は無いので、位置から一筆書きの順を推定する
（端の駅から近い順にたどり、交差をほどく）。支線のある路線は多少前後する。

⚠ JRは「書類上の路線」（山手線＝品川〜田端 など）。ふだんの呼び方とずれる有名な路線だけ
  OVERRIDES で作り直す。

出力:
  lines:    [[表示名, [駅ID, ...（並び順）]], ...]
  stations: [[駅ID, 駅名, [路線番号, ...], [[経度, 緯度], ...]], ...]
"""
import json
import math
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "stations.json"

# ふだんの呼び方に作り直す路線（駅名の順。東京近郊の駅名で引く）
YAMANOTE = ("東京 有楽町 新橋 浜松町 田町 高輪ゲートウェイ 品川 大崎 五反田 目黒 恵比寿 渋谷 原宿 代々木 新宿 "
            "新大久保 高田馬場 目白 池袋 大塚 巣鴨 駒込 田端 西日暮里 日暮里 鶯谷 上野 御徒町 秋葉原 神田").split()
OVERRIDES = {("東日本旅客鉄道", "山手線"): ("山手線", YAMANOTE)}
MERGE = {("東京地下鉄", "4号線丸ノ内線分岐線"): ("東京地下鉄", "4号線丸ノ内線")}
RENAME = {("首都圏新都市鉄道", "常磐新線"): "つくばエクスプレス"}
TOKYO_BOX = (139.3, 35.4, 140.1, 36.0)  # 経度・緯度の範囲（駅名で引くときの同名駅よけ）


def op_short(op):
    if op.endswith("旅客鉄道"):
        return "JR"
    return {"東京地下鉄": "メトロ", "東京都": "都営", "大阪市高速電気軌道": "大阪メトロ"}.get(op) or \
        re.sub(r"(株式会社|電気鉄道|電鉄|鉄道|高速度交通営団)$", "", op)


def line_name(s):
    t = re.sub(r"^\d+号線", "", s)  # 「2号線日比谷線」→「日比谷線」
    return t or s


def dist(a, b):
    dx = (a[0] - b[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot(dx, a[1] - b[1])


def order(ids, pos):
    """駅を一筆書きの順に並べる（端から最近傍でたどる → 2-optで交差をほどく）"""
    if len(ids) < 3:
        return ids
    cx = sum(pos[i][0] for i in ids) / len(ids)
    cy = sum(pos[i][1] for i in ids) / len(ids)
    start = max(ids, key=lambda i: dist(pos[i], (cx, cy)))
    path, rest = [start], set(ids) - {start}
    while rest:
        nxt = min(rest, key=lambda i: dist(pos[path[-1]], pos[i]))
        path.append(nxt)
        rest.remove(nxt)
    improved = True
    while improved:
        improved = False
        for i in range(len(path) - 2):
            for j in range(i + 2, len(path)):
                a, b = pos[path[i]], pos[path[i + 1]]
                c = pos[path[j]]
                d = pos[path[j + 1]] if j + 1 < len(path) else None
                before = dist(a, b) + (dist(c, d) if d else 0)
                after = dist(a, c) + (dist(b, d) if d else 0)
                if after < before - 1e-9:
                    path[i + 1:j + 1] = reversed(path[i + 1:j + 1])
                    improved = True
    return path


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    name = next(n for n in z.namelist() if n.startswith("UTF-8/") and n.endswith("_Station.geojson"))
    features = json.loads(z.read(name))["features"]

    groups = defaultdict(list)
    for f in features:
        groups[f["properties"]["N02_005g"]].append(f)

    stations = {}   # gid -> {name, pts, lines:set}
    for gid, fs in groups.items():
        rep = next((f for f in fs if f["properties"]["N02_005c"] == gid), None)
        nm = rep["properties"]["N02_005"] if rep else Counter(f["properties"]["N02_005"] for f in fs).most_common(1)[0][0]
        pts = []
        for f in fs:
            cs = f["geometry"]["coordinates"]
            p = [round(sum(c[0] for c in cs) / len(cs), 5), round(sum(c[1] for c in cs) / len(cs), 5)]
            if p not in pts:
                pts.append(p)
        stations["g" + gid] = {"name": nm, "pts": pts}
    pos = {sid: (sum(p[0] for p in s["pts"]) / len(s["pts"]), sum(p[1] for p in s["pts"]) / len(s["pts"]))
           for sid, s in stations.items()}

    # 路線ごとの駅
    members = defaultdict(list)
    for f in features:
        pr = f["properties"]
        key = MERGE.get((pr["N02_004"], pr["N02_003"]), (pr["N02_004"], pr["N02_003"]))
        sid = "g" + pr["N02_005g"]
        if sid not in members[key]:
            members[key].append(sid)

    # 駅名→駅ID（東京近郊・その事業者のホームがある駅だけ。同名の別駅をよける）
    by_name = defaultdict(list)
    for gid, fs in groups.items():
        sid = "g" + gid
        x, y = pos[sid]
        if TOKYO_BOX[0] <= x <= TOKYO_BOX[2] and TOKYO_BOX[1] <= y <= TOKYO_BOX[3]:
            for op in {f["properties"]["N02_004"] for f in fs}:
                by_name[(op, stations[sid]["name"])].append(sid)

    raw_lines = []  # (表示名の素, 事業者, [駅ID順])
    for key, ids in members.items():
        op, ln = key
        if key in OVERRIDES:
            disp, names = OVERRIDES[key]
            seq = []
            for n in names:
                hit = by_name.get((op, n), [])
                if not hit:
                    raise SystemExit(f"{disp}: 駅名 {n} が見つからない")
                # 同名が複数（東京の京葉線ホームは別の駅扱い）なら、ホームの多いほう
                seq.append(max(hit, key=lambda sid: len(groups[sid[1:]])))
            raw_lines.append((disp, op, seq))
        else:
            raw_lines.append((RENAME.get(key, line_name(ln)), op, order(ids, pos)))

    # 名前がかぶる路線（「本線」など）だけ事業者名を前に付ける
    dup = Counter(n for n, _, _ in raw_lines)
    disp_of = [(f"{op_short(op)} {n}" if dup[n] > 1 else n, n, op, seq) for n, op, seq in sorted(raw_lines, key=lambda r: (r[1], r[0]))]
    dup2 = Counter(d for d, _, _, _ in disp_of)
    lines = []
    for d, n, op, seq in disp_of:
        if dup2[d] > 1:  # 「JR 中央線」が東日本と東海で重なる → 「JR東海 中央線」
            d = f"{op.replace('旅客鉄道', '').replace('東海', 'JR東海').replace('東日本', 'JR東日本')} {n}"
        lines.append([d, seq])

    line_of = defaultdict(list)
    for li, (_, seq) in enumerate(lines):
        for sid in seq:
            line_of[sid].append(li)

    rows = [[sid, s["name"], line_of[sid], s["pts"]] for sid, s in sorted(stations.items())]
    data = {
        "source": "国土数値情報（鉄道データ）（国土交通省）を加工して作成",
        "version": Path(name).name.split("_")[0],
        "lines": lines,
        "stations": rows,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(features)}ホーム → {len(rows)}駅・{len(lines)}路線  {OUT.stat().st_size / 1024:.0f}KB")


if __name__ == "__main__":
    main(sys.argv[1])
