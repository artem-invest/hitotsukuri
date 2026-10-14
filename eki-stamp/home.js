// 最近（最初の画面）：日曜の流れ・確認待ち・今月の距離・最近の日・次の一駅・GPSで記録
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";
import { ROADCOLORS } from "./map.js";
import { h, md, mdw, ymdw, localDay, meters, toast } from "./ui.js";
import { S, render, go, openMapDay, waitFor, visitsOf, isSpot, needAll } from "./state.js";
import { load, importTimeline, exportJson, confirmVisit, addVisit, ensureSpot, ensureStation, lastWeekSunday } from "./data.js";
import { openDay } from "./mapview.js";
import { myLines, visitedGids } from "./lines.js";

// タイムラインのファイルを選ぶボタン（どの画面からも使う）
export function timelinePicker(label, primary = false) {
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: () => { if (file.files[0]) importTimeline(file.files[0]); file.value = ""; } });
  return [h("button", { type: "button", class: primary ? "primary" : "", onclick: () => file.click(), text: label }), file];
}

// 1日の手段ごとの距離（車は高速／一般道に分ける。飛行機は入れない）
export function dayKm(d) {
  const k = tl.kmByMode(d.acts); delete k.fly;
  if (S.roads && k.car) { const c = rd.splitCar(S.roads, d); delete k.car; k.hw = c.hw; k.general = c.general; }
  return k;
}
export const chipsOf = (k) => Object.entries(k).filter(([, v]) => v >= 0.1).map(([m, v]) =>
  h("span", { class: "chip", style: `--c:${m === "hw" ? ROADCOLORS.hw : m === "general" ? ROADCOLORS.general : tl.MODES[m]?.color}`,
    text: `${m === "hw" ? "高速" : m === "general" ? "一般道" : tl.MODES[m]?.label} ${Math.round(v * 10) / 10}km` }));

