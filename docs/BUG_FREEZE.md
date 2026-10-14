# 不具合のまとめ：あしあと帳がスマホでだけ起動直後に固まる

（2026-10-14 原因判明・2.3.3 で修正。ほかのAIや人に見てもらうための資料）

## 0. 結論（2026-10-14 判明）

**路線タブを開いたまま閉じると、次の起動で「路線タブの描き直し」が待ち時間なしで永久に回っていた。**

- `renderLines()` は、通った区間（rides）がまだなら「計算しています…」を出し、`loadRides().then(render)` で描き直す
- `loadRides()` は駅データ（master）がまだ無いと**何もせずに戻っていた**。起動直後は master がまだ無い
- → すぐ描き直す → また rides が無い → また loadRides → … がマイクロタスク（Promise の続き）だけで回り続ける。
  マイクロタスクが空にならないので、駅データの fetch の完了・タイマー・描画・タップが**一度も順番を回されない**。
  画面は最後に描けた「読み込んでいます…」のまま、12秒の見張りも動かない
- v17 の目印（診断ページ）：起動から212秒たっても `描く:lines → 描いた:lines` が数十msおきに続いていた
- PCで、道のりの記録を1日分入れて `localStorage eki.tab = "lines"` にすると、2.3.2 で同じ止まり方が**再現**。2.3.3 では0.7秒で「起動おわり」
- スマホでだけ起きたのは、**最後に見ていたタブが路線だったから**（PCは最近タブ）。端末やChromeの違いではなかった。
  2.0 にも同じ穴があり、2.1/2.2 の公開と重なったのは、そのころ路線タブで閉じたため
- 修正（2.3.3・sw v18）：`loadRides()` は駅データが無ければ自分で読む。`renderLines()` は計算できたときだけ描き直し、読めなければ案内を出す
- 後始末（2.4.0）：調査用の道具（boot.js の目印・index.html の12秒の見張り・diag.html・repair.html）と、db.js の時間切れ・つなぎ直しは外した。下の章に出てくるこれらのファイルはもう無い（git の履歴にある）
- 教訓：
  - 「待って描き直す」は、**待った結果が揃ったときだけ**描き直す。揃わないまま描き直すと、待ちが一瞬で終わる場合に無限ループになる
  - 12秒の見張りは「読み込んでいます」の文字が残っているときだけ動くので、最初の画面に差し替わったあとの止まりは見逃す
  - 画面に出ている段階表示は「最後に描けた1コマ」で、止まった場所ではない。localStorage の目印のほうを信じる
  - 6章の候補（IndexedDB・メインスレッドの重い計算）はどれも外れだった。読み書きを毎回開閉する 2.3.0 の変更は害はないので残している

## 1. どんなアプリか

- **あしあと帳**：ビルドなしのPWA（HTML／CSS／素のJavaScript・ESモジュール）。GitHub Pages で公開
  - 公開URL：https://artem-invest.github.io/hitotsukuri/eki-stamp/
  - ソース：https://github.com/artem-invest/hitotsukuri/tree/main/eki-stamp
- **記録の保存**：IndexedDB（DB名 `eki-stamp`・版2・表は `stations` `visits` `days` `meta`）
- **オフライン対応**：サービスワーカー `sw.js`。起動時に本体一式（JS・約600KBの stations.json・約1MBの roads.json など）を Cache Storage にしまい、2回目からはそこから返す（stale-while-revalidate）。新しい版が入ると `controllerchange` で1回だけ自動で読み直す
- **地図**：Leaflet 1.9.4（同梱）
- **データの量（不具合が出ている端末）**：駅・施設 212件、訪問 185件、道のり（days）585日分（Googleマップのタイムラインから取り込み。合計で数MB）

## 2. 症状

