// 記録の読み書き：読み直し・訪問の追加と削除・タイムラインの取り込み・バックアップ・記録の更新手順・移動手段の手直し
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as tl from "./timeline.js";
import * as rd from "./roads.js";
import { h, today, toast, ymd } from "./ui.js";
import { S, render, visitsOf, isSpot, uid, needMaster, needRoads, needDays, forgetCalc } from "./state.js";

/* ---------- 読み直し ---------- */
export async function load() {
  const [st, all] = await Promise.all([db.getAll("stations"), db.getAll("visits")]);
  S.stations = st;
  S.visits = all.filter((v) => !v.pending);
  S.pending = all.filter((v) => v.pending).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const k of ["lastExport", "lastTimeline"]) S.meta[k] = await db.getMeta(k);
  S.meta.tlSkip = await db.getMeta("timelineSkip");
  S.meta.modeFix = (await db.getMeta("modeFix")) || {};
  S.dayKeys = (await db.getAllKeys("days")).sort();
  S.allDays = null;
  forgetCalc();
  render();
}

// 「このサイトのデータは消さないで」とブラウザに頼む。断られても動作はする
export async function askPersist() {
  if (!navigator.storage?.persist) return "unsupported";
  if (await navigator.storage.persisted()) return "yes";
  return (await navigator.storage.persist()) ? "yes" : "no";
}

/* ---------- 訪問 ---------- */
export async function addVisit(station, pos = null) {
  const v = { id: uid("v"), stationId: station.id, at: new Date().toISOString(),
    how: pos ? "gps" : "tap", lat: pos?.lat ?? null, lng: pos?.lng ?? null, acc: pos ? Math.round(pos.acc) : null };
  await db.put("visits", v);
  S.visits.push(v);
  toast(`${station.name} を記録しました`);
  render();
}

export async function removeVisit(v) {
  await db.remove("visits", v.id);
  S.visits = S.visits.filter((x) => x.id !== v.id);
  render();
}

// 全国データの駅 m に対応する図鑑の台を返す。無ければ作る
export async function ensureStation(m, firstDate = today(), source = "master") {
  let s = S.stations.find((x) => x.gid === m.id);
  if (s) return s;
  const c = geo.center(m);
  s = { id: m.id, gid: m.id, name: m.name, lines: m.lines, area: "", firstDate, url: "", lat: c.lat, lng: c.lng, source };
  await db.put("stations", s);
  S.stations.push(s);
  return s;
}

// SA・PA・道の駅・銭湯の台（無ければ作る）
export async function ensureSpot(sp, firstDate = today(), source = "master") {
  let s = S.stations.find((x) => x.id === sp.id);
  if (s) return s;
  s = { id: sp.id, kind: sp.kind, name: sp.name, area: "", firstDate, url: "", lat: sp.lat, lng: sp.lng, source };
  await db.put("stations", s);
  S.stations.push(s);
  return s;
}

export async function removeStation(s) {
  await db.removeStation(s.id);
  S.stations = S.stations.filter((x) => x.id !== s.id);
  S.visits = S.visits.filter((v) => v.stationId !== s.id);
  toast(`${s.name} を削除しました`);
  render();
}

// 確認：行った → 図鑑へ。行ってない → 記録を消し、その施設を二度と出さない
export async function confirmVisit(v, went) {
  const s = S.stations.find((x) => x.id === v.stationId);
  if (went) {
    v.pending = false;
    await db.put("visits", v);
  } else {
    await db.remove("visits", v.id);
    if (s) { s.rejected = true; await db.put("stations", s); }
  }
  await load();
  toast(went ? `${s?.name || ""} を図鑑に入れました` : `${s?.name || ""} は外しました（次から出しません）`);
}

/* ---------- 移動手段の手直し ---------- */
// Googleの判定違い（船を車、乗り物を徒歩など）を本人が直す。meta "modeFix" に「日付|開始秒 → 手段」で覚え、
// タイムラインを読み直しても同じ直しを当てる。いまの手段と同じ値を入れたものは「確かめた（このままでよい）」の印
const fixKey = (date, a) => `${date}|${a.s}`;
export const fixOf = (date, a) => S.meta.modeFix[fixKey(date, a)];

export function applyModeFixes(days, fixes = S.meta.modeFix) {
  for (const d of days) for (const a of d.acts) { const m = fixes[fixKey(d.date, a)]; if (m) a.mode = m; }
}

export async function setMode(date, a, mode) {
  S.meta.modeFix = { ...S.meta.modeFix, [fixKey(date, a)]: mode };
  await db.setMeta("modeFix", S.meta.modeFix);
  const day = await db.get("days", date);
  if (day) {
    applyModeFixes([day]);
    await db.put("days", day);
    const i = S.allDays?.findIndex((d) => d.date === date);
    if (i >= 0) S.allDays[i] = day;
  }
  forgetCalc();
  render();
}

