"""高速道路ごとの SA・PA の並び（eki-stamp/hwroutes.json）を roads.json から作る

  python -X utf8 tools/build_hwroutes.py

- SA・PA を、いちばん近い高速道路の線（600m以内）に割り当てる
- 上り・下りなど別々に入っている同じ名前の SA・PA（3km以内）は1か所にまとめる
- 並び順は駅と同じ一筆書き（端から最近傍 → 2-optで交差をほどく）。支線のある道路は前後することがある
- 高速道路の名前は法令上の名前（例：第一東海自動車道）なので、ふだんの呼び名と記号（E1 など）を添える

道の駅は都道府県ごとにまとめる（どの県かは tools/fetch_michi_pref.py が国土地理院の住所検索で調べた michi_muni.json）

出力: {"routes": [[法令名（複数は・でつなぐ）, 呼び名, 記号, [[名前, [spot id, ...]], ...]], ...],
       "michi": [[都道府県, 地方, [[名前, spot id], ...]], ...]}
"""
import json
import math
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "eki-stamp"
NEAR_M = 600
MERGE_M = 3000
CELL = 0.01
TOKYO = (35.681, 139.767)

# 法令名 → [呼び名, 高速道路ナンバリングの記号]（主なものだけ。無いものは法令名のまま）
COMMON = {
    "第一東海自動車道": ["東名高速", "E1"],
    "第二東海自動車道": ["新東名高速", "E1A"],
    "中央自動車道西宮線": ["中央道", "E20"],       # 小牧より西は名神（SPLIT）
    "中央自動車道富士吉田線": ["中央道", "E20"],   # 高井戸〜大月はこちらの法令名。ふだんは中央道と呼ぶ
    "中央自動車道長野線": ["長野道", "E19"],
    "関越自動車道新潟線": ["関越道", "E17"],
    "関越自動車道上越線": ["上信越道", "E18"],
    "東北縦貫自動車道弘前線": ["東北道", "E4"],
    "東北縦貫自動車道八戸線": ["八戸道", "E4A"],
    "常磐自動車道": ["常磐道", "E6"],
    "東関東自動車道水戸線": ["東関東道", "E51"],
    "東関東自動車道館山線": ["館山道", "E14"],
    "京葉道路": ["京葉道路", "E14"],
    "首都圏中央連絡自動車道": ["圏央道", "C4"],
    "北関東自動車道": ["北関東道", "E50"],
    "北陸自動車道": ["北陸道", "E8"],
    "東海北陸自動車道": ["東海北陸道", "E41"],
    "東海環状自動車道": ["東海環状道", "C3"],
    "伊勢湾岸道路": ["伊勢湾岸道", "E1A"],
    "中部横断自動車道": ["中部横断道", "E52"],
    "近畿自動車道名古屋・大阪線": ["東名阪・名阪", "E25"],
    "近畿自動車道名古屋・神戸線": ["新名神", "E1A"],
    "近畿自動車道伊勢線": ["伊勢道", "E23"],
    "近畿自動車道紀勢線": ["阪和道・紀勢道", "E26"],
    "近畿自動車道敦賀線": ["舞鶴若狭道", "E27"],
    "中国縦貫自動車道": ["中国道", "E2A"],
    "山陽自動車道": ["山陽道", "E2"],
    "中国横断自動車道岡山・米子線": ["岡山道・米子道", "E73"],
    "中国横断自動車道尾道・松江線": ["尾道松江道", "E54"],
    "中国横断自動車道姫路鳥取線": ["播磨道・鳥取道", "E29"],
    "中国横断自動車道広島・浜田線": ["浜田道", "E74"],
    "山陰自動車道": ["山陰道", "E9"],
    "四国縦貫自動車道": ["徳島道・松山道", "E11"],
    "四国横断自動車道": ["高松道・高知道", "E11"],
    "九州縦貫自動車道鹿児島線": ["九州道", "E3"],
    "九州縦貫自動車道宮崎線": ["宮崎道", "E10"],
    "九州横断自動車道長崎大分線": ["長崎道・大分道", "E34"],
    "東九州自動車道": ["東九州道", "E10"],
    "北海道縦貫自動車道": ["道央道", "E5"],
    "北海道横断自動車道網走線": ["道東道", "E38"],
    "道東自動車道": ["道東道", "E38"],
    "東北横断自動車道いわき新潟線": ["磐越道", "E49"],
    "東北横断自動車道酒田線": ["山形道", "E48"],
    "東北横断自動車道釜石秋田線": ["秋田道・釜石道", "E46"],
    "日本海沿岸東北自動車道": ["日本海東北道", "E7"],
    "東北中央自動車道": ["東北中央道", "E13"],
    "沖縄自動車道": ["沖縄道", "E58"],
    "瀬戸中央自動車道": ["瀬戸中央道", "E30"],
    "神戸淡路鳴門自動車道": ["神戸淡路鳴門道", "E28"],
    "西瀬戸自動車道": ["しまなみ海道", "E76"],
}
# 都市高速は「首都高 4号新宿線」のように会社名を短くして、記号は会社名
URBAN = {"首都高速": "首都高", "阪神高速": "阪神高速", "名古屋高速": "名古屋高速", "福岡高速": "福岡高速",
         "広島高速": "広島高速", "北九州市道北九州高速": "北九州高速"}