/* ---------- 日曜の流れ：① タイムラインを読み込む → ② 今週のあしあとを見て、バックアップを保存 ---------- */
// 日曜に済ませられなかったら、次の土曜まで出したまま。「今週はしない」でその週は消す
function weeklyCard() {
  if (!S.dayKeys.length) return null;
  const sun = lastWeekSunday();
  const sunKey = localDay(sun.toISOString());
  if (S.meta.tlSkip === sunKey) return null;
  const read = S.meta.lastTimeline && Date.parse(S.meta.lastTimeline) >= sun.getTime();
  const saved = read && S.meta.lastExport && Date.parse(S.meta.lastExport) >= Date.parse(S.meta.lastTimeline);
  if (saved) return null;
  const skip = h("button", { type: "button", class: "small", text: "今週はしない",
    onclick: async () => { S.meta.tlSkip = sunKey; await db.setMeta("timelineSkip", sunKey); render(); } });
  const steps = h("ol", { class: "flow" },
    h("li", { class: read ? "done" : "now", text: "タイムラインを読み込む" }),
    h("li", { class: read ? "now" : "", text: "バックアップを保存" }));
  if (!read) {
    return h("section", { class: "card weekly" },
      h("h2", { text: new Date().getDay() === 0 ? "日曜日：今週のあしあとを入れる日です" : "今週のタイムラインがまだです" }), steps,
      h("p", { class: "muted", text: `スマホの「設定」→「位置情報」→「位置情報サービス」→「タイムライン」→「タイムライン データをエクスポート」で保存して、下のボタンで選んでください。${S.meta.lastTimeline ? `前回は${md(S.meta.lastTimeline)}。` : ""}` }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む", true), skip));
  }
  // この1週間に初めて行った場所
  const since = Date.parse(S.meta.lastTimeline) - 8 * 86400000;
  const first = new Map();
  for (const v of S.visits) if (!first.has(v.stationId) || v.at < first.get(v.stationId)) first.set(v.stationId, v.at);
  const fresh = S.stations.filter((s) => first.has(s.id) && Date.parse(first.get(s.id)) >= since);
  return h("section", { class: "card weekly" },
    h("h2", { text: "読み込みました。最後にバックアップを" }), steps,
    h("p", { text: fresh.length ? `この1週間に初めて行った場所：${fresh.map((s) => s.name).join("・")}` : "この1週間に初めて行った場所はありませんでした。" }),
    S.pending.length ? h("p", { class: "muted", text: `下の「行ったか確かめてください」が ${S.pending.length} 件あります。` }) : null,
    h("p", { class: "muted", text: "記録はこのスマホの中にしかありません。保存先に「ドライブ」を選ぶと、スマホを失くしても道のりごと戻せます。" }),
    h("div", { class: "btns" }, h("button", { type: "button", class: "primary", text: "バックアップを保存（Googleドライブなど）", onclick: exportJson }), skip));
}

function backupNudge() {
  const days = S.meta.lastExport ? (Date.now() - Date.parse(S.meta.lastExport)) / 86400000 : Infinity;
  if (days < 30 || !S.visits.length) return null;
  return h("button", { class: "nudge", type: "button", onclick: () => go("more", "backup") },
    S.meta.lastExport ? `最後のバックアップから${Math.floor(days)}日たちました。書き出しておきましょう →` : "まだバックアップがありません。一度書き出しておきましょう →");
}

/* ---------- 確認待ち ---------- */
export function renderConfirm() {
  if (!S.pending.length) return null;
  const all = h("button", { type: "button", class: "small", text: `全部「行った」にする（${S.pending.length}件）`,
    onclick: async () => {
      if (!all.dataset.armed) { all.dataset.armed = "1"; all.textContent = "もう一度押すと全部「行った」"; return; }
      const n = S.pending.length;
      for (const v of S.pending) { v.pending = false; await db.put("visits", v); }
      await load();
      toast(`${n}件を図鑑に入れました`);
    } });
  return h("section", { class: "card confirm" },
    h("h2", { text: `行ったか確かめてください（${S.pending.length}件）` }),
    h("p", { class: "muted", text: "タイムラインから見つけたけれど、確かではない場所です（施設の近くに長めにいた・紛らわしい駅が近くにある）。日付をタップするとその日のルートが見られます。" }),
    h("ol", { class: "nearlist" }, S.pending.map((v) => {
      const s = S.stations.find((x) => x.id === v.stationId);
      if (!s) return null;
      const day = localDay(v.at);
      const why = isSpot(s)
        ? [v.stay != null ? `${v.stay}分いた` : "", v.dist != null ? `${v.dist}m` : ""]
        : [v.dist != null ? `乗り降りした地点から${v.dist}m` : "", v.alt ? `近くに${v.alt}駅` : ""];
      return h("li", {},
        h("div", {}, h("b", { text: s.name }), h("small", {},
          `${rd.KINDS[s.kind]?.label || "駅"}・`,
          S.dayKeys.includes(day) ? h("button", { type: "button", class: "linkish", text: ymdw(day), onclick: () => openDay(day, s) }) : ymdw(day),
          [""].concat(why.filter(Boolean)).join("・"))),
        h("div", { class: "yn" },
          h("button", { type: "button", class: "primary", text: "行った", onclick: () => confirmVisit(v, true) }),
          h("button", { type: "button", text: "行ってない", onclick: () => confirmVisit(v, false) })));
    })),
    S.pending.length >= 5 ? h("div", { class: "btns" }, all) : null);
}

/* ---------- 次の一駅 ---------- */
// 自分の路線のまだの駅を、今いる所（無ければ最後に行った駅）から近い順に
function nextStations(n = 3) {
  const lines = myLines();
  if (!lines.length) return { from: null, list: [] };
  let from = S.near.state === "done" ? { lat: S.near.pos.lat, lng: S.near.pos.lng, label: "今いる所" } : null;
  if (!from) {
    const last = [...S.visits].sort((a, b) => b.at.localeCompare(a.at)).map((v) => S.stations.find((s) => s.id === v.stationId)).find((s) => s?.lat != null && !isSpot(s));
    if (last) from = { lat: last.lat, lng: last.lng, label: `最後に行った${last.name}` };
  }
  if (!from) return { from: null, list: [] };
  const got = visitedGids();
  const seen = new Map();
  for (const l of lines) {
    for (const id of l.ids) {
      if (got.has(id)) continue;
      const m = S.master.byId[id];
      const d = Math.min(...m.pts.map((p) => geo.distance(from.lat, from.lng, p[1], p[0])));
      const cur = seen.get(id);
      // 同じ駅が複数の路線にあるときは、残りの少ない（制覇に近い）路線で紹介する
      if (!cur || l.left < cur.line.left) seen.set(id, { m, d, line: l, via: l.rode.has(id) || cur?.via });
    }
  }
  return { from, list: [...seen.values()].sort((a, b) => a.d - b.d).slice(0, n) };
}

function renderNext() {
  if (!S.master) return null;
  const { from, list } = nextStations();
  if (!list.length) return null;
  return h("section", { class: "next" },
    h("h2", { text: "次の一駅" }),
    h("p", { class: "muted", text: `${from.label}から近い、あなたの路線のまだ降りていない駅` }),
    h("ol", { class: "nearlist" }, list.map(({ m, d, line, via }) => h("li", {},
      h("div", {}, h("b", { text: m.name }), h("small", { text: `${line.name} あと${line.left}駅で制覇・${meters(d)}${via ? "・通ったことはある" : ""}` })),
      h("a", { class: "maplink", href: `https://www.google.com/maps/search/?api=1&query=${geo.center(m).lat},${geo.center(m).lng}`, target: "_blank", rel: "noopener", text: "地図" })))));
}

/* ---------- GPSでその場で記録 ---------- */
const stampedToday = (s) => !!s && visitsOf(s.id).some((v) => new Date(v.at).toDateString() === new Date().toDateString());

export async function findNear() {
  S.near = { state: "locating" };
  render();
  try {
    const [m, pos] = await Promise.all([geo.loadMaster(), geo.locate()]);
    S.master = m;
    try { S.roads ||= await rd.loadRoads(); } catch {}
    const spot = S.roads ? (rd.nearestSpot(S.roads, pos.lat, pos.lng)
      || rd.nearestSpot(S.roads, pos.lat, pos.lng, 1500, (s) => rd.KINDS[s.kind].group === "road")) : null;
    S.near = { state: "done", pos, list: geo.nearest(m, pos.lat, pos.lng, 3), spot };
  } catch (e) {
    const msg = e?.code === 1 ? "位置情報が許可されていません。スマホの設定で、このアプリ（Chrome）の位置情報を許可してください。"
      : e?.code === 3 ? "位置が取れませんでした（時間切れ）。空が見える場所でもう一度どうぞ。"
      : e?.code === 2 ? "位置が取れませんでした。位置情報がオンか確かめてください。"
      : "駅データを読み込めませんでした。一度電波のある所で開いてください。";
    S.near = { state: "error", msg };
  }
  render();
}

async function stampHere(m) {
  const s = rd.KINDS[m.kind] ? await ensureSpot(m) : await ensureStation(m);
  await addVisit(s, S.near.pos);
}

function renderNear() {
  const { near } = S;
  const box = h("section", { class: "near" });
  box.append(h("button", { type: "button", class: "primary big", onclick: findNear,
    disabled: near.state === "locating",
    text: near.state === "locating" ? "現在地を確かめています…" : near.state === "done" ? "もう一度探す" : "今いる駅・SA・銭湯を記録する（GPS）" }));
  if (near.state === "error") box.append(h("p", { class: "warn", text: near.msg }));
  if (near.state === "done") {
    const { pos, spot } = near;
    const list = spot ? [spot, ...near.list] : near.list; // SA・PA・道の駅が近くにあれば、駅より先に出す
    if (pos.acc > geo.STAMP_RADIUS) box.append(h("p", { class: "warn", text: `位置の誤差が大きめです（±${meters(pos.acc)}）。少し待ってもう一度探すと正確になります。` }));
    if (!list.length) box.append(h("p", { class: "muted", text: "5km以内に駅がありません。" }));
    box.append(h("ol", { class: "nearlist" }, list.map((m) => {
      const ok = m.dist <= (rd.KINDS[m.kind] ? Math.max(rd.KINDS[m.kind].radius, 100) : geo.STAMP_RADIUS);
      const done = stampedToday(S.stations.find((x) => x.gid === m.id || x.id === m.id));
      const sub = rd.KINDS[m.kind] ? rd.KINDS[m.kind].label : m.lines;
      return h("li", { class: ok ? "in" : "" },
        h("div", {}, h("b", { text: m.name }), h("small", { text: `${meters(m.dist)}・${sub}` })),
        ok
          ? h("button", { type: "button", class: "primary", disabled: done, text: done ? "今日は記録済み" : "記録する",
              onclick: async (e) => { e.currentTarget.disabled = true; await stampHere(m); } })
          : h("span", { class: "muted", text: `あと${meters(m.dist - geo.STAMP_RADIUS)}` }));
    })));
  }
  return box;
}

/* ---------- 画面 ---------- */
export function renderHome(main) {
  main.append(weeklyCard() || "", backupNudge() || "", renderConfirm() || "");
  if (S.dayKeys.length && !S.allDays) {
    waitFor(main, "all", "記録を集計しています…", needAll, () => !!S.allDays);
    return;
  }
  const days = S.allDays || [];
  // 初めて行った日（駅・施設ごと）
  const firstAt = new Map();
  for (const v of S.visits) if (!firstAt.has(v.stationId) || v.at < firstAt.get(v.stationId)) firstAt.set(v.stationId, v.at);
  const newOn = (date) => S.stations.filter((s) => firstAt.get(s.id) && localDay(firstAt.get(s.id)) === date);

  if (days.length) {
    // 今月
    const month = days.at(-1).date.slice(0, 7);
    const mk = {};
    for (const d of days.filter((x) => x.date.startsWith(month))) for (const [m, v] of Object.entries(dayKm(d))) mk[m] = (mk[m] || 0) + v;
    const newM = S.stations.filter((s) => firstAt.get(s.id) && localDay(firstAt.get(s.id)).startsWith(month));
    main.append(h("section", { class: "card review" },
      h("p", { class: "muted", text: `${+month.slice(5)}月のあしあと` }),
      h("p", { class: "big" }, h("b", { text: Math.round(Object.values(mk).reduce((a, b) => a + b, 0)).toLocaleString() }), " km"),
      h("div", { class: "modes" }, chipsOf(mk)),
      newM.length ? h("p", { class: "muted", text: `初めて：${newM.map((s) => s.name).join("・")}` }) : null));
    // 最近の日
    main.append(h("h2", { class: "gridhead", text: "最近の日" }),
      h("ol", { class: "recent" }, days.slice(-7).reverse().map((d) => {
        const nw = newOn(d.date);
        return h("li", {}, h("button", { type: "button", onclick: () => openMapDay(d.date) },
          h("b", { text: ymdw(d.date) }),
          h("div", { class: "modes" }, chipsOf(dayKm(d))),
          nw.length ? h("small", { text: `初めて：${nw.map((s) => s.name).join("・")}` }) : null));
      })),
      h("p", { class: "muted", text: `移動の記録は ${mdw(days.at(-1).date)} まで。` }));
  } else {
    main.append(h("section", { class: "card" },
      h("h2", { text: "移動の記録を読み込む" }),
      h("p", { text: "Googleマップのタイムラインを読み込むと、最近の移動・初めて行った場所・路線のあしあとが自動でたまります。" }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む", true))));
  }
  main.append(renderNext() || "");
  main.append(h("details", { class: "add gps" }, h("summary", { text: "今いる場所をその場で記録する（GPS）" }), renderNear()));
}
