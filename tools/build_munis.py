"""市区町村コード → 名前の対応表（eki-stamp/munis.json）を作る。

国土地理院の住所検索（逆ジオコーダ）は市区町村をコード（例：13112）で返すので、名前に直すのに使う。
出典：国土地理院 https://maps.gsi.go.jp/js/muni.js
  python -X utf8 tools/build_munis.py <muni.js>
"""
import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "eki-stamp" / "munis.json"

out = {}
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r"""GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']*)'""", line)
    if not m:
        continue
    code, rest = m.groups()
    parts = rest.split(",")
    pref, name = parts[1], parts[3].replace("\u3000", "")
    out[str(int(code))] = pref + name
OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(len(out), "件", OUT.stat().st_size // 1024, "KB", out.get("13112"), out.get("1101"))
