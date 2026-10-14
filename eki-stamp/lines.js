// 路線タブ：電車（路線の塗り絵）／高速道路（SA・PA）／道の駅（都道府県ごと）
import * as rd from "./roads.js";
import { h, md } from "./ui.js";
import { lineStyle } from "./linestyle.js";
import { S, render, remember, waitFor, visitsOf, needRides, needMaster, needHw, needMichi } from "./state.js";
import { openFind, spotItem } from "./find.js";

// 行った駅（全国データと結びついたもの）の集合
export const visitedGids = () => new Set(S.stations.filter((s) => s.gid && visitsOf(s.id).length).map((s) => s.gid));

// 降りた駅か通った区間が1つでもある路線と、その埋まり具合（done＝降りた駅、via＝通っただけの駅）
export function myLines() {
  if (!S.master) return [];
  const got = visitedGids();
  const touched = new Set(S.rides ? S.rides.byLine.keys() : []);
  for (const g of got) for (const i of S.master.byId[g]?.li || []) touched.add(i);
  return [...touched].map((i) => {
    const l = S.master.lines[i];
    const rode = S.rides?.byLine.get(i) || new Set();
    const done = l.ids.filter((id) => got.has(id)).length;
    const via = l.ids.filter((id) => !got.has(id) && rode.has(id)).length;
    return { ...l, rode, done, via, total: l.ids.length, left: l.ids.length - done };
  }).sort((a, b) => (b.done + b.via) / b.total - (a.done + a.via) / a.total || b.done - a.done);
}

const legend = (a, b) => h("p", { class: "legend" },
  h("span", { class: "on" }, h("i"), a), h("span", { class: "via" }, h("i"), b), h("span", {}, h("i"), "まだ"));

export function renderLines(main) {
  const mode = (m, label) => h("button", { type: "button", "aria-pressed": String(S.linesMode === m), text: label,
    onclick: () => { S.linesMode = m; remember("eki.linesMode", m); render(); } });
  main.append(h("div", { class: "seg" }, mode("train", "電車"), mode("hw", "高速道路"), mode("michi", "道の駅")));
  if (S.linesMode === "hw") renderHighways(main);
  else if (S.linesMode === "michi") renderMichi(main);
  else renderTrain(main);
}

/* ---------- 電車 ---------- */
function renderTrain(main) {
  if (!S.master || (S.dayKeys.length && !S.rides)) {
    waitFor(main, "rides", "乗った区間を計算しています…", async () => { await needMaster(); await needRides(); },
      () => !!S.master && (!S.dayKeys.length || !!S.rides), "駅データを読み込めませんでした。電波のある所で開き直してください。");
    return;
  }
  const lines = myLines();
  if (!lines.length) {
    main.append(h("p", { class: "empty", text: "行った駅を通る路線がここに並びます。全駅で降りたら「制覇」です。" }));
    return;
  }
  const got = visitedGids();
  const full = lines.filter((l) => l.left === 0).length;
  const rodeAll = lines.filter((l) => l.done + l.via === l.total).length;
  main.append(h("p", { class: "linesum" }, h("b", { text: `${lines.length}路線` }), ` にあしあと・降りて制覇 ${full}・乗りつぶし ${rodeAll}`));
  main.append(legend("降りた", "通った"));
  for (const l of lines) {
    const st = lineStyle(l.name);
    const pct = (n) => Math.round((n / l.total) * 1000) / 10;
    main.append(h("details", { class: "line" + (l.left === 0 ? " full" : ""), style: `--lc:${st.color}` },
      h("summary", {},
        h("span", { class: "lbadge", text: st.sym }),
        h("span", { class: "ln", text: l.name }),
        h("span", { class: "cnt", text: l.left === 0 ? "制覇！" : `${l.done}/${l.total}` }),
        h("span", { class: "bar" }, h("i", { style: `width:${pct(l.done)}%` }), h("i", { class: "via", style: `width:${pct(l.via)}%` })),
        l.via ? h("small", { class: "sub", text: `通った駅を入れると ${l.done + l.via}/${l.total}${l.done + l.via === l.total ? "（乗りつぶし）" : ""}` }) : null),
      h("ol", { class: "route" }, l.ids.map((id) => h("li", { class: got.has(id) ? "on" : l.rode.has(id) ? "via" : "" },
        h("i"), h("span", { text: S.master.byId[id].name }))))));
  }
  main.append(h("p", { class: "hint", text: "路線をタップすると、端から順に駅が路線図のように並びます。「通った」はタイムラインの電車の乗り降りから計算した区間です（乗り換えを含む移動は使っていません）。支線のある路線は順番が少し前後します。記号と色は各社の路線カラーに近いものです（首都圏の主な路線だけ）。" }));
}

/* ---------- 高速道路（SA・PA が駅のかわり） ---------- */
const placeWent = (p) => p.ids.some((id) => visitsOf(id).length);

