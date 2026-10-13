"""全国の駅の位置データ（eki-stamp/stations.json）を作る。

出典：国土数値情報（鉄道データ N02）国土交通省
  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html
ZIPを手元に落としてから:
  python -X utf8 tools/build_stations.py <N02-24_GML.zip>

元データは「ホーム1本＝1行（線）」。乗り換え駅は同じ駅グループコード（N02_005g）を持つので、
グループごとに1駅にまとめる。位置はホームごとの中点を全部持つ（新宿のような大きな駅でも
「どれかのホームから何m」で測れるように）。

出力の1行： [id, 駅名, 路線（・区切り）, [[経度, 緯度], ...]]
"""
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "stations.json"


def line_name(s):
    # 「2号線日比谷線」→「日比谷線」。番号だけの名前はそのまま残す
    t = re.sub(r"^\d+号線", "", s)
    return t or s


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    name = next(n for n in z.namelist() if n.startswith("UTF-8/") and n.endswith("_Station.geojson"))
    features = json.loads(z.read(name))["features"]

    groups = defaultdict(list)
    for f in features:
        groups[f["properties"]["N02_005g"]].append(f)

    rows = []
    for gid, fs in groups.items():
        # 駅名はグループの代表（コードが一致するもの）。無ければ一番多い名前
        rep = next((f for f in fs if f["properties"]["N02_005c"] == gid), None)
        nm = rep["properties"]["N02_005"] if rep else Counter(f["properties"]["N02_005"] for f in fs).most_common(1)[0][0]
        lines = []
        for f in fs:
            ln = line_name(f["properties"]["N02_003"])
            if ln not in lines:
                lines.append(ln)
        pts = []
        for f in fs:
            cs = f["geometry"]["coordinates"]
            lng = sum(c[0] for c in cs) / len(cs)
            lat = sum(c[1] for c in cs) / len(cs)
            p = [round(lng, 5), round(lat, 5)]
            if p not in pts:
                pts.append(p)
        rows.append(["g" + gid, nm, "・".join(lines), pts])

    rows.sort(key=lambda r: r[0])
    data = {
        "source": "国土数値情報（鉄道データ）（国土交通省）を加工して作成",
        "version": Path(name).name.split("_")[0],
        "stations": rows,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(features)}ホーム → {len(rows)}駅  {OUT.stat().st_size / 1024:.0f}KB  {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