- **端末**：Android 10、Chrome 155（ホーム画面にインストールしたPWA、Chromeのタブ、どちらでも起きる）
- アプリを開くと「読み込んでいます…」のまま、**画面が一切描き変わらない**
- **タブを押しても反応しない**
- index.html に「12秒たっても読み込み中なら、手がかりを出す」見張り（インラインの `setTimeout`）を入れてあるが、**それも出ない**
  → 画面のメインスレッドそのものが止まっている（待っているだけではない）と見ている
- **PCのChrome（Windows・Chrome 154）では、同じくらいの量の記録で一度も再現しない**
  - PCで、IndexedDBの書き込みロックを別タブで握り続けて人工的に止めると、「待たされている」状態にはなる。このときは12秒の見張りが正常に出る。つまり、PCの「待ち」とスマホの「固まり」は別物

## 3. いつから

- **2.0.0（sw.js の VERSION eki-stamp-v9）までは、このスマホで普通に使えていた**
- 2.1.0 と 2.2.0 をまとめて公開した直後に、初めて開いたときから固まるようになった
  - 2.1.0：タイムラインから見つけた施設を「確認待ち」（visit に `pending: true`）にする。起動時に `recheckSpotsOnce()` で既存の記録を1回だけ確認待ちに戻す（`putMany` で書き込み）
  - 2.2.0：駅も自信の低いものを確認待ちにする（`recheckStationsOnce()`：全日分の電車の乗り降り地点に対して最寄り駅を2つずつ探す）。日付タップでその日のルート、訪問ごとの一言
  - 差分：https://github.com/artem-invest/hitotsukuri/compare/1158a5c...b6b7d6f

## 4. 調べて分かったこと

### 診断ページ（アプリの外・サービスワーカーの管轄外）では全部正常

https://artem-invest.github.io/hitotsukuri/diag.html （ソース：`diag.html`）をスマホで実行した結果：

| 段階 | 結果 |
|---|---|
| 部品（ui.js〜linestyle.js）の import | すべて成功（20〜250ms） |
| IndexedDB を開いて件数を数える | 成功（版2・駅と施設212・記録185・道のり585日） |
| 道のり585日を全部読む | 成功（66〜92ms） |
| 駅データ・SA銭湯データの読み込み | 成功（70〜425ms） |
| 乗り降りした駅の計算（railStops） | 成功（約200〜330ms） |
| 通った区間の計算（railRides） | 成功（約310〜350ms） |
| 高速／一般道（splitCar）・施設の立ち寄り（spotStops） | 成功 |
| **アプリ本体を iframe で開く** | **固まる**（iframe の中が「読み込んでいます…」のまま。診断ページ自体のタイマーも進まなくなる） |

→ 部品・データ・計算はどれも正常。**組み立てたアプリ本体を動かしたときだけ固まる**。

### 起動の目印（boot.js）で分かった止まり方

`boot(step)` で、各段階を localStorage（`eki.bootlog`）と画面の「読み込んでいます…（段階）」に残している。

- 画面の段階表示は版ごとに違った：「記録を読む」→「記録を読んだ」→「visits を読んだ」
- **しかし localStorage の記録（v15）では「最初の画面が出た 55ms」まで進んでいた**
  （`部品がそろった → app.js開始 → … → 記録を読んだ 40ms → 画面を作る 47ms → 最初の画面が出た 55ms`）
- つまり、最初の `render()` は55msで最後まで終わっている。**それが画面に一度も描かれないまま、直後の処理でメインスレッドが止まっている**と見ている
  （画面の段階表示が止まった場所と食い違うのは、固まると描画されないため）
- v15 には、「最初の画面が出た」より後の目印が無かった。そのため、**どの処理で止まるかはまだ特定できていない**（v17 で細かい目印を足した。結果待ち）

### 最初の画面のあとに動く処理（app.js の起動部、2.3.2 時点）

