// 地図：1日の道のり（地図タブと、ほかの画面から開く「その日のルート」）。その日の移動の一覧と手段の手直し
import * as db from "./db.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";
import { drawDay, refreshMap, ROADCOLORS } from "./map.js";
import { $, h, ymdw, localDay } from "./ui.js";
import { S, render, go, needRoads } from "./state.js";
import { setMode, fixOf } from "./data.js";
import { timelinePicker } from "./home.js";

const hm = (t) => { const d = new Date(t * 1000); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
// 手直しで選べる手段（飛行機以外の距離はすべて集計に入る）
const CHOICES = ["train", "car", "bus", "walk", "bike", "boat", "fly", "other"];

// その日の移動の一覧。手段を選び直すと、その移動だけ直す（タイムラインを読み直しても残る）
export function actList(day) {
  if (!day.acts.length) return null;
  return h("details", { class: "add acts" }, h("summary", { text: `この日の移動 ${day.acts.length}回（手段が違っていたら直せます）` }),
    h("ol", { class: "actlist" }, day.acts.map((a) => {
      const sel = h("select", { "aria-label": "移動手段", onchange: () => setMode(day.date, a, sel.value) },
        CHOICES.map((m) => h("option", { value: m, text: tl.MODES[m].label, selected: m === a.mode })));
      return h("li", {},
        h("span", { class: "t", text: `${hm(a.s)}〜${hm(a.e)}` }),
        h("span", { class: "k", text: `${a.km}km` }),
        sel,
        fixOf(day.date, a) ? h("small", { text: "直した" }) : null);
    })));
}

// 地図を画面いっぱいに広げる／戻す（指2本で拡大しやすいように）
function fullButton(box) {
  const b = h("button", { type: "button", class: "mapfull", text: "⛶ 全画面",
    onpointerdown: (e) => e.stopPropagation(),
    onclick: (e) => {
      e.stopPropagation();
      const on = box.classList.toggle("full");
      b.textContent = on ? "× 閉じる" : "⛶ 全画面";
      refreshMap();
    } });
  return b;
}

export function renderMap(main) {
  if (!S.dayKeys.length) {
    main.append(h("section", { class: "card" },
      h("h2", { text: "移動の記録を読み込む" }),
      h("p", { text: "Googleマップのタイムライン（スマホが裏で記録している、行った場所と道のり）を読み込むと、日ごとの道のりが地図に出て、電車で乗り降りした駅や立ち寄った施設が図鑑に入ります。" }),
      h("ol", { class: "steps" },
        h("li", { text: "スマホの「設定」→「位置情報」→「位置情報サービス」→「タイムライン」" }),
        h("li", { text: "「タイムライン データをエクスポート」で保存" }),
        h("li", { text: "下のボタンで、そのファイルを選ぶ" })),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む", true)),
      h("p", { class: "muted", text: "ファイルはこのスマホの中で読むだけで、どこにも送りません。" })));
    return;
  }
  const keys = S.dayKeys;
  if (!S.mapDate || !keys.includes(S.mapDate)) S.mapDate = keys.at(-1);
  const i = keys.indexOf(S.mapDate);
  const show = (d) => { S.mapDate = d; render(); };
  const pick = h("input", { type: "date", value: S.mapDate, min: keys[0], max: keys.at(-1),
    onchange: () => show([...keys].reverse().find((d) => d <= pick.value) || keys[0]) }); // 記録の無い日なら、その日以前で一番近い日
  main.append(h("div", { class: "daynav" },
    h("button", { type: "button", "aria-label": "前の日", disabled: i <= 0, onclick: () => show(keys[i - 1]), text: "‹" }),
    pick,
    h("button", { type: "button", "aria-label": "次の日", disabled: i >= keys.length - 1, onclick: () => show(keys[i + 1]), text: "›" })));
  const sum = h("div", { class: "modes" });
  const box = h("div", { class: "map big" });
  const below = h("div");
  main.append(sum, box, below);
  const date = S.mapDate;
  Promise.all([db.get("days", date), needRoads().catch(() => null)]).then(([day]) => {
    if (!day || S.mapDate !== date || S.tab !== "map") return;
    const km = tl.kmByMode(day.acts);
    const car = S.roads && km.car ? rd.splitCar(S.roads, day) : null;
    const total = Object.entries(km).filter(([m]) => m !== "fly").reduce((a, [, b]) => a + b, 0);
    const chips = Object.entries(km).filter(([, v]) => v > 0).flatMap(([m, v]) =>
      m === "car" && car
        ? [h("span", { class: "chip", style: `--c:${ROADCOLORS.hw}`, text: `高速 ${car.hw}km` }),
           h("span", { class: "chip", style: `--c:${ROADCOLORS.general}`, text: `一般道 ${car.general}km` })]
        : [h("span", { class: "chip", style: `--c:${tl.MODES[m].color}`, text: `${tl.MODES[m].label} ${v}km` })]);
    sum.replaceChildren(h("b", { text: `${ymdw(date)}　${total.toFixed(1)}km` }), ...chips);
    const stamped = S.visits.filter((v) => localDay(v.at) === date)
      .map((v) => S.stations.find((s) => s.id === v.stationId)).filter((s) => s?.lat != null);
    drawDay(box, day, stamped, car);
    box.append(fullButton(box));
    below.replaceChildren(
      car?.names.length ? h("p", { class: "muted", text: `走った高速：${car.names.slice(0, 6).join("・")}` }) : "",
      stamped.length ? h("p", { class: "muted", text: `この日に記録した場所：${[...new Set(stamped.map((s) => s.name))].join("・")}` }) : "",
      actList(day) || "");
  });
}

/* ---------- その日のルート（シートの中に地図） ---------- */
// s があればその場所に印。back があれば「戻る」で前のシートへ
export async function openDay(date, s, back = null) {
  const dlg = $("#sheet");
  const box = h("div", { class: "map dlgmap" });
  const sum = h("div", { class: "modes" });
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("header", {},
      h("h2", { text: `${ymdw(date)}のルート` }),
      h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
    sum, box,
    h("div", { class: "foot" },
      back ? h("button", { type: "button", class: "small", text: "← 戻る", onclick: back }) : h("span"),
      h("button", { type: "button", class: "small", text: "地図タブで開く", onclick: () => { dlg.close(); S.mapDate = date; go("map"); } }))));
  if (!dlg.open) dlg.showModal();
  const [day] = await Promise.all([db.get("days", date), needRoads().catch(() => null)]);
  if (!day) { box.textContent = "この日の道のりの記録はありません。"; return; }
  const km = tl.kmByMode(day.acts);
  const car = S.roads && km.car ? rd.splitCar(S.roads, day) : null;
  sum.replaceChildren(...Object.entries(km).filter(([m, v]) => v > 0 && m !== "fly").map(([m, v]) =>
    h("span", { class: "chip", style: `--c:${tl.MODES[m].color}`, text: `${tl.MODES[m].label} ${v}km` })));
  drawDay(box, day, s?.lat != null ? [s] : [], car);
}
