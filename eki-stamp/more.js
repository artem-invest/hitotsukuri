// その他：年報・設定（バックアップ・記録の点検・この端末の状態）
import * as db from "./db.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";
import { h, ymd, ymdw, mdw } from "./ui.js";
import { S, APP_VERSION, render, remember, openMapDay, waitFor, isSpot, needAll } from "./state.js";
import { exportJson, importJson, setMode, fixOf } from "./data.js";
import { renderReview } from "./review.js";
import { timelinePicker } from "./home.js";
import { openDay } from "./mapview.js";

export function renderMore(main) {
  const sub = (m, label) => h("button", { type: "button", "aria-pressed": String(S.more === m), text: label,
    onclick: () => { S.more = m; remember("eki.more", m); render(); } });
  main.append(h("div", { class: "seg" }, sub("review", "年報"), sub("backup", "設定")));
  if (S.more === "backup") { renderSettings(main); return; }
  if (S.dayKeys.length && !S.allDays) {
    waitFor(main, "all", "記録を集計しています…", needAll, () => !!S.allDays);
    return;
  }
  const days = S.allDays || [];
  renderReview(main, { allDays: days, stations: S.stations, visits: S.visits, roads: S.roads, master: S.master,
    year: S.reviewYear, setYear: (y) => { S.reviewYear = y; render(); },
    mode: S.reviewMode, setMode: (m) => { S.reviewMode = m; render(); },
    openDay: openMapDay });
  if (days.length) main.append(distanceCard(days));
}

// 年報の下：見ている年の月ごと・手段ごとの距離の表と、ドライブの一覧
function distanceCard(allDays) {
  const years = [...new Set(allDays.map((d) => d.date.slice(0, 4)))].sort();
  const year = years.includes(S.reviewYear) ? S.reviewYear : years.at(-1);
  const months = new Map();
  const drives = [];
  for (const d of allDays.filter((x) => x.date.startsWith(year))) {
    const m = d.date.slice(0, 7);
    const cur = months.get(m) || {};
    const km = tl.kmByMode(d.acts);
    for (const [k, v] of Object.entries(km)) cur[k] = (cur[k] || 0) + v;
    if (S.roads && km.car) {
      const c = rd.splitCar(S.roads, d);
      cur.hw = (cur.hw || 0) + c.hw;
      cur.general = (cur.general || 0) + c.general;
      if (km.car >= 50) drives.push({ date: d.date, ...c, km: km.car });
    }
    months.set(m, cur);
  }
  const label = { hw: "高速", general: "一般道" };
  const cols = (S.roads ? ["train", "hw", "general", "walk"] : ["train", "car", "walk"])
    .concat(["bike", "bus", "boat"].filter((c) => [...months.values()].some((v) => v[c] > 0)));
  const fmt = (v) => (v ? Math.round(v).toLocaleString() : "–");
  return h("section", { class: "card dist-card" },
    h("h2", { text: `${year}年 月ごとの移動距離（km）` }),
    h("div", { class: "tablewrap" }, h("table", { class: "dist" },
      h("thead", {}, h("tr", {}, h("th", { text: "月" }), ...cols.map((c) => h("th", { text: label[c] || tl.MODES[c].label })), h("th", { text: "合計" }))),
      h("tbody", {}, [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([m, v]) => h("tr", {},
        h("td", { text: `${+m.slice(5)}月` }),
        ...cols.map((c) => h("td", { text: fmt(v[c]) })),
        h("td", { text: fmt(Object.entries(v).filter(([k]) => !["fly", "hw", "general"].includes(k)).reduce((a, [, x]) => a + x, 0)) })))))),
    h("p", { class: "muted", text: "合計に飛行機は入れていません。高速／一般道は、道のりの点と高速道路の位置・速さから推定しています。" }),
    drives.length ? h("h2", { text: "ドライブ（車で50km以上の日）" }) : "",
    drives.length ? h("ol", { class: "drives" }, drives.sort((a, b) => b.date.localeCompare(a.date)).map((dv) => {
      const sp = S.visits.filter((v) => v.at.slice(0, 10) === dv.date).map((v) => S.stations.find((s) => s.id === v.stationId)).filter(isSpot);
      return h("li", {}, h("button", { type: "button", onclick: () => openMapDay(dv.date) },
        h("b", { text: ymdw(dv.date) }),
        h("span", { text: `${Math.round(dv.km)}km（高速 ${Math.round(dv.hw)}・一般道 ${Math.round(dv.general)}）` }),
        h("small", { text: [dv.names.slice(0, 3).join("・"), sp.map((s) => s.name).join("・")].filter(Boolean).join("／") })));
    })) : "");
}

