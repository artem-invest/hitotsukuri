// さがす（右上の🔍）：駅や施設に行ったことがあるかを、タイムラインまでさかのぼって調べる
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as rd from "./roads.js";
import { $, h, ymdw, toast } from "./ui.js";
import { S, visitsOf, uid, placeOf, needFind, needMaster, needRoads } from "./state.js";
import { load, ensureStation, ensureSpot } from "./data.js";
import { openDay } from "./mapview.js";
import { openSheet } from "./zukan.js";

function stationItem(m) {
  const c = geo.center(m);
  return { kind: "station", key: m.id, gid: m.id, m, name: m.name, label: "駅", lines: m.lines, lat: c.lat, lng: c.lng };
}
export function spotItem(sp) {
  const p = placeOf(sp.id);
  return { kind: "spot", key: p ? p.ids[0] : sp.id, ids: p ? p.ids : [sp.id], sp, name: p ? p.name : sp.name, label: rd.KINDS[sp.kind].label, lat: sp.lat, lng: sp.lng };
}
// 図鑑の台から（駅・施設のデータがまだ読めていなくても作れるように）
export function itemOfStation(s) {
  if (rd.KINDS[s.kind]) return spotItem(S.roads?.byId[s.id] || { id: s.id, kind: s.kind, name: s.name, lat: s.lat, lng: s.lng });
  return { kind: "station", key: s.gid, gid: s.gid, m: S.master?.byId[s.gid], name: s.name, label: "駅", lines: s.lines, lat: s.lat, lng: s.lng };
}
// その場所の図鑑の台（駅・施設。SA・PA は上り・下りで複数）
const zukanOf = (it) => (it.kind === "station" ? S.stations.filter((x) => x.gid && x.gid === it.gid) : S.stations.filter((x) => it.ids.includes(x.id)));
const itemVisits = (it) => zukanOf(it).flatMap((s) => visitsOf(s.id));

function candidates(q) {
  q = q.trim().replace(/駅$/, "");
  if (!q) return [];
  const out = geo.search(S.master, q, 6).map(stationItem);
  const seen = new Set();
  for (const sp of S.roads.spots) {
    if (!sp.name.includes(q)) continue;
    const it = spotItem(sp);
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    out.push(it);
    if (seen.size >= 8) break;
  }
  return out;
}

// さがす画面（シート）
export function openSearch() {
  const dlg = $("#sheet");
  const res = h("ul", { class: "sugg" });
  const q = h("input", { type: "search", placeholder: "駅・SA・PA・道の駅・銭湯の名前", autocomplete: "off", enterkeyhint: "search",
    oninput: async () => {
      const v = q.value;
      try { await needMaster(); await needRoads(); S.hwRoutes ||= await rd.loadHwRoutes(); } catch { return; }
      if (q.value !== v) return;
      res.replaceChildren(...candidates(v).map((it) => h("li", {},
        h("button", { type: "button", onclick: () => openFind(it) },
          h("b", { text: it.name }),
          h("small", { text: [it.name.includes(it.label) ? "" : it.label, it.lines, itemVisits(it).length ? "図鑑にあり" : ""].filter(Boolean).join("・") })))));
    } });
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("header", {},
      h("h2", { text: "行ったことある？" }),
      h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
    q, res,
    h("p", { class: "muted", text: "名前で探すと、タイムラインの記録までさかのぼって、乗り降りした日・立ち寄った日・通った日を出します。日付をタップするとその日のルート。" })));
  if (!dlg.open) dlg.showModal();
  q.focus();
}

// さがした場所の1枚：図鑑の記録と、タイムラインで見つかった日の一覧
export async function openFind(it) {
  const dlg = $("#sheet");
  const body = h("div", {}, h("p", { class: "muted", text: "記録を調べています…" }));
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("header", {},
      h("h2", { text: it.name }),
      h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
    h("p", { class: "muted", text: [it.label, it.lines].filter(Boolean).join("・") }),
    body));
  if (!dlg.open) dlg.showModal();
  try { await needFind(); } catch (e) { body.replaceChildren(h("p", { class: "muted", text: String(e?.message || e) })); return; }
  if (it.kind === "spot") { const p = placeOf(it.ids[0]); if (p) { it.ids = p.ids; it.key = p.ids[0]; } } // 上り・下りをまとめる
  const back = () => openFind(it);
  const here = { lat: it.lat, lng: it.lng, name: it.name, kind: it.sp?.kind };
  const vs = itemVisits(it).sort((a, b) => a.at.localeCompare(b.at));
  const mine = zukanOf(it);
  const rows = [...(S.findIdx.get(it.key) || new Map())].sort((a, b) => b[0].localeCompare(a[0]));
  const dayBtn = (d) => (S.dayKeys.includes(d)
    ? h("button", { type: "button", class: "linkish", text: ymdw(d), onclick: () => openDay(d, here, back) })
    : h("span", { text: ymdw(d) }));
  body.replaceChildren(
    vs.length
      ? h("div", { class: "vrow" },
          h("span", {}, h("b", { text: `図鑑にあり・記録 ${vs.filter((v) => !v.pending).length}回` }), vs.some((v) => v.pending) ? "（確認待ちあり）" : ""),
          h("button", { type: "button", class: "small", text: "図鑑のページ", onclick: () => openSheet(mine.find((s) => visitsOf(s.id).length) || mine[0]) }))
      : h("p", { class: "muted", text: mine.some((s) => s.rejected) ? "以前「行ってない」にした場所です。" : "図鑑にはまだありません。" }),
    rows.length
      ? h("div", {},
          h("h3", { class: "gridhead", text: `タイムラインで見つかった日（${rows.length}日）` }),
          h("ol", { class: "found" }, rows.slice(0, 60).map(([d, what]) => h("li", {},
            dayBtn(d),
            h("small", { text: [...what].join("・") }),
            vs.length ? null : h("button", { type: "button", class: "small", text: "行った", onclick: () => addFound(it, d) })))),
          rows.length > 60 ? h("p", { class: "muted", text: `ほか ${rows.length - 60}日` }) : null)
      : h("p", { class: "muted", text: S.dayKeys.length ? `タイムラインの記録（${ymdw(S.dayKeys[0])}〜）には見つかりませんでした。` : "タイムラインを読み込むと、さかのぼって探せます。" }),
    h("p", { class: "links" }, h("a", { href: `https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lng}`, target: "_blank", rel: "noopener", text: "地図で見る" })));
}

// さがした場所を、見つかった日に行ったこととして図鑑に入れる
async function addFound(it, date) {
  const at = new Date(date + "T12:00").toISOString();
  it.m ||= S.master?.byId[it.gid];
  const s = it.kind === "station" ? await ensureStation(it.m, date, "timeline") : await ensureSpot(S.roads?.byId[it.ids[0]] || it.sp, date, "timeline");
  if (s.rejected) { s.rejected = false; await db.put("stations", s); }
  await db.put("visits", { id: uid("v"), stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null });
  await load();
  toast(`${it.name} を図鑑に入れました（${ymdw(date)}）`);
  openFind(it);
}
