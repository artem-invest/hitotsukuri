// 共有の状態と、データの読み込み係（どの画面からも使う）
// 状態は S ひとつにまとめる。画面ごとのファイルは S を読み書きし、描き直しは render() を呼ぶ
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";
import { h, localDay } from "./ui.js";

export const APP_VERSION = "3.0.0";

export const S = {
  stations: [],
  visits: [],
  pending: [],          // 確認待ちの記録（本人が「行った」と言うまで図鑑に入れない）
  meta: { lastExport: null, lastTimeline: null, tlSkip: null, persisted: "?", modeFix: {} },
  tab: "home",          // 下のタブ：home / zukan / lines / map / more
  more: "review",       // その他の中：review（年報）/ life（家探し）/ backup（設定）
  linesMode: "train",   // 路線タブ：train（電車）／ hw（高速）／ michi（道の駅）
  reviewYear: null,     // 年報で見ている年
  reviewMode: "all",    // 年報の月ごとで見る移動手段
  near: { state: "idle" }, // 近くの駅：idle / locating / done / error
  master: null,         // 全国の駅データ（geo.loadMaster）
  roads: null,          // SA・PA・道の駅・銭湯と高速道路（rd.loadRoads）
  hwRoutes: null,       // 高速道路ごとの SA・PA の並び（rd.loadHwRoutes）
  michiPrefs: null,     // 都道府県ごとの道の駅（rd.loadMichi）
  dayKeys: [],          // タイムラインの記録がある日（"YYYY-MM-DD" の昇順）
  allDays: null,        // 全日分の道のり。集計する画面で初めて読む
  rides: null,          // 乗った区間 {byLine, count, list}。タイムラインから計算
  hwPass: null,         // 高速で通った SA・PA → 日付
  findIdx: null,        // 駅・施設ごとに、タイムラインで見つかった日と何をしたか
  mapDate: null,        // 地図で見ている日
  life: { places: [], candidates: [] }, // 家探し（meta "life"）
};

const saved = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
export const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
S.linesMode = saved("eki.linesMode", "train");
S.more = saved("eki.more", "review");
S.tab = saved("eki.tab", "home");
// 3.0.0 で「年報・家探し・設定」を「その他」にまとめた。それより前の保存値を読み替える
if (["review", "life", "backup"].includes(S.tab)) { S.more = S.tab; S.tab = "more"; }
S.tab = { stamps: "home", log: "more" }[S.tab] || S.tab;
if (!["home", "zukan", "lines", "map", "more"].includes(S.tab)) S.tab = "home";

/* ---------- 描き直し ---------- */
let renderer = () => {};
export const setRenderer = (f) => { renderer = f; };
export const render = () => renderer();
// いま見ている画面の名前（読み込みを待つあいだに別の画面へ移ったら、描き直さないため）
export const viewKey = () => `${S.tab}|${S.tab === "lines" ? S.linesMode : S.tab === "more" ? S.more : ""}`;

export function go(tab, more = null) {
  S.tab = tab;
  if (more) { S.more = more; remember("eki.more", more); }
  remember("eki.tab", tab);
  render();
  window.scrollTo(0, 0);
}
export const openMapDay = (date) => { S.mapDate = date; go("map"); };

// 読み込みを待ってから描き直す（共通の部品）
// ・同じ読み込みは同時に1回だけ走らせる
// ・読み込みが終わっても ready() が偽なら、描き直さずに案内を出す（2.3.3 で直した「描き直しが永久に回る」不具合を二度と作らないため）
// ・待っている間に別の画面へ移ったら描き直さない
const inflight = new Map();
export function waitFor(main, key, text, loader, ready, failText = "読み込めませんでした。電波のある所で開き直してください。") {
  const msg = h("p", { class: "empty", text });
  main.append(msg);
  const view = viewKey();
  if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(loader).finally(() => inflight.delete(key)));
  inflight.get(key).then(
    () => { if (!ready()) msg.textContent = failText; else if (viewKey() === view) render(); },
    () => { msg.textContent = failText; });
}
// 画面はそのままで、裏で読み込んでおき、終わったら1回だけ描き直す（回数の表示などのおまけ用）
export function loadInBackground(key, loader, ready) {
  if (ready() || inflight.has(key)) return;
  const view = viewKey();
  inflight.set(key, Promise.resolve().then(loader).finally(() => inflight.delete(key)));
  inflight.get(key).then(() => { if (ready() && viewKey() === view) render(); }, () => {});
}