```
await seedIfFirst(); await load();            // ← ここまでは55msで終わる（render() も1回済む）
await requestAnimationFrame→setTimeout(50)    // 2.3.2 で追加：先に描かせる
meta.persisted = await askPersist();          // navigator.storage.persisted()/persist()
master = await geo.loadMaster();              // stations.json（約600KB）を fetch → JSON.parse → 9,048駅
await linkMaster(); render();                 // 位置の無い駅を全国データと名前で結ぶ（putMany）
await loadRides(); render();                  // 全日分の days を読み、railRides（数百ms）
await recheckSpotsOnce(); render();           // meta.spotConfirm が無ければ visits を確認待ちに戻す（putMany）
await backfillSpots();                        // meta.spotScan < 2 なら全日分から施設を探す
await recheckStationsOnce(); render();        // meta.stationConfirm が無ければ railStops→firstStops→確認待ち
if (await geo.permitted()) findNear();        // 位置情報が許可済みなら現在地を取る（navigator.geolocation）
```

`render()` は、保存してあるタブ（localStorage `eki.tab`。このスマホでは `lines` だったこともある）の画面を DOM で組み立て直す。「最近」タブは、全日分の距離集計・`nextStations()`（自分の路線のまだの駅を距離順に並べる）・確認待ちの一覧（今は0件）を描く。

## 5. 試したこと（どれも直らなかった）

| 試したこと | 結果 |
|---|---|
| アプリを完全に閉じる・スマホを再起動 | 変わらず |
| 修理ページ（サービスワーカーの登録解除＋Cache Storage 全削除） | 変わらず |
| Chromeの「キャッシュとサイトデータを削除」→ 記録を取り込み直し | 一度は開けた。確認を連続で押している途中で、新しい版への自動読み直し（`controllerchange`）が起き、その後また固まった |
| IndexedDB の読み出しに時間切れ＋つなぎ直しを付けた（2.2.3） | 変わらず（時間切れのタイマー自体が動かない） |
| IndexedDB を「読み書きのたびに開いて閉じる」方式に変更（2.3.0） | 変わらず。ただし、そのあと上の「最初の画面は55msで出来ている」ことが分かった |
| 最初の画面のあと、先に描かせてから次へ進む（2.3.2・未確認） | 結果待ち |

## 6. いま考えている候補

1. **最初の画面のあとの同期処理が、スマホでだけ終わらない（または極端に重い）**：`loadRides`／`render()` の中の集計／`recheckStationsOnce` など。ただし、同じ計算は診断ページでは数百msで終わる
2. **2.1 で入れた書き込み（`putMany`）が途中で切れて、IndexedDB かブラウザの保存の仕組みが変な状態になった**：スマホでだけ、そのあとのアクセスでメインスレッドが止まる（Chrome Android 側の不具合の可能性）
3. **localStorage／sessionStorage の同期アクセス**（boot.js が毎段階書く）。ただし、boot.js を入れる前（2.2.1 以前）から固まっていた
4. **位置情報**：位置情報が許可済みだと、起動時に `navigator.geolocation.getCurrentPosition` を呼ぶ。2.0 でも同じ処理はあった

## 7. 次に確かめること

- スマホで v17 を開き、固まったあと診断ページの「前回アプリが進んだところ」（`eki.bootlog`）を見る。どの段階の直後で止まるかで、候補を1つに絞る
- 絞れなければ、URLの指定で起動後の処理を1つずつ止められる「安全起動」（例：`?safe=1` で、loadRides・見直し・現在地を全部とばす）を作り、どれを外すと開くかを試す
- 可能なら、パソコンとスマホをUSBでつないで `chrome://inspect` からスマホのページを直接調べる（Performance の記録・スタックの確認）

## 8. 参考にした公開情報

- IndexedDB の get が返らずタブが固まる報告（回避策は時間切れ・ブラウザの再起動）：https://github.com/pixiebrix/pixiebrix-extension/issues/7846
- Chromium：一時停止したページを IndexedDB の上で無効として扱う修正：https://chromium.googlesource.com/chromium/src/+/d32aa3d9d76b42234c49496757bb2e089a45bbe5
- WebKit：IndexedDB の要求が返らない報告：https://www2.webkit.org/show_bug.cgi?id=251203
