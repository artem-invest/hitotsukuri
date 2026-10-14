// 年報：1年（と各月）の移動をまとめて振り返る
// 材料はタイムラインの日ごとの記録（days）とスタンプ（visits）。計算は開いたときにその場で行う。
import { h, ymdw, km } from "./ui.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";

const ORDER = ["train", "hw", "general", "car", "walk", "bike", "bus", "boat", "other"];
const LABEL = { hw: "高速", general: "一般道" };
const COLOR = { hw: "#1d3f8f", general: "#79a6e8" };
const label = (m) => LABEL[m] || tl.MODES[m]?.label || m;
const color = (m) => COLOR[m] || tl.MODES[m]?.color || "#999";

// 1日の手段ごとの距離（車は高速／一般道に分ける。飛行機は入れない）
function dayKm(d, roads) {
  const k = tl.kmByMode(d.acts);
  delete k.fly;
  if (roads && k.car) {
    const c = rd.splitCar(roads, d);
    delete k.car;
    k.hw = c.hw;
    k.general = c.general;
  }
  return k;
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// app: { allDays, stations, visits, roads, master, year, setYear(y), mode, setMode(m), openDay(date) }
export function renderReview(main, app) {
  const { allDays, stations, visits, roads, master } = app;
  if (!allDays.length) {
    main.append(h("p", { class: "empty", text: "地図タブでタイムラインを読み込むと、1年の移動をここで振り返れます。" }));
    return;
  }
  const years = [...new Set(allDays.map((d) => d.date.slice(0, 4)))].sort();
  const year = years.includes(app.year) ? app.year : years.at(-1);
  main.append(h("div", { class: "yearnav" }, years.map((y) =>
    h("button", { type: "button", "aria-pressed": String(y === year), onclick: () => app.setYear(y), text: `${y}年` }))));

  const days = allDays.filter((d) => d.date.startsWith(year));
  const perDay = days.map((d) => ({ date: d.date, k: dayKm(d, roads) }));
  const total = {};
  for (const { k } of perDay) for (const [m, v] of Object.entries(k)) total[m] = (total[m] || 0) + v;

  // その年に初めて押したスタンプ（駅・SA等・銭湯）
  const firstAt = new Map();
  for (const v of visits) if (!firstAt.has(v.stationId) || v.at < firstAt.get(v.stationId)) firstAt.set(v.stationId, v.at);
  const newOnes = stations.filter((s) => firstAt.get(s.id)?.slice(0, 4) === year)
    .sort((a, b) => firstAt.get(a.id).localeCompare(firstAt.get(b.id)));
  const groupOf = (s) => (rd.KINDS[s.kind] ? rd.KINDS[s.kind].group : "eki");
  const newBy = { eki: [], road: [], bath: [] };
  for (const s of newOnes) newBy[groupOf(s)].push(s);

  // 記録した日数と、その年の距離
  const months = new Set(days.map((d) => d.date.slice(0, 7)));
  main.append(h("section", { class: "card review" },
    h("p", { class: "big" }, h("b", { text: km(sum(total)) }), " km"),
    h("p", { class: "muted", text: `${year}年に移動した距離（飛行機を除く）。記録のある日 ${days.length}日・${months.size}か月` }),
    h("div", { class: "modes" }, ORDER.filter((m) => total[m] > 0).map((m) =>
      h("span", { class: "chip", style: `--c:${color(m)}`, text: `${label(m)} ${km(total[m])}km` }))),
    h("div", { class: "stats" },
      stat("初めて降りた駅", newBy.eki.length, "駅"),
      stat("初めてのSA・PA・道の駅", newBy.road.length, "か所"),
      stat("初めての銭湯・温泉", newBy.bath.length, "か所"))));

  // この年のいちばん
  const best = (f) => perDay.reduce((a, b) => (f(b) > f(a) ? b : a), perDay[0]);
  const drive = best((x) => (x.k.hw || 0) + (x.k.general || 0) + (x.k.car || 0));
  // 「徒歩」と判定された移動には乗り物が混じることがある（実データで、6時間半に39.5kmの「徒歩」があった）。
  // 本人の徒歩は中央値で時速2.8km・9割が時速4.4km以下なので、時速6km以下かつ1回15km以下だけを数える
  const walkOnly = new Map(days.map((d) => [d.date, d.acts
    .filter((a) => a.mode === "walk" && a.e > a.s && a.km <= 15 && a.km / ((a.e - a.s) / 3600) <= 6)
    .reduce((s, a) => s + a.km, 0)]));
  const walk = best((x) => walkOnly.get(x.date) || 0);
  const move = best((x) => sum(x.k));
  const driveKm = (drive.k.hw || 0) + (drive.k.general || 0) + (drive.k.car || 0);
  const tops = [
    driveKm > 0 && ["いちばん長いドライブ", drive.date, `${km(driveKm)}km（高速 ${km(drive.k.hw || 0)}）`],
    walkOnly.get(walk.date) > 0 && ["いちばん歩いた日", walk.date, `${km(walkOnly.get(walk.date))}km`],
    ["いちばん移動した日", move.date, `${km(sum(move.k))}km`],
  ].filter(Boolean);
  // よく乗り降りした駅
  const stops = new Map();
  if (master) for (const { m } of tl.railStops(days, master, 300)) stops.set(m.name, (stops.get(m.name) || 0) + 1);
  const topSt = [...stops].sort((a, b) => b[1] - a[1]).slice(0, 5);
  main.append(h("section", { class: "card" },
    h("h2", { text: "この年のいちばん" }),
    h("ul", { class: "tops" }, tops.map(([t, date, v]) => h("li", {},
      h("span", { text: t }),
      h("button", { type: "button", class: "linkish", onclick: () => app.openDay(date), text: ymdw(date) }),
      h("b", { text: v })))),
    topSt.length ? h("p", { class: "muted", text: `よく乗り降りした駅：${topSt.map(([n, c]) => `${n}（${c}回）`).join("・")}` }) : null));

  // 月ごと
  const byMonth = new Map();
  for (const { date, k } of perDay) {
    const m = date.slice(0, 7);
    const cur = byMonth.get(m) || {};
    for (const [mode, v] of Object.entries(k)) cur[mode] = (cur[mode] || 0) + v;
    byMonth.set(m, cur);
  }
  // 手段で絞る（車＝高速＋一般道）。「すべて」は色分けの積み上げ
  const pick = { all: null, train: ["train"], car: ["hw", "general", "car"], walk: ["walk"], bike: ["bike"], bus: ["bus"], boat: ["boat"] };
  const names = { all: "すべて", train: "電車", car: "車", walk: "徒歩", bike: "自転車", bus: "バス", boat: "船" };
  const has = (keys) => [...byMonth.values()].some((k) => keys.some((x) => k[x] > 0));
  const modes = Object.keys(pick).filter((m) => m === "all" || has(pick[m]));
  const mode = modes.includes(app.mode) ? app.mode : "all";
  const val = (k) => (mode === "all" ? sum(k) : pick[mode].reduce((a, x) => a + (k[x] || 0), 0));
  const maxKm = Math.max(...[...byMonth.values()].map(val), 1);
  const newByMonth = (m) => newOnes.filter((s) => firstAt.get(s.id).slice(0, 7) === m);
  main.append(h("section", { class: "card" },
    h("h2", { text: "月ごと" }),
    h("div", { class: "seg small" }, modes.map((m) => h("button", { type: "button", "aria-pressed": String(m === mode), text: names[m], onclick: () => app.setMode(m) }))),
    h("ol", { class: "months" }, [...byMonth.entries()].sort().map(([m, k]) => {
      const nw = newByMonth(m);
      const bars = mode === "all"
        ? ORDER.filter((x) => k[x] > 0).map((x) => h("i", { style: `width:${(k[x] / maxKm) * 100}%;background:${color(x)}` }))
        : pick[mode].filter((x) => k[x] > 0).map((x) => h("i", { style: `width:${(k[x] / maxKm) * 100}%;background:${color(x)}` }));
      return h("li", {},
        h("span", { class: "mo", text: `${+m.slice(5)}月` }),
        h("span", { class: "stack", title: ORDER.filter((x) => k[x]).map((x) => `${label(x)} ${km(k[x])}km`).join(" ／ ") }, bars),
        h("span", { class: "tot", text: `${km(val(k))}km` }),
        mode === "all" && nw.length ? h("small", { text: `初めて：${nw.slice(0, 6).map((s) => s.name).join("・")}${nw.length > 6 ? ` ほか${nw.length - 6}` : ""}` }) : null);
    })),
    h("p", { class: "muted", text: mode === "all" ? "棒の色：電車＝赤・高速＝濃い青・一般道＝薄い青・徒歩＝緑・船＝青緑。上の年を切り替えると、過去の年の月ごとも見られます。" : `${names[mode]}だけの距離。上の年を切り替えると、過去の年の月ごとも見られます。` })));
}

function stat(label, n, unit) {
  return h("div", {}, h("b", { text: String(n) }), h("small", { text: unit }), h("span", { text: label }));
}