/* ---------- 記録の点検 ---------- */
const agoDays = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null);

// Googleの判定が怪しい移動（本人が「このままでよい」か手段を直したものは出さない）
function oddMoves(days) {
  const out = [];
  for (const d of days) for (const a of d.acts) {
    if (fixOf(d.date, a)) continue;
    const hours = (a.e - a.s) / 3600;
    const kmh = hours > 0 ? a.km / hours : 0;
    const why =
      a.mode === "car" && kmh > 150 ? `車なのに時速${Math.round(kmh)}km（新幹線・飛行機かも）`
      : a.mode === "walk" && a.km > 15 ? `徒歩なのに${a.km}km`
      : a.mode === "walk" && kmh > 7 && a.km > 2 ? `徒歩なのに時速${Math.round(kmh)}km`
      : a.mode === "bike" && kmh > 40 ? `自転車なのに時速${Math.round(kmh)}km`
      : a.mode === "train" && kmh > 330 ? `電車なのに時速${Math.round(kmh)}km（飛行機かも）`
      : a.mode === "boat" ? "船と判定（海の上の移動を自動で直したもの）"
      : a.mode === "other" && a.km >= 5 ? "手段が分からない移動"
      : null;
    if (why) out.push({ d, a, why });
  }
  return out.sort((x, y) => y.a.s - x.a.s);
}

// タイムラインの記録が3日以上続けて無い期間（スマホの電源が切れていた・タイムラインがオフだった等）
function gaps(keys) {
  const out = [];
  for (let i = 1; i < keys.length; i++) {
    const n = Math.round((Date.parse(keys[i]) - Date.parse(keys[i - 1])) / 86400000) - 1;
    if (n >= 3) out.push({ from: keys[i - 1], to: keys[i], n });
  }
  return out.reverse();
}

function checkBody(box) {
  const days = S.allDays || [];
  const tlAgo = agoDays(S.meta.lastTimeline), exAgo = agoDays(S.meta.lastExport);
  const odd = oddMoves(days);
  const gp = gaps(S.dayKeys);
  const ok = (good, text) => h("li", { class: good ? "ok" : "warn", text });
  box.replaceChildren(
    h("ul", { class: "checks" },
      ok(tlAgo != null && tlAgo <= 8, S.meta.lastTimeline ? `タイムラインを最後に読み込んだ日：${ymdw(S.meta.lastTimeline)}（${tlAgo}日前）` : "タイムラインをまだ読み込んでいません"),
      ok(exAgo != null && exAgo <= 30 && (!S.meta.lastTimeline || Date.parse(S.meta.lastExport) >= Date.parse(S.meta.lastTimeline)),
        S.meta.lastExport ? `最後にバックアップした日：${ymdw(S.meta.lastExport)}（${exAgo}日前）${S.meta.lastTimeline && Date.parse(S.meta.lastExport) < Date.parse(S.meta.lastTimeline) ? "・そのあと読み込んだ分はまだ保存されていません" : ""}` : "まだバックアップしていません"),
      ok(!S.pending.length, S.pending.length ? `行ったか確かめていない場所：${S.pending.length}件（最近タブ）` : "確かめていない場所はありません"),
      ok(!odd.length, odd.length ? `判定が怪しい移動：${odd.length}件（下で直せます）` : "判定が怪しい移動はありません"),
      ok(true, S.dayKeys.length ? `道のり：${S.dayKeys.length}日分（${ymd(S.dayKeys[0] + "T12:00")}〜${ymd(S.dayKeys.at(-1) + "T12:00")}）・記録の無い期間 ${gp.length}か所` : "道のり：まだありません")),
    odd.length ? h("h3", { class: "gridhead", text: "判定が怪しい移動" }) : "",
    odd.length ? h("ol", { class: "oddlist" }, odd.slice(0, 40).map(({ d, a, why }) => {
      const sel = h("select", { "aria-label": "移動手段", onchange: () => setMode(d.date, a, sel.value) },
        ["train", "car", "bus", "walk", "bike", "boat", "fly", "other"].map((m) => h("option", { value: m, text: tl.MODES[m].label, selected: m === a.mode })));
      return h("li", {},
        h("div", {}, h("button", { type: "button", class: "linkish", text: mdw(d.date), onclick: () => openDay(d.date, null) }), h("small", { text: `${a.km}km・${why}` })),
        h("div", { class: "fix" }, sel, h("button", { type: "button", class: "small", text: "このままでよい", onclick: () => setMode(d.date, a, a.mode) })));
    })) : "",
    odd.length > 40 ? h("p", { class: "muted", text: `ほか ${odd.length - 40}件（上から順に片づけると出てきます）` }) : "",
    gp.length ? h("h3", { class: "gridhead", text: "記録の無い期間" }) : "",
    gp.length ? h("p", { class: "muted", text: gp.slice(0, 8).map((g) => `${mdw(g.from)}〜${mdw(g.to)}の間 ${g.n}日`).join("・") + "。スマホの電源が切れていた・タイムラインがオフだった期間です。古いスマホの書き出しがあれば読み込むと埋まります。" }) : "");
}

