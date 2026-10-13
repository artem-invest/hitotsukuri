# ひと作り

寝る前の30〜60分で、AIと作った小さな道具たち。

**公開URL：https://artem-invest.github.io/hitotsukuri/**

| 作品 | URL | ひとこと |
|---|---|---|
| あしあと帳（旧 駅スタンプ帳） | https://artem-invest.github.io/hitotsukuri/eki-stamp/ | 駅の近く（300m）でGPSスタンプ。押した駅の路線が塗り絵になり、空きが「次に降りる駅」になる。Googleマップのタイムラインを読み込むと、道のりを地図で見られ、月ごとの移動距離（高速／一般道も）が出て、SA・PA・道の駅・銭湯・温泉にもスタンプ。年報（1年の振り返り）と家探し（よく行く場所から候補の駅を比べる）も。PWA（インストール・オフライン・JSONでバックアップ） |
| 高速道路IC当てクイズ | https://artem-invest.github.io/hitotsukuri/ic-quiz/ | 路線を選んで、IC・JCTの順番を当てる |
| 焚き火タイマー | https://artem-invest.github.io/hitotsukuri/takibi-timer/ | ぱちぱち燃える焚き火を10分間眺める |
| 旬の魚図鑑 | https://artem-invest.github.io/hitotsukuri/sashimi-calendar/ | 月ごとの旬の魚と、柵の選び方・刺身の食べ方 |

どれもビルド不要のHTML/CSS/JavaScriptだけで動く。`main` ブランチがそのまま GitHub Pages で公開される。

あしあと帳の駅の位置：国土数値情報（鉄道データ）（国土交通省）を加工して作成。地図・町名：地理院タイル、国土地理院の住所検索。地図ライブラリ：Leaflet（BSD-2-Clause）。高速道路：国土数値情報（高速道路時系列データ）（国土交通省）を加工して作成。SA・PA・道の駅・銭湯・温泉：© OpenStreetMap contributors（`eki-stamp/roads.json` は ODbL）