/* ---------- 小道具 ---------- */
export const isSpot = (s) => !!rd.KINDS[s?.kind]; // SA・PA・道の駅・銭湯・温泉（駅以外）
export const visitsOf = (id) => S.visits.filter((v) => v.stationId === id).sort((a, b) => a.at.localeCompare(b.at));
export const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const HOW = { tap: "タップ", gps: "GPS", chokan: "朝刊から", import: "読み込み", timeline: "タイムライン" };

/* ---------- 読み込み係（どれも、済んでいれば何もしない） ---------- */
export async function needMaster() { S.master ||= await geo.loadMaster(); return S.master; }
export async function needRoads() { S.roads ||= await rd.loadRoads(); return S.roads; }
export async function needDays() { S.allDays ||= await db.getAll("days"); return S.allDays; }

// 集計する画面の前に：全日分・道路・駅（道路と駅は読めなくても集計はできる）
export async function needAll() {
  await Promise.all([needDays(), needRoads().catch(() => null), needMaster().catch(() => null)]);
}

// 乗った区間（駅データが無ければ自分で読む）
export async function needRides() {
  if (S.rides || !S.dayKeys.length) return;
  await needMaster();
  await needDays();
  const byLine = new Map();
  const list = tl.railRides(S.allDays, S.master, geo.STAMP_RADIUS);
  for (const r of list) {
    const set = byLine.get(r.li) || new Set();
    for (const id of r.ids) set.add(id);
    byLine.set(r.li, set);
  }
  S.rides = { byLine, count: list.length, list };
}

// 高速：並びと、車で通った SA・PA
export async function needHw() {
  await needAll();
  S.hwRoutes ||= await rd.loadHwRoutes();
  if (!S.roads) throw new Error("道路データを読み込めませんでした");
  S.hwPass ||= rd.hwPasses(S.roads, S.hwRoutes, S.allDays || []);
}

export async function needMichi() {
  await needRoads();
  S.hwRoutes ||= await rd.loadHwRoutes();
  S.michiPrefs ||= await rd.loadMichi();
}

// SA・PA は上り・下りを1か所にまとめて数える
export const placeOf = (id) => S.hwRoutes?.flatMap((r) => r.places).find((p) => p.ids.includes(id)) || null;
export const placeKey = (id) => placeOf(id)?.ids[0] || id;

// 駅・施設ごとに、タイムラインで見つかった日と、その日に何をしたか（key → Map(日付 → Set(何をしたか))）
export async function needFind() {
  await needAll();
  S.hwRoutes ||= await rd.loadHwRoutes();
  if (!S.master || !S.roads) throw new Error("駅・道路のデータを読み込めませんでした");
  await needRides();
  S.hwPass ||= rd.hwPasses(S.roads, S.hwRoutes, S.allDays || []);
  if (S.findIdx) return;
  const days = S.allDays || [];
  const idx = new Map();
  const put = (k, date, what) => {
    if (!idx.has(k)) idx.set(k, new Map());
    const m = idx.get(k);
    if (!m.has(date)) m.set(date, new Set());
    m.get(date).add(what);
  };
  const dayOf = (t) => localDay(new Date(t * 1000).toISOString());
  for (const { m, t } of tl.railStops(days, S.master, geo.STAMP_RADIUS)) put(m.id, dayOf(t), "乗り降り");
  for (const r of S.rides?.list || []) for (const id of r.ids.slice(1, -1)) put(id, r.date, "電車で通過");
  for (const { spot, t } of rd.spotStops(S.roads, days)) put(placeKey(spot.id), dayOf(t), "近くに立ち寄り");
  for (const [k, dates] of S.hwPass) for (const d of dates) put(k, d, "高速で通過");
  S.findIdx = idx;
}

// 道のりが変わったら、そこから計算したものを捨てる（次に見たときに計算し直す）
export function forgetCalc() { S.rides = null; S.hwPass = null; S.findIdx = null; }

// 図鑑の台 s に行った日の数（記録した日 ＋ タイムラインで乗り降り・立ち寄りした日）。タイムラインの計算がまだなら記録だけ
export function daysVisited(s) {
  const days = new Set(visitsOf(s.id).map((v) => localDay(v.at)));
  const key = s.gid || (isSpot(s) ? placeKey(s.id) : null);
  for (const [d, what] of S.findIdx?.get(key) || []) if (what.has("乗り降り") || what.has("近くに立ち寄り")) days.add(d);
  return days;
}