def urban(name):
    for k, v in URBAN.items():
        if name.startswith(k):
            return [f"{v} {name[len(k):]}".strip(), v.replace("高速", "") or v]
    return [name, ""]


# 法令上は1本でも、ふだんは別の名前で呼ぶ区間：呼び名 → (分ける条件(緯度, 経度), 呼び名, 記号)
SPLIT = {"中央道": (lambda la, lo: lo < 136.93, "名神高速", "E1")}  # 小牧JCTより西が名神
DIR = re.compile(r"[（(](上り|下り|上り線|下り線|内回り|外回り|東行き|西行き|北行き|南行き|上下線|上下|集約)[）)]$")


def dist(la1, lo1, la2, lo2):
    k = math.cos(math.radians((la1 + la2) / 2))
    return math.hypot((lo2 - lo1) * 111320 * k, (la2 - la1) * 110540)


def seg_dist(p, a, b):
    k = math.cos(math.radians(p[0]))
    ax, ay = (a[1] - p[1]) * 111320 * k, (a[0] - p[0]) * 110540
    bx, by = (b[1] - p[1]) * 111320 * k, (b[0] - p[0]) * 110540
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = max(0, min(1, -(ax * dx + ay * dy) / L)) if L else 0
    return math.hypot(ax + t * dx, ay + t * dy)


def order(ids, pos):
    """一筆書きの順に並べる（tools/build_stations.py と同じ考え方）"""
    if len(ids) < 3:
        return ids
    cx = sum(pos[i][0] for i in ids) / len(ids)
    cy = sum(pos[i][1] for i in ids) / len(ids)
    d = lambda a, b: dist(a[0], a[1], b[0], b[1])
    start = max(ids, key=lambda i: d(pos[i], (cx, cy)))
    path, rest = [start], set(ids) - {start}
    while rest:
        nxt = min(rest, key=lambda i: d(pos[path[-1]], pos[i]))
        path.append(nxt)
        rest.remove(nxt)
    improved = True
    while improved:
        improved = False
        for i in range(len(path) - 2):
            for j in range(i + 2, len(path)):
                a, b, c = pos[path[i]], pos[path[i + 1]], pos[path[j]]
                e = pos[path[j + 1]] if j + 1 < len(path) else None
                before = d(a, b) + (d(c, e) if e else 0)
                after = d(a, c) + (d(b, e) if e else 0)
                if after < before - 1e-6:
                    path[i + 1:j + 1] = reversed(path[i + 1:j + 1])
                    improved = True
    # 東京に近い端から始める（本人は首都圏から出かける）
    if dist(*pos[path[0]], *TOKYO) > dist(*pos[path[-1]], *TOKYO):
        path.reverse()
    return path


PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
         "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県",
         "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県",
         "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"]
REGIONS = [(1, "北海道"), (7, "東北"), (14, "関東"), (23, "中部"), (30, "近畿"), (35, "中国"), (39, "四国"), (47, "九州・沖縄")]


def region(code):
    return next(name for last, name in REGIONS if code <= last)