function renderSettings(main) {
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: () => { if (file.files[0]) importJson(file.files[0]); file.value = ""; } });
  const persistText = { yes: "消えにくい設定になっています", no: "ブラウザが「消えにくい設定」を断りました。ホーム画面に追加すると改善します", unsupported: "この端末は「消えにくい設定」に対応していません", "?": "確認中…" }[S.meta.persisted];
  // 記録の点検：開いたときに全日分を読んで調べる
  const checkBox = h("div", {}, h("p", { class: "muted", text: "調べています…" }));
  const check = h("details", { class: "card check" }, h("summary", { text: "記録の点検" }), checkBox);
  check.addEventListener("toggle", async () => {
    if (!check.open) return;
    try { await needAll(); checkBody(checkBox); } catch { checkBox.replaceChildren(h("p", { class: "muted", text: "記録を読めませんでした。" })); }
  });
  main.append(
    h("section", { class: "card" },
      h("h2", { text: "バックアップ" }),
      h("p", { text: "あしあとと道のりは、このスマホの中にだけあります（Googleのタイムラインも今はスマホの中だけ）。書き出すときに保存先で「ドライブ」を選ぶと、スマホを失くしても戻せます。" }),
      h("div", { class: "btns" },
        h("button", { type: "button", class: "primary", onclick: exportJson, text: "書き出す（道のりも含む）" }),
        h("button", { type: "button", onclick: () => file.click(), text: "読み込む" }), file),
      h("p", { class: "muted", text: S.meta.lastExport ? `最後に書き出した日：${ymdw(S.meta.lastExport)}` : "まだ書き出したことがありません" }),
      h("p", { class: "muted", text: "読み込みは「足し算」です。今ある記録は消えません。同じ日の道のりは記録が詳しいほうが残ります。" })),
    check,
    h("section", { class: "card" },
      h("h2", { text: "タイムライン" }),
      h("p", { text: S.dayKeys.length ? `${S.dayKeys.length}日分の道のりがあります（${S.dayKeys[0]}〜${S.dayKeys.at(-1)}）。` : "まだ読み込んでいません。" }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む")),
      h("p", { class: "muted", text: "Googleのタイムラインはスマホの中だけにあり、アプリから自動で取ってくる方法はありません。日曜日に「最近」に案内が出ます。" })),
    h("section", { class: "card" },
      h("h2", { text: "この端末の状態" }),
      h("ul", { class: "facts" },
        h("li", { text: `保存：${persistText}` }),
        h("li", { text: `通信：${navigator.onLine ? "オンライン" : "オフライン（記録はできます）"}` }),
        h("li", { text: `起動のしかた：${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "ホーム画面のアプリ" : "ブラウザ"}` }),
        h("li", { text: `版：${APP_VERSION}` })),
      h("p", { class: "muted", text: "駅の位置：国土数値情報（鉄道データ N02-24）（国土交通省）を加工して作成。高速道路：国土数値情報（高速道路時系列データ N06-24）（国土交通省）を加工して作成。SA・PA・道の駅・銭湯・温泉と、高速ごとのSA・PAの並び・都道府県ごとの道の駅：© OpenStreetMap contributors（ODbL）を加工して作成。道の駅の都道府県：国土地理院 逆ジオコーダ。陸地：Natural Earth。地図：地理院タイル" })),
    h("section", { class: "card" },
      h("h2", { text: "ホーム画面に追加" }),
      h("p", { text: "Android：Chromeのメニュー →「ホーム画面に追加」→「インストール」。iPhone：Safariの共有ボタン →「ホーム画面に追加」。" })),
  );
}

