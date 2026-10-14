"""道の駅がある市区町村コードを国土地理院の住所検索で調べ、tools/michi_muni.json に貯める（取得済みは飛ばす）

  python -X utf8 tools/fetch_michi_pref.py

送るのは道の駅（公開の施設）の座標だけ。1件ずつ0.15秒あけて問い合わせる。
都道府県は市区町村コードの上2桁（例：14215 → 14 神奈川県）。build_hwroutes.py が読む。
"""
import json
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROADS = HERE.parent / "eki-stamp" / "roads.json"
OUT = HERE / "michi_muni.json"
URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat={lat}&lon={lng}"


def main():
    spots = [s for s in json.loads(ROADS.read_text(encoding="utf-8"))["spots"] if s[2] == "michi"]
    got = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    todo = [s for s in spots if s[0] not in got]
    print(f"道の駅 {len(spots)}・取得済み {len(spots) - len(todo)}・これから {len(todo)}")
    for n, (sid, name, _, lat, lng) in enumerate(todo, 1):
        try:
            with urllib.request.urlopen(URL.format(lat=lat, lng=lng), timeout=15) as r:
                res = json.loads(r.read().decode("utf-8")).get("results") or {}
            got[sid] = res.get("muniCd") or ""
        except Exception as e:
            print(f"  失敗 {name}: {e}")
        if n % 50 == 0:
            OUT.write_text(json.dumps(got, ensure_ascii=False, indent=0), encoding="utf-8")
            print(f"  {n}/{len(todo)}")
        time.sleep(0.15)
    OUT.write_text(json.dumps(got, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"おわり：{sum(1 for v in got.values() if v)}件に市区町村コード（空 {sum(1 for v in got.values() if not v)}）")


if __name__ == "__main__":
    main()