def michi_by_pref(spots):
    """道の駅を都道府県ごとに。同じ名前で1km以内のもの（OSMで点と面の二重など）は1つにする"""
    muni_path = Path(__file__).resolve().parent / "michi_muni.json"
    muni = json.loads(muni_path.read_text(encoding="utf-8")) if muni_path.exists() else {}
    by, pos, missing = defaultdict(list), {}, 0
    for sid, name, kind, la, lo in spots:
        if kind != "michi":
            continue
        code = muni.get(sid)
        if not code:
            missing += 1
            continue
        pref = int(code) // 1000
        if any(name == n2 and dist(la, lo, *pos[i2]) <= 1000 for n2, i2 in by[pref]):
            continue
        by[pref].append((name, sid))
        pos[sid] = (la, lo)
    out = []
    for code in sorted(by):
        names = dict((sid, n) for n, sid in by[code])
        ids = order([sid for _, sid in by[code]], pos)
        out.append([PREFS[code - 1], region(code), [[names[i].removeprefix("道の駅").strip(), i] for i in ids]])
    print(f"道の駅 {sum(len(x[2]) for x in out)}か所・{len(out)}都道府県（県が分からない {missing}）")
    return out


def main():
    r = json.loads((ROOT / "roads.json").read_text(encoding="utf-8"))
    grid = defaultdict(list)
    for name, flat in r["highways"]:
        for i in range(2, len(flat), 2):
            a, b = (flat[i - 2], flat[i - 1]), (flat[i], flat[i + 1])
            for x in range(math.floor(min(a[0], b[0]) / CELL), math.floor(max(a[0], b[0]) / CELL) + 1):
                for y in range(math.floor(min(a[1], b[1]) / CELL), math.floor(max(a[1], b[1]) / CELL) + 1):
                    grid[(x, y)].append((a, b, name))

    def nearest_hw(la, lo):
        x, y = math.floor(la / CELL), math.floor(lo / CELL)
        best = None
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for a, b, name in grid.get((x + i, y + j), ()):
                    dd = seg_dist((la, lo), a, b)
                    if dd <= NEAR_M and (best is None or dd < best[0]):
                        best = (dd, name)
        return best

    # 同じ名前の SA・PA（上り・下りなど）を1か所にまとめる
    places = []  # {name, ids, la, lo}
    for sid, name, kind, la, lo in r["spots"]:
        if kind not in ("sa", "pa") or "大型" in name or "ウォークイン" in name:
            continue
        base = DIR.sub("", name).strip()
        hit = next((p for p in places if p["name"] == base and dist(p["la"], p["lo"], la, lo) <= MERGE_M), None)
        if hit:
            hit["ids"].append(sid)
        else:
            places.append({"name": base, "ids": [sid], "la": la, "lo": lo})

    by_route = defaultdict(list)
    lost = 0
    for i, p in enumerate(places):
        hw = nearest_hw(p["la"], p["lo"])
        if hw:
            by_route[hw[1]].append(i)
        else:
            lost += 1

    # 呼び名ごとにまとめる（法令上は別の道路でも、ふだん1本と呼ぶものは1本に）
    groups = {}
    for name, idx in by_route.items():
        common, sym = COMMON.get(name) or urban(name)
        for i in idx:
            c, sy = common, sym
            if common in SPLIT and SPLIT[common][0](places[i]["la"], places[i]["lo"]):
                c, sy = SPLIT[common][1], SPLIT[common][2]
            g = groups.setdefault(c, {"legal": [], "sym": sy, "idx": []})
            if name not in g["legal"]:
                g["legal"].append(name)
            g["idx"].append(i)
    routes = []
    pos = {i: (p["la"], p["lo"]) for i, p in enumerate(places)}
    for common, g in groups.items():
        routes.append(["・".join(g["legal"]), common, g["sym"], [[places[i]["name"], places[i]["ids"]] for i in order(g["idx"], pos)]])
    routes.sort(key=lambda x: -len(x[3]))
    out = ROOT / "hwroutes.json"
    michi = michi_by_pref(r["spots"])
    out.write_text(json.dumps({"routes": routes, "michi": michi}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"SA・PA {len(places)}か所（高速に結びつかない {lost}）→ 高速 {len(routes)}本・{out.stat().st_size // 1024}KB")
    for name, common, sym, ps in routes:
        if common in ("東名高速", "中央道", "名神高速", "関越道", "東北道", "圏央道"):
            print(common, sym, "：", "・".join(p[0] for p in ps))


if __name__ == "__main__":
    main()