/* ---------- タイムラインの読み込み ---------- */
// 日ごとの道のりを保存し、電車で乗り降りした駅のうち「まだ記録の無い駅」に、実際に行った日で記録する。
// 通勤の駅が毎日増えないよう、タイムラインから入れるのは駅ごとに最初の1回だけ（行った日数は図鑑でタイムラインから数える）
export async function importTimeline(file) {
  toast("タイムラインを読んでいます…");
  let days;
  try { days = tl.parseTimeline(JSON.parse(await file.text())); }
  catch { toast("タイムラインの書き出しファイルではありません"); return; }
  if (!days.length) { toast("移動の記録がありませんでした"); return; }
  try { await needMaster(); } catch { toast("駅データを読み込めませんでした"); return; }
  try { tl.fixBoats(days, rd.seaTest(await rd.loadLand())); } catch {} // 海の上の「車」は船に
  applyModeFixes(days); // 本人が直した手段
  const { added, replaced } = await mergeDays(days);
  const newVisits = [];
  let newSure = 0, newUnsure = 0;
  for (const st of firstStops(tl.railStops(days, S.master, geo.STAMP_RADIUS))) {
    const known = S.stations.find((x) => x.gid === st.m.id);
    if (known?.rejected || (known && (visitsOf(known.id).length || S.pending.some((v) => v.stationId === known.id)))) continue;
    const at = new Date(st.t * 1000).toISOString();
    const s = known || (await ensureStation(st.m, at.slice(0, 10), "timeline"));
    const v = { id: `tl-${st.m.id}`, stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null };
    if (st.sure) { S.visits.push(v); newSure++; }
    else { Object.assign(v, { pending: true, dist: Math.round(st.dist), alt: st.alt }); S.pending.push(v); newUnsure++; }
    newVisits.push(["visits", v]);
  }
  const newSpots = await stampSpots(days, newVisits);
  await db.putMany(newVisits);
  await db.setMeta("lastTimeline", new Date().toISOString());
  await load();
  S.mapDate = S.dayKeys.at(-1);
  const same = days.length - added - replaced;
  toast(`新しい日 ${added}・詳しい記録に入れ替え ${replaced}・そのまま ${same}。初めての駅 ${newSure}。確認待ち：駅 ${newUnsure}・施設 ${newSpots}`);
}

// 同じ日がもうあれば、記録が詳しいほう（点と移動の数が多いほう）を残す。
// 足し合わせないのは、2台のスマホが同じ移動を記録していると距離が二重になるため
async function mergeDays(days) {
  const size = (d) => d.pts.length + d.acts.length * 5;
  const keep = [];
  let added = 0, replaced = 0;
  for (const d of days) {
    const old = S.dayKeys.includes(d.date) ? await db.get("days", d.date) : null;
    if (!old) { keep.push(["days", d]); added++; }
    else if (size(d) > size(old)) { keep.push(["days", d]); replaced++; }
  }
  await db.putMany(keep);
  return { added, replaced };
}

// SA・PA・道の駅・銭湯・温泉：立ち寄ったかもしれない所を「確認待ち」にする（最初の1回だけ）。書き込む visits を out に足し、件数を返す
// 滞在の近くにあるだけでは、隣の店や知り合いの家にいたのと見分けられない（実データで、行っていない銭湯が多数入った）ので、本人が決める
async function stampSpots(days, out) {
  let n = 0;
  try {
    const roads = await needRoads();
    const first = new Map();
    for (const hit of rd.spotStops(roads, days)) {
      const cur = first.get(hit.spot.id);
      if (!cur || hit.t < cur.t) first.set(hit.spot.id, hit);
    }
    for (const { spot, t, mins, dist } of [...first.values()].sort((a, b) => a.t - b.t)) {
      const known = S.stations.find((x) => x.id === spot.id);
      if (known?.rejected || visitsOf(spot.id).length || S.pending.some((v) => v.stationId === spot.id)) continue;
      const at = new Date(t * 1000).toISOString();
      const s = known || (await ensureSpot(spot, at.slice(0, 10), "timeline"));
      const v = { id: `tl-${spot.id}`, stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null,
        pending: true, stay: mins == null ? null : Math.round(mins), dist: Math.round(dist) };
      S.pending.push(v);
      out.push(["visits", v]);
      n++;
    }
  } catch {}
  return n;
}