function renderHighways(main) {
  if (!S.hwRoutes || !S.hwPass) {
    waitFor(main, "hw", "走った高速を計算しています…", needHw, () => !!S.hwRoutes && !!S.hwPass, "道路データを読み込めませんでした。電波のある所で開き直してください。");
    return;
  }
  const list = S.hwRoutes.map((r) => {
    const days = new Set();
    for (const p of r.places) for (const d of S.hwPass.get(p.ids[0]) || []) days.add(d);
    const on = r.places.filter(placeWent).length;
    const via = r.places.filter((p) => !placeWent(p) && S.hwPass.has(p.ids[0])).length;
    return { ...r, on, via, days, total: r.places.length };
  }).filter((r) => r.on || r.via)
    .sort((a, b) => b.on - a.on || b.days.size - a.days.size); // 立ち寄った数 → よく走った順
  if (!list.length) {
    main.append(h("p", { class: "empty", text: "タイムラインで車で高速を走った日や、立ち寄った SA・PA があると、その高速がここに並びます。" }));
    return;
  }
  main.append(h("p", { class: "linesum" }, h("b", { text: `${list.length}本` }), ` の高速にあしあと・SA・PA に立ち寄り ${list.reduce((n, r) => n + r.on, 0)}`));
  main.append(legend("立ち寄った", "通った"));
  for (const r of list) {
    const pct = (n) => Math.round((n / r.total) * 1000) / 10;
    const last = [...r.days].sort().at(-1);
    main.append(h("details", { class: "line hw" + (r.on === r.total ? " full" : ""), style: "--lc:#1f7a4a" },
      h("summary", {},
        h("span", { class: "lbadge hwsym", text: r.sym || "高速" }),
        h("span", { class: "ln", text: r.name }),
        h("span", { class: "cnt", text: r.on === r.total ? "制覇！" : `${r.on}/${r.total}` }),
        h("span", { class: "bar" }, h("i", { style: `width:${pct(r.on)}%` }), h("i", { class: "via", style: `width:${pct(r.via)}%` })),
        h("small", { class: "sub", text: [r.days.size ? `走った日 ${r.days.size}日（最後は${md(last + "T12:00")}）` : "", r.via ? `通った SA・PA を入れると ${r.on + r.via}/${r.total}` : ""].filter(Boolean).join("・") })),
      h("ol", { class: "route" }, r.places.map((p) => h("li", { class: placeWent(p) ? "on" : S.hwPass.has(p.ids[0]) ? "via" : "", onclick: () => openFind(spotItem(S.roads.byId[p.ids[0]])) },
        h("i"), h("span", { text: p.name }))))));
  }
  main.append(h("p", { class: "hint", text: "高速をタップすると、東京に近い側から SA・PA が並びます。名前をタップすると、行った日・通った日とその日のルートが見られます。「通った」はタイムラインの車の道のりからの推定です（点がまばらなので、そばを走っただけでも入ることがあります）。上り・下りは1か所にまとめています。" }));
}

/* ---------- 道の駅（都道府県ごと） ---------- */
function michiCard(p) {
  const on = p.items.filter((it) => visitsOf(it.id).length).length;
  const pct = Math.round((on / p.items.length) * 1000) / 10;
  return h("details", { class: "line michi" + (on === p.items.length ? " full" : ""), style: `--lc:${rd.KINDS.michi.color}` },
    h("summary", {},
      h("span", { class: "ln", text: p.pref }),
      h("span", { class: "cnt", text: on === p.items.length ? "制覇！" : `${on}/${p.items.length}` }),
      h("span", { class: "bar" }, h("i", { style: `width:${pct}%` }))),
    h("ul", { class: "chips" }, p.items.map((it) => h("li", {},
      h("button", { type: "button", class: visitsOf(it.id).length ? "on" : "", text: it.name, onclick: () => openFind(spotItem(S.roads.byId[it.id])) })))));
}

function renderMichi(main) {
  if (!S.michiPrefs || !S.roads || !S.hwRoutes) {
    waitFor(main, "michi", "道の駅を読み込んでいます…", needMichi, () => !!S.michiPrefs && !!S.roads, "道の駅のデータを読み込めませんでした。電波のある所で開き直してください。");
    return;
  }
  const went = (p) => p.items.some((it) => visitsOf(it.id).length);
  const mine = S.michiPrefs.filter(went);
  const total = S.michiPrefs.reduce((n, p) => n + p.items.filter((it) => visitsOf(it.id).length).length, 0);
  main.append(h("p", { class: "linesum" }, h("b", { text: `道の駅 ${total}か所` }), ` に立ち寄り・${mine.length}都道府県`));
  if (mine.length) for (const p of mine) main.append(michiCard(p));
  else main.append(h("p", { class: "empty", text: "立ち寄った道の駅がある都道府県がここに並びます。" }));
  // ほかの都道府県は地方ごとにたたんでおく
  const rest = h("details", { class: "add" }, h("summary", { text: "ほかの都道府県（地方ごと）" }));
  rest.addEventListener("toggle", () => {
    if (!rest.open || rest.children.length > 1) return;
    let region = null;
    for (const p of S.michiPrefs.filter((x) => !went(x))) {
      if (p.region !== region) { region = p.region; rest.append(h("h3", { class: "gridhead", text: region })); }
      rest.append(michiCard(p));
    }
  });
  main.append(rest);
  main.append(h("p", { class: "hint", text: "県をタップすると、その県の道の駅が近い順に並びます（色つき＝図鑑にある）。名前をタップすると、行った日・近くに立ち寄った日とその日のルートが見られます。道の駅の位置は OpenStreetMap から取っていて、実際の数（全国約1,230）より少し欠けています。" }));
}