// 駅ごとに、いちばん早い乗り降りの日時と「一度でも自信ありがあったか」をまとめる
function firstStops(stops) {
  const by = new Map();
  for (const { m, t, sure, alt } of stops) {
    const cur = by.get(m.id) || { m, t, sure: false, dist: m.dist, alt: null };
    if (t < cur.t) cur.t = t;
    if (sure) cur.sure = true;
    if (!sure) { cur.alt ||= alt; cur.dist = Math.min(cur.dist, m.dist); }
    by.set(m.id, cur);
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

// 位置の無い駅（手で足した駅など）を、名前が1つに決まれば全国データと結びつける。路線名は全国データに合わせる
export async function linkMaster() {
  const changed = [];
  for (const s of S.stations) {
    if (isSpot(s)) continue;
    if (s.gid) {
      const m = S.master.byId[s.gid];
      if (m && s.lines !== m.lines) { s.lines = m.lines; changed.push(["stations", s]); }
      continue;
    }
    const hits = S.master.filter((m) => m.name === s.name);
    if (hits.length !== 1) continue;
    const c = geo.center(hits[0]);
    Object.assign(s, { gid: hits[0].id, lines: hits[0].lines, lat: c.lat, lng: c.lng });
    changed.push(["stations", s]);
  }
  await db.putMany(changed);
}

/* ---------- 記録の更新手順（版の番号つき） ---------- */
// 記録の形や判定を変えたときに、スマホにある記録を1回だけ直す手順。meta "dataVersion" より大きい番号だけを順に行う。
// 3.0.0 より前は手順ごとに別々の印（old）を持っていたので、その印があれば済んだものとして飛ばす。
// 新しい手順は末尾に番号を足すだけ。early＝記録を読み込む前に行う／それ以外は駅・道路データを読んだあとに行う
const CHOKAN = ["station-musashikoyama", "station-monzennakacho", "station-kitasenju", "station-sangenjaya"];
const STEPS = [
  { n: 1, old: ["chokanDropped", 1], early: true, run: dropChokan },   // 2.4.0 朝刊からの4駅を外す
  { n: 2, old: ["boatFix", 1], run: fixBoatsAll },                    // 2.7.0 海の上の「車」を船に
  { n: 3, old: ["spotConfirm", 1], run: recheckSpots },               // 2.1.0 自動で入れた施設を確認待ちに
  { n: 4, old: ["spotScan", 2], run: backfillSpots },                 // 1.5/1.6 施設の種類を足した分をさかのぼる
  { n: 5, old: ["stationConfirm", 1], run: recheckStations },         // 2.2.0 自信の低い駅を確認待ちに
  { n: 6, run: recheckBoats },                                         // 3.0.0 陸地の形で船を見直す（宮古島のドライブが船になっていた）
];
export async function runSteps(early) {
  let ver = (await db.getMeta("dataVersion")) || 0;
  for (const st of STEPS) {
    if (st.n <= ver || !!st.early !== early) continue;
    const done = st.old ? (await db.getMeta(st.old[0])) >= st.old[1] : false;
    if (!done) await st.run();
    ver = st.n;
    await db.setMeta("dataVersion", ver);
  }
}

async function dropChokan() {
  const [all, sts] = await Promise.all([db.getAll("visits"), db.getAll("stations")]);
  const kept = [];
  for (const id of CHOKAN) {
    const mine = all.filter((v) => v.stationId === id);
    if (!mine.some((v) => v.how !== "chokan")) { await db.removeStation(id); continue; }
    for (const v of mine) if (v.how === "chokan") await db.remove("visits", v.id);
    kept.push(sts.find((s) => s.id === id)?.name);
  }
  if (kept.length) setTimeout(() => toast(`朝刊からの記録を外しました。${kept.join("・")}は自分の記録があるので残しています`), 500);
}

async function fixBoatsAll() {
  if (!S.dayKeys.length) return;
  await needDays();
  const changed = tl.fixBoats(S.allDays, rd.seaTest(await rd.loadLand()));
  await db.putMany(changed.map((d) => ["days", d]));
  if (changed.length) { forgetCalc(); toast(`海の上の移動 ${changed.length}日分を「船」に直しました`); }
}

async function recheckSpots() {
  const back = S.visits.filter((v) => v.how === "timeline" && isSpot(S.stations.find((s) => s.id === v.stationId)));
  for (const v of back) v.pending = true;
  await db.putMany(back.map((v) => ["visits", v]));
  if (back.length) await load();
}

async function backfillSpots() {
  if (!S.dayKeys.length) return;
  await needDays();
  const out = [];
  const n = await stampSpots(S.allDays, out);
  await db.putMany(out);
  if (n) { toast(`これまでの記録から、行ったかもしれない施設が ${n} か所見つかりました。「最近」で確かめてください`); render(); }
}

// 船か車かを、陸地の形で判定し直す（2.7.0 は陸の推し量りが粗く、宮古島のドライブを船にしていた）。本人が手で直したものは触らない
async function recheckBoats() {
  if (!S.dayKeys.length) return;
  await needDays();
  const isSea = rd.seaTest(await rd.loadLand());
  const changed = [];
  let toCar = 0, toBoat = 0;
  for (const d of S.allDays) {
    let hit = false;
    for (const a of d.acts) {
      if ((a.mode !== "boat" && a.mode !== "car") || fixOf(d.date, a)) continue;
      const boat = tl.isBoatLike(d, a, isSea);
      if (a.mode === "boat" && !boat) { a.mode = "car"; toCar++; hit = true; }
      else if (a.mode === "car" && boat) { a.mode = "boat"; toBoat++; hit = true; }
    }
    if (hit) changed.push(d);
  }
  await db.putMany(changed.map((d) => ["days", d]));
  if (changed.length) { forgetCalc(); toast(`船と車を見直しました（車に戻した ${toCar}・船にした ${toBoat}）`); }
}

async function recheckStations() {
  if (!S.dayKeys.length || !S.master) return;
  await needDays();
  const unsure = firstStops(tl.railStops(S.allDays, S.master, geo.STAMP_RADIUS)).filter((x) => !x.sure);
  const back = [];
  for (const st of unsure) {
    const s = S.stations.find((x) => x.gid === st.m.id);
    const v = s && S.visits.find((x) => x.stationId === s.id && x.how === "timeline");
    // 自分で記録した（GPS・タップ）記録がある駅は、行ったのが確かなので聞かない
    if (!v || S.visits.some((x) => x.stationId === s.id && x.how !== "timeline")) continue;
    Object.assign(v, { pending: true, dist: Math.round(st.dist), alt: st.alt });
    back.push(["visits", v]);
  }
  await db.putMany(back);
  if (back.length) { await load(); toast(`見分けにくい駅 ${back.length} か所を「行ったか確かめてください」に入れました`); }
}

/* ---------- バックアップ（JSONの書き出し・読み込み） ---------- */
// 3.0.0 から道のり（days）・移動手段の手直しも入れる（format 2）。家探し（meta "life"）は 3.1.0 で画面ごと外した（スマホの記録は消していない）。
// Googleのタイムラインは今はスマホの中にしか無いので、スマホを失くすと元の記録ごと消える。だから道のりも外に残す
export async function exportJson() {
  const days = await needDays().catch(() => []);
  const data = { app: "eki-stamp", format: 2, exportedAt: new Date().toISOString(),
    stations: S.stations, visits: [...S.visits, ...S.pending], days,
    meta: { modeFix: S.meta.modeFix } };
  const name = `ashiato-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  let shared = false;
  // スマホは共有シート（Googleドライブ・ファイルに保存など）、PCは普通のダウンロード
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); shared = true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  if (!shared) {
    const a = h("a", { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  S.meta.lastExport = data.exportedAt;
  await db.setMeta("lastExport", data.exportedAt);
  toast(`書き出しました（道のり ${days.length}日分を含む・${Math.round(file.size / 1024)}KB）`);
  render();
  return true;
}

export async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("JSONとして読めませんでした"); return; }
  if (data?.app !== "eki-stamp" || !Array.isArray(data.stations) || !Array.isArray(data.visits)) {
    toast("あしあと帳のバックアップではありません"); return;
  }
  const okS = data.stations.filter((s) => s && typeof s.id === "string" && typeof s.name === "string");
  const okV = data.visits.filter((v) => v && typeof v.id === "string" && typeof v.stationId === "string" && !isNaN(Date.parse(v.at)));
  const newS = okS.filter((s) => !S.stations.some((x) => x.id === s.id)).length;
  const newV = okV.filter((v) => !S.visits.some((x) => x.id === v.id) && !S.pending.some((x) => x.id === v.id)).length;
  // 足し合わせる（今ある記録は消さない）。同じIDは同じ記録なので上書きしても中身は同じ
  await db.putMany([...okS.map((s) => ["stations", s]), ...okV.map((v) => ["visits", v])]);
  // 道のり：同じ日は詳しいほうを残す。手直しは、今のスマホに無いものだけ足す
  const days = Array.isArray(data.days) ? data.days.filter((d) => d && /^\d{4}-\d\d-\d\d$/.test(d.date) && Array.isArray(d.acts) && Array.isArray(d.pts)) : [];
  const { added } = days.length ? await mergeDays(days) : { added: 0 };
  if (data.meta?.modeFix) await db.setMeta("modeFix", { ...data.meta.modeFix, ...S.meta.modeFix });
  await load();
  toast(`読み込みました（新しい場所 ${newS}・記録 ${newV}・道のり ${added}日）`);
}

export const lastWeekSunday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); // 直近の日曜 0:00
};
export const ymdOr = (iso, none) => (iso ? ymd(iso) : none);
