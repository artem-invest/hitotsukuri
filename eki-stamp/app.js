// あしあと帳（もとは駅スタンプ帳）：画面と操作
// データの流れ： IndexedDB（db.js）→ stations / visits の配列 → render() で画面を作り直す
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as tl from "./timeline.js";
import { drawDay, ROADCOLORS } from "./map.js";
import * as rd from "./roads.js";
import { $, h, md, ymd, localDay, today, meters, toast } from "./ui.js";
import { renderReview } from "./review.js";
import { renderLife } from "./life.js";
import { lineStyle } from "./linestyle.js";

const APP_VERSION = "2.5.0";
const INKS = ["#d0472f", "#3f6fc4", "#3a9a62", "#9a5bb3", "#c7772a"]; // スタンプのインク（明暗どちらの地でも読める中間の濃さ）

// 朝刊の駅スタンプ帳から引き継いだ駅（2.4.0 で本人の希望により外した）。記録が残っていれば起動時に1回だけ消す
const CHOKAN = ["station-musashikoyama", "station-monzennakacho", "station-kitasenju", "station-sangenjaya"];

/* ---------- 小道具 ---------- */
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function hash(s) { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n; }
const inkOf = (id) => INKS[hash(id) % INKS.length];
const tiltOf = (id) => (hash(id + "t") % 21) - 10; // -10〜+10度
const HOW = { tap: "タップ", gps: "GPS", chokan: "朝刊から", import: "読み込み", timeline: "タイムライン" };
const isSpot = (s) => !!rd.KINDS[s?.kind]; // SA・PA・道の駅・銭湯・温泉（駅以外のスタンプ）

/* ---------- 状態 ---------- */
let stations = [];
let visits = [];
let pending = [];             // 確認待ちの記録（タイムラインから見つけた施設。本人が「行った」と言うまで図鑑に入れない）
let meta = { lastExport: null, persisted: "?" };
let tab = "home";
let near = { state: "idle" }; // 近くの駅：idle / locating / done / error
let master = null;            // 全国の駅データ（geo.loadMaster）
let dayKeys = [];             // タイムラインの記録がある日（"YYYY-MM-DD" の昇順）
let mapDate = null;           // 地図で見ている日
let allDays = null;           // 月ごとの距離・乗った区間を出すときにだけ全日分を読む
let roads = null;              // SA・PA・道の駅と高速道路（rd.loadRoads）
let reviewYear = null;        // 年報で見ている年
let life = { places: [], candidates: [] }; // 家探し：場所の名前・大事さ・候補の駅（meta "life"）
let hwRoutes = null;          // 高速道路ごとの SA・PA の並び（rd.loadHwRoutes）
let hwPass = null;            // 高速で通った SA・PA → 日付（rd.hwPasses）。タイムラインから計算
let findIdx = null;           // さがす：駅・施設ごとに、タイムラインで乗り降り・立ち寄り・通った日
let linesMode = "train";      // 路線タブ：train（電車）／ hw（高速）
try { linesMode = localStorage.getItem("eki.linesMode") || "train"; } catch {}
let rides = null;             // 乗った区間 {byLine: Map(路線番号 → Set(駅ID)), count}。タイムラインから計算
try { tab = localStorage.getItem("eki.tab") || "home"; } catch {}
// 2.0.0 でタブを組み替えた（スタンプ→最近・図鑑、記録→年報と図鑑へ）
tab = { stamps: "home", log: "review" }[tab] || tab;

const visitsOf = (id) => visits.filter((v) => v.stationId === id).sort((a, b) => a.at.localeCompare(b.at));

async function load() {
  const [st, all] = await Promise.all([db.getAll("stations"), db.getAll("visits")]);
  stations = st;
  visits = all.filter((v) => !v.pending);
  pending = all.filter((v) => v.pending).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  meta.lastExport = await db.getMeta("lastExport");
  meta.lastTimeline = await db.getMeta("lastTimeline");
  meta.tlSkip = await db.getMeta("timelineSkip");
  life = (await db.getMeta("life")) || { places: [], candidates: [] };
  dayKeys = (await db.getAllKeys("days")).sort();
  allDays = null;
  rides = null;
  hwPass = null;
  findIdx = null;
  render();
}

// 位置の無い駅（朝刊から来た駅・手で足した駅）を、名前が1つに決まれば全国データと結びつける
async function linkMaster() {
  const changed = [];
  for (const s of stations) {
    if (isSpot(s)) continue;
    if (s.gid) {
      const m = master.byId[s.gid];
      if (m && s.lines !== m.lines) { s.lines = m.lines; changed.push(["stations", s]); }
      continue;
    }
    const hits = master.filter((m) => m.name === s.name);
    if (hits.length !== 1) continue;
    const c = geo.center(hits[0]);
    Object.assign(s, { gid: hits[0].id, lines: hits[0].lines, lat: c.lat, lng: c.lng });
    changed.push(["stations", s]);
  }
  await db.putMany(changed);
}

// 朝刊から来た記録を外す（1回だけ）。タイムラインなど別の記録がある駅は、駅そのものは残す
async function dropChokanOnce() {
  if ((await db.getMeta("chokanDropped")) === 1) return;
  const [all, sts] = await Promise.all([db.getAll("visits"), db.getAll("stations")]);
  const kept = [];
  for (const id of CHOKAN) {
    const mine = all.filter((v) => v.stationId === id);
    if (!mine.some((v) => v.how !== "chokan")) { await db.removeStation(id); continue; }
    for (const v of mine) if (v.how === "chokan") await db.remove("visits", v.id);
    kept.push(sts.find((s) => s.id === id)?.name);
  }
  await db.setMeta("chokanDropped", 1);
  if (kept.length) setTimeout(() => toast(`朝刊からの記録を外しました。${kept.join("・")}は自分の記録があるので残しています`), 500);
  try { localStorage.removeItem("eki.bootlog"); sessionStorage.removeItem("eki.bootlog.cur"); } catch {} // 不具合調査（2.3.x）の名残
}

// 「このサイトのデータは消さないで」とブラウザに頼む。断られても動作はする
async function askPersist() {
  if (!navigator.storage?.persist) return "unsupported";
  if (await navigator.storage.persisted()) return "yes";
  return (await navigator.storage.persist()) ? "yes" : "no";
}

/* ---------- 操作 ---------- */
async function addVisit(station, pos = null) {
  const v = { id: uid("v"), stationId: station.id, at: new Date().toISOString(),
    how: pos ? "gps" : "tap", lat: pos?.lat ?? null, lng: pos?.lng ?? null, acc: pos ? Math.round(pos.acc) : null };
  await db.put("visits", v);
  visits.push(v);
  toast(`${station.name} を記録しました`);
  render();
}

async function removeVisit(v) {
  await db.remove("visits", v.id);
  visits = visits.filter((x) => x.id !== v.id);
  render();
}

// 全国データの駅 m に対応する手持ちの駅を返す。無ければ作る
async function ensureStation(m, firstDate = today(), source = "master") {
  let s = stations.find((x) => x.gid === m.id);
  if (s) return s;
  const c = geo.center(m);
  s = { id: m.id, gid: m.id, name: m.name, lines: m.lines, area: "", firstDate, url: "", lat: c.lat, lng: c.lng, source };
  await db.put("stations", s);
  stations.push(s);
  return s;
}

// SA・PA・道の駅のスタンプ台（無ければ作る）
async function ensureSpot(sp, firstDate = today(), source = "master") {
  let s = stations.find((x) => x.id === sp.id);
  if (s) return s;
  s = { id: sp.id, kind: sp.kind, name: sp.name, area: "", firstDate, url: "", lat: sp.lat, lng: sp.lng, source };
  await db.put("stations", s);
  stations.push(s);
  return s;
}

// 押し忘れた駅を、今日の日付・タップ扱いで記録する
async function recordForgot(m) {
  const s = await ensureStation(m);
  await addVisit(s);
}

/* ---------- 近くの駅（GPS） ---------- */
const stampedToday = (s) => !!s && visitsOf(s.id).some((v) => new Date(v.at).toDateString() === new Date().toDateString());

async function findNear() {
  near = { state: "locating" };
  render();
  try {
    const [m, pos] = await Promise.all([geo.loadMaster(), geo.locate()]);
    master = m;
    try { roads ||= await rd.loadRoads(); } catch {}
    const spot = roads ? (rd.nearestSpot(roads, pos.lat, pos.lng)
      || rd.nearestSpot(roads, pos.lat, pos.lng, 1500, (s) => rd.KINDS[s.kind].group === "road")) : null;
    near = { state: "done", pos, list: geo.nearest(m, pos.lat, pos.lng, 3), spot };
  } catch (e) {
    const msg = e?.code === 1 ? "位置情報が許可されていません。スマホの設定で、このアプリ（Chrome）の位置情報を許可してください。"
      : e?.code === 3 ? "位置が取れませんでした（時間切れ）。空が見える場所でもう一度どうぞ。"
      : e?.code === 2 ? "位置が取れませんでした。位置情報がオンか確かめてください。"
      : "駅データを読み込めませんでした。一度電波のある所で開いてください。";
    near = { state: "error", msg };
  }
  render();
}

async function stampHere(m) {
  const s = rd.KINDS[m.kind] ? await ensureSpot(m) : await ensureStation(m);
  await addVisit(s, near.pos);
}

async function removeStation(s) {
  await db.removeStation(s.id);
  stations = stations.filter((x) => x.id !== s.id);
  visits = visits.filter((v) => v.stationId !== s.id);
  toast(`${s.name} を削除しました`);
  render();
}

/* ---------- タイムラインの読み込み ---------- */
// 日ごとの道のりを保存し、電車で乗り降りした駅のうち「まだ記録の無い駅」に、実際に行った日でスタンプを押す。
// 通勤の駅に毎日スタンプが増えないよう、タイムラインから押すのは駅ごとに最初の1回だけ。
async function importTimeline(file) {
  toast("タイムラインを読んでいます…");
  let days;
  try { days = tl.parseTimeline(JSON.parse(await file.text())); }
  catch { toast("タイムラインの書き出しファイルではありません"); return; }
  if (!days.length) { toast("移動の記録がありませんでした"); return; }
  try { master ||= await geo.loadMaster(); } catch { toast("駅データを読み込めませんでした"); return; }
  // 同じ日がもうあれば、記録が詳しいほう（点と移動の数が多いほう）を残す。
  // 足し合わせないのは、2台のスマホが同じ移動を記録していると距離が二重になるため
  const size = (d) => d.pts.length + d.acts.length * 5;
  const keep = [];
  let added = 0, replaced = 0;
  for (const d of days) {
    const old = dayKeys.includes(d.date) ? await db.get("days", d.date) : null;
    if (!old) { keep.push(["days", d]); added++; }
    else if (size(d) > size(old)) { keep.push(["days", d]); replaced++; }
  }
  await db.putMany(keep);
  const newVisits = [];
  let newSure = 0, newUnsure = 0;
  for (const st of firstStops(tl.railStops(days, master, geo.STAMP_RADIUS))) {
    const known = stations.find((x) => x.gid === st.m.id);
    if (known?.rejected || (known && (visitsOf(known.id).length || pending.some((v) => v.stationId === known.id)))) continue;
    const at = new Date(st.t * 1000).toISOString();
    const s = known || (await ensureStation(st.m, at.slice(0, 10), "timeline"));
    const v = { id: `tl-${st.m.id}`, stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null };
    if (st.sure) { visits.push(v); newSure++; }
    else { Object.assign(v, { pending: true, dist: Math.round(st.dist), alt: st.alt }); pending.push(v); newUnsure++; }
    newVisits.push(["visits", v]);
  }
  const newSpots = await stampSpots(days, newVisits);
  await db.putMany(newVisits);
  await db.setMeta("lastTimeline", new Date().toISOString());
  await db.setMeta("spotScan", 2);
  await load();
  mapDate = dayKeys.at(-1);
  const same = days.length - added - replaced;
  toast(`新しい日 ${added}・詳しい記録に入れ替え ${replaced}・そのまま ${same}。初めての駅 ${newSure}。確認待ち：駅 ${newUnsure}・施設 ${newSpots}`);
}

// SA・PA・道の駅・銭湯・温泉：立ち寄ったかもしれない所を「確認待ち」にする（最初の1回だけ）。書き込む visits を out に足し、件数を返す
// 2.1.0 から：滞在の近くにあるだけでは、隣の店や知り合いの家にいたのと見分けられない（実データで、行っていない銭湯が多数入った）。
// そこで本人が「行った／行ってない」を決める。「行ってない」にした施設は rejected として覚え、二度と出さない
async function stampSpots(days, out) {
  let n = 0;
  try {
    roads ||= await rd.loadRoads();
    const first = new Map();
    for (const hit of rd.spotStops(roads, days)) {
      const cur = first.get(hit.spot.id);
      if (!cur || hit.t < cur.t) first.set(hit.spot.id, hit);
    }
    for (const { spot, t, mins, dist } of [...first.values()].sort((a, b) => a.t - b.t)) {
      const known = stations.find((x) => x.id === spot.id);
      if (known?.rejected || visitsOf(spot.id).length || pending.some((v) => v.stationId === spot.id)) continue;
      const at = new Date(t * 1000).toISOString();
      const s = known || (await ensureSpot(spot, at.slice(0, 10), "timeline"));
      const v = { id: `tl-${spot.id}`, stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null,
        pending: true, stay: mins == null ? null : Math.round(mins), dist: Math.round(dist) };
      pending.push(v);
      out.push(["visits", v]);
      n++;
    }
  } catch {}
  return n;
}

// SA・PAのスタンプができる前に読み込んだ記録にも、1回だけさかのぼって押す（1.5.0 で追加）
async function backfillSpots() {
  // 1.5.0 で SA・PA・道の駅、1.6.0 で銭湯・温泉を足した。足すたびに数字を上げ、1回だけ全記録を見直す
  if (!dayKeys.length || (await db.getMeta("spotScan")) >= 2) return;
  allDays ||= await db.getAll("days");
  const out = [];
  const n = await stampSpots(allDays, out);
  await db.putMany(out);
  await db.setMeta("spotScan", 2);
  if (n) { toast(`これまでの記録から、行ったかもしれない施設が ${n} か所見つかりました。「最近」で確かめてください`); render(); }
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

// 2.1.0 までにタイムラインから自動で入れた駅のうち、自信の低いものを1回だけ確認待ちに戻す
async function recheckStationsOnce() {
  if (!dayKeys.length || !master || (await db.getMeta("stationConfirm")) === 1) return;
  allDays ||= await db.getAll("days");
  const unsure = firstStops(tl.railStops(allDays, master, geo.STAMP_RADIUS)).filter((x) => !x.sure);
  const back = [];
  for (const st of unsure) {
    const s = stations.find((x) => x.gid === st.m.id);
    const v = s && visits.find((x) => x.stationId === s.id && x.how === "timeline");
    // 自分で記録した（GPS・タップ・朝刊から）記録がある駅は、行ったのが確かなので聞かない
    if (!v || visits.some((x) => x.stationId === s.id && x.how !== "timeline")) continue;
    Object.assign(v, { pending: true, dist: Math.round(st.dist), alt: st.alt });
    back.push(["visits", v]);
  }
  await db.putMany(back);
  await db.setMeta("stationConfirm", 1);
  if (back.length) { await load(); toast(`見分けにくい駅 ${back.length} か所を「行ったか確かめてください」に入れました`); }
}

// 2.0.0 までにタイムラインから自動で入れた施設を、1回だけ確認待ちに戻す
async function recheckSpotsOnce() {
  if ((await db.getMeta("spotConfirm")) === 1) return;
  const back = visits.filter((v) => v.how === "timeline" && isSpot(stations.find((s) => s.id === v.stationId)));
  for (const v of back) v.pending = true;
  await db.putMany(back.map((v) => ["visits", v]));
  await db.setMeta("spotConfirm", 1);
  if (back.length) await load();
}

// 確認：行った → 図鑑へ。行ってない → 記録を消し、その施設を二度と出さない
async function confirmSpot(v, went) {
  const s = stations.find((x) => x.id === v.stationId);
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

function renderConfirm() {
  if (!pending.length) return null;
  return h("section", { class: "card confirm" },
    h("h2", { text: `行ったか確かめてください（${pending.length}件）` }),
    h("p", { class: "muted", text: "タイムラインから見つけたけれど、確かではない場所です（施設の近くに長めにいた・紛らわしい駅が近くにある）。日付をタップするとその日のルートが見られます。行った所だけ「行った」を押してください。" }),
    h("ol", { class: "nearlist" }, pending.map((v) => {
      const s = stations.find((x) => x.id === v.stationId);
      if (!s) return null;
      const day = localDay(v.at);
      const why = isSpot(s)
        ? [v.stay != null ? `${v.stay}分いた` : "", v.dist != null ? `${v.dist}m` : ""]
        : [v.dist != null ? `乗り降りした地点から${v.dist}m` : "", v.alt ? `近くに${v.alt}駅` : ""];
      return h("li", {},
        h("div", {}, h("b", { text: s.name }), h("small", {},
          `${rd.KINDS[s.kind]?.label || "駅"}・`,
          dayKeys.includes(day) ? h("button", { type: "button", class: "linkish", text: ymd(v.at), onclick: () => openDay(day, s) }) : ymd(v.at),
          [""].concat(why.filter(Boolean)).join("・"))),
        h("div", { class: "yn" },
          h("button", { type: "button", class: "primary", text: "行った", onclick: () => confirmSpot(v, true) }),
          h("button", { type: "button", text: "行ってない", onclick: () => confirmSpot(v, false) })));
    })));
}

function timelinePicker(label, primary = false) {
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: () => { if (file.files[0]) importTimeline(file.files[0]); file.value = ""; } });
  return [h("button", { type: "button", class: primary ? "primary" : "", onclick: () => file.click(), text: label }), file];
}

/* ---------- バックアップ（JSONの書き出し・読み込み） ---------- */
async function exportJson() {
  const data = { app: "eki-stamp", format: 1, exportedAt: new Date().toISOString(), stations, visits: [...visits, ...pending] };
  const name = `eki-stamp-${today()}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: "application/json" });
  let shared = false;
  // スマホは共有シート（ファイルに保存・LINEで自分に送る等）、PCは普通のダウンロード
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); shared = true; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (!shared) {
    const a = h("a", { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  meta.lastExport = data.exportedAt;
  await db.setMeta("lastExport", data.exportedAt);
  toast("書き出しました");
  render();
}

async function importJson(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("JSONとして読めませんでした"); return; }
  if (data?.app !== "eki-stamp" || !Array.isArray(data.stations) || !Array.isArray(data.visits)) {
    toast("あしあと帳のバックアップではありません"); return;
  }
  const okS = data.stations.filter((s) => s && typeof s.id === "string" && typeof s.name === "string");
  const okV = data.visits.filter((v) => v && typeof v.id === "string" && typeof v.stationId === "string" && !isNaN(Date.parse(v.at)));
  const newS = okS.filter((s) => !stations.some((x) => x.id === s.id)).length;
  const newV = okV.filter((v) => !visits.some((x) => x.id === v.id)).length;
  // 足し合わせる（今ある記録は消さない）。同じIDは同じ記録なので上書きしても中身は同じ
  await db.putMany([...okS.map((s) => ["stations", s]), ...okV.map((v) => ["visits", v])]);
  await load();
  toast(`読み込みました（新しい場所 ${newS}・記録 ${newV}）`);
}

/* ---------- 画面 ---------- */
function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const went = stations.filter((s) => visitsOf(s.id).length);
  const spots = went.filter(isSpot).length;
  $("#summary").textContent = `${went.length - spots}駅${spots ? `・${spots}か所` : ""}`;
  const main = $("#main");
  main.replaceChildren();
  if (tab === "home") renderHome(main);
  else if (tab === "zukan") renderZukan(main);
  else if (tab === "lines") renderLines(main);
  else if (tab === "map") renderMap(main);
  else if (tab === "review" || tab === "life") renderSummary(main);
  else renderBackup(main);
}

// 週に1回（日曜日）タイムラインの読み込みを促す。日曜に読めなかったら、次の土曜まで出したまま
function timelineNudge() {
  if (!dayKeys.length) return null;
  const now = new Date();
  const sun = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); // 直近の日曜 0:00
  const sunKey = localDay(sun.toISOString());
  if ((meta.lastTimeline && Date.parse(meta.lastTimeline) >= sun.getTime()) || meta.tlSkip === sunKey) return null;
  return h("section", { class: "card weekly" },
    h("h2", { text: now.getDay() === 0 ? "日曜日：今週のタイムラインを読み込む日です" : "今週のタイムラインがまだです" }),
    h("p", { class: "muted", text: `スマホの「設定」→「位置情報」→「位置情報サービス」→「タイムライン」→「タイムライン データをエクスポート」で保存して、下のボタンで選んでください。${meta.lastTimeline ? `前回は${md(meta.lastTimeline)}。` : ""}` }),
    h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む", true),
      h("button", { type: "button", class: "small", text: "今週はしない", onclick: async () => { meta.tlSkip = sunKey; await db.setMeta("timelineSkip", sunKey); render(); } })));
}

function backupNudge() {
  const days = meta.lastExport ? (Date.now() - Date.parse(meta.lastExport)) / 86400000 : Infinity;
  if (days < 30 || !visits.length) return null;
  return h("button", { class: "nudge", type: "button", onclick: () => { tab = "backup"; render(); } },
    meta.lastExport ? `最後のバックアップから${Math.floor(days)}日たちました。書き出しておきましょう →` : "まだバックアップがありません。一度書き出しておきましょう →");
}

function stampButton(s) {
  const vs = visitsOf(s.id);
  const on = vs.length > 0;
  return h("button", {
    type: "button",
    class: "stamp" + (on ? " on" : "") + (isSpot(s) ? " spot" : ""),
    style: on ? `--ink:${inkOf(s.id)};--tilt:${tiltOf(s.id)}deg` : "",
    "aria-label": `${s.name}${on ? `（${vs.length}回）` : "（まだ）"}`,
    onclick: () => openSheet(s),
  },
    h("span", { class: "nm", text: s.name }),
    isSpot(s) ? h("small", { text: rd.KINDS[s.kind].label }) : (s.area || s.lines) ? h("small", { text: s.area || s.lines.split("・")[0] }) : null,
    on ? h("small", { class: "dt", text: md(vs[0].at) }) : null,
    vs.length > 1 ? h("span", { class: "times", text: `×${vs.length}` }) : null,
  );
}

function renderNear() {
  const box = h("section", { class: "near" });
  box.append(h("button", { type: "button", class: "primary big", onclick: findNear,
    disabled: near.state === "locating",
    text: near.state === "locating" ? "現在地を確かめています…" : near.state === "done" ? "もう一度探す" : "今いる駅・SA・銭湯を記録する（GPS）" }));
  if (near.state === "error") box.append(h("p", { class: "warn", text: near.msg }));
  if (near.state === "done") {
    const { pos, spot } = near;
    // SA・PA・道の駅が近くにあれば、駅より先に出す
    const list = spot ? [spot, ...near.list] : near.list;
    if (pos.acc > geo.STAMP_RADIUS) box.append(h("p", { class: "warn", text: `位置の誤差が大きめです（±${meters(pos.acc)}）。少し待ってもう一度探すと正確になります。` }));
    if (!list.length) box.append(h("p", { class: "muted", text: "5km以内に駅がありません。" }));
    box.append(h("ol", { class: "nearlist" }, list.map((m) => {
      const ok = m.dist <= (rd.KINDS[m.kind] ? Math.max(rd.KINDS[m.kind].radius, 100) : geo.STAMP_RADIUS);
      const done = stampedToday(stations.find((x) => x.gid === m.id || x.id === m.id));
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

/* ---------- 路線の塗り絵 ---------- */
// 押した駅（全国データと結びついたもの）の集合
const visitedGids = () => new Set(stations.filter((s) => s.gid && visitsOf(s.id).length).map((s) => s.gid));

// 乗った区間をタイムラインから計算する（全日分を読むので、必要になったときに1回だけ）
// 駅データがまだなら自分で読む。以前は何もせずに戻っていたため、路線タブのまま起動すると
// 「計算しています」→ loadRides がすぐ戻る → 描き直す → … が待ち時間なしで永久に回り、
// 駅データの読み込みに順番が回らず画面ごと止まった（2026-10-14 本人のスマホ。2.3.3 で修正）
async function loadRides() {
  if (rides || !dayKeys.length) return;
  master ||= await geo.loadMaster();
  allDays ||= await db.getAll("days");
  const byLine = new Map();
  const list = tl.railRides(allDays, master, geo.STAMP_RADIUS);
  for (const r of list) {
    const set = byLine.get(r.li) || new Set();
    for (const id of r.ids) set.add(id);
    byLine.set(r.li, set);
  }
  rides = { byLine, count: list.length, list };
}

// 降りた駅か通った区間が1つでもある路線と、その埋まり具合
// done＝降りた駅、via＝通っただけの駅（降りた駅は含まない）
function myLines() {
  if (!master) return [];
  const got = visitedGids();
  const touched = new Set(rides ? rides.byLine.keys() : []);
  for (const g of got) for (const i of master.byId[g]?.li || []) touched.add(i);
  return [...touched].map((i) => {
    const l = master.lines[i];
    const rode = rides?.byLine.get(i) || new Set();
    const done = l.ids.filter((id) => got.has(id)).length;
    const via = l.ids.filter((id) => !got.has(id) && rode.has(id)).length;
    return { ...l, rode, done, via, total: l.ids.length, left: l.ids.length - done };
  }).sort((a, b) => (b.done + b.via) / b.total - (a.done + a.via) / a.total || b.done - a.done);
}

// 次の一駅：自分の路線のまだの駅を、今いる所（無ければ最後に押した駅）から近い順に
function nextStations(n = 3) {
  const lines = myLines();
  if (!lines.length) return { from: null, list: [] };
  let from = near.state === "done" ? { lat: near.pos.lat, lng: near.pos.lng, label: "今いる所" } : null;
  if (!from) {
    const last = [...visits].sort((a, b) => b.at.localeCompare(a.at)).map((v) => stations.find((s) => s.id === v.stationId)).find((s) => s?.lat != null);
    if (last) from = { lat: last.lat, lng: last.lng, label: `最後に押した${last.name}` };
  }
  if (!from) return { from: null, list: [] };
  const got = visitedGids();
  const seen = new Map();
  for (const l of lines) {
    for (const id of l.ids) {
      if (got.has(id)) continue;
      const m = master.byId[id];
      const d = Math.min(...m.pts.map((p) => geo.distance(from.lat, from.lng, p[1], p[0])));
      const cur = seen.get(id);
      // 同じ駅が複数の路線にあるときは、残りの少ない（制覇に近い）路線で紹介する
      if (!cur || l.left < cur.line.left) seen.set(id, { m, d, line: l, via: l.rode.has(id) || cur?.via });
    }
  }
  return { from, list: [...seen.values()].sort((a, b) => a.d - b.d).slice(0, n) };
}

function renderNext() {
  const { from, list } = nextStations();
  if (!list.length) return null;
  return h("section", { class: "next" },
    h("h2", { text: "次の一駅" }),
    h("p", { class: "muted", text: `${from.label}から近い、あなたの路線のまだ降りていない駅` }),
    h("ol", { class: "nearlist" }, list.map(({ m, d, line, via }) => h("li", {},
      h("div", {}, h("b", { text: m.name }), h("small", { text: `${line.name} あと${line.left}駅で制覇・${meters(d)}${via ? "・通ったことはある" : ""}` })),
      h("a", { class: "maplink", href: `https://www.google.com/maps/search/?api=1&query=${geo.center(m).lat},${geo.center(m).lng}`, target: "_blank", rel: "noopener", text: "地図" })))));
}

/* ---------- 高速道路（路線と同じ塗り絵。SA・PA が駅のかわり） ---------- */
async function loadHw() {
  await ensureAll();
  hwRoutes ||= await rd.loadHwRoutes();
  if (!roads) throw new Error("道路データを読み込めませんでした");
  hwPass ||= rd.hwPasses(roads, hwRoutes, allDays || []);
}

const placeWent = (p) => p.ids.some((id) => visitsOf(id).length);

function renderHighways(main) {
  if (!hwRoutes || !hwPass) {
    const msg = h("p", { class: "empty", text: "走った高速を計算しています…" });
    main.append(msg);
    // 計算できたときだけ描き直す（できないまま描き直すと回り続ける：2.3.3 で直した不具合と同じ形）
    loadHw().then(() => { if (tab === "lines" && linesMode === "hw" && hwPass) render(); },
      () => { msg.textContent = "道路データを読み込めませんでした。電波のある所で開き直してください。"; });
    return;
  }
  const list = hwRoutes.map((r) => {
    const days = new Set();
    for (const p of r.places) for (const d of hwPass.get(p.ids[0]) || []) days.add(d);
    const on = r.places.filter(placeWent).length;
    const via = r.places.filter((p) => !placeWent(p) && hwPass.has(p.ids[0])).length;
    return { ...r, on, via, days, total: r.places.length };
  }).filter((r) => r.on || r.via)
    .sort((a, b) => b.on - a.on || b.days.size - a.days.size); // 立ち寄った数 → よく走った順
  if (!list.length) {
    main.append(h("p", { class: "empty", text: "タイムラインで車で高速を走った日や、立ち寄った SA・PA があると、その高速がここに並びます。" }));
    return;
  }
  main.append(h("p", { class: "linesum" }, h("b", { text: `${list.length}本` }), ` の高速にあしあと・SA・PA に立ち寄り ${list.reduce((n, r) => n + r.on, 0)}`));
  main.append(h("p", { class: "legend" },
    h("span", { class: "on" }, h("i"), "立ち寄った"), h("span", { class: "via" }, h("i"), "通った"), h("span", {}, h("i"), "まだ")));
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
      h("ol", { class: "route" }, r.places.map((p) => h("li", { class: placeWent(p) ? "on" : hwPass.has(p.ids[0]) ? "via" : "", onclick: () => openFind(spotItem(roads.byId[p.ids[0]])) },
        h("i"), h("span", { text: p.name }))))));
  }
  main.append(h("p", { class: "hint", text: "高速をタップすると、東京に近い側から SA・PA が並びます。名前をタップすると、行った日・通った日とその日のルートが見られます。「通った」はタイムラインの車の道のりからの推定です（点がまばらなので、そばを走っただけでも入ることがあります）。上り・下りは1か所にまとめています。" }));
}

/* ---------- さがす：駅や施設に行ったことがあるかを、タイムラインまでさかのぼって調べる ---------- */
const placeOf = (id) => hwRoutes?.flatMap((r) => r.places).find((p) => p.ids.includes(id)) || null;

function stationItem(m) {
  const c = geo.center(m);
  return { kind: "station", key: m.id, gid: m.id, m, name: m.name, label: "駅", lines: m.lines, lat: c.lat, lng: c.lng };
}
function spotItem(sp) {
  const p = placeOf(sp.id);
  return { kind: "spot", key: p ? p.ids[0] : sp.id, ids: p ? p.ids : [sp.id], sp, name: p ? p.name : sp.name, label: rd.KINDS[sp.kind].label, lat: sp.lat, lng: sp.lng };
}
// その場所の図鑑の台（駅・施設。SA・PA は上り・下りで複数）
const zukanOf = (it) => (it.kind === "station" ? stations.filter((x) => x.gid === it.gid) : stations.filter((x) => it.ids.includes(x.id)));
const itemVisits = (it) => zukanOf(it).flatMap((s) => visitsOf(s.id));

function findCandidates(q) {
  q = q.trim().replace(/駅$/, "");
  if (!q) return [];
  const out = geo.search(master, q, 6).map(stationItem);
  const seen = new Set();
  for (const sp of roads.spots) {
    if (!sp.name.includes(q)) continue;
    const it = spotItem(sp);
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    out.push(it);
    if (seen.size >= 8) break;
  }
  return out;
}

// 駅・施設ごとに、タイムラインで見つかった日と、その日に何をしたか
async function loadFind() {
  await ensureAll();
  hwRoutes ||= await rd.loadHwRoutes();
  if (!master || !roads) throw new Error("駅・道路のデータを読み込めませんでした");
  await loadRides();
  hwPass ||= rd.hwPasses(roads, hwRoutes, allDays || []);
  if (findIdx) return;
  const days = allDays || [];
  const idx = new Map(); // key → Map(日付 → Set(何をしたか))
  const put = (k, date, what) => {
    if (!idx.has(k)) idx.set(k, new Map());
    const m = idx.get(k);
    if (!m.has(date)) m.set(date, new Set());
    m.get(date).add(what);
  };
  const dayOf = (t) => localDay(new Date(t * 1000).toISOString());
  for (const { m, t } of tl.railStops(days, master, geo.STAMP_RADIUS)) put(m.id, dayOf(t), "乗り降り");
  for (const r of rides?.list || []) for (const id of r.ids.slice(1, -1)) put(id, r.date, "電車で通過");
  for (const { spot, t } of rd.spotStops(roads, days)) put(placeOf(spot.id)?.ids[0] || spot.id, dayOf(t), "近くに立ち寄り");
  for (const [k, dates] of hwPass) for (const d of dates) put(k, d, "高速で通過");
  findIdx = idx;
}

function renderFind(main) {
  const res = h("ul", { class: "sugg" });
  const q = h("input", { type: "search", placeholder: "駅・SA・PA・道の駅・銭湯の名前", autocomplete: "off", enterkeyhint: "search",
    oninput: async () => {
      const v = q.value;
      try { master ||= await geo.loadMaster(); roads ||= await rd.loadRoads(); hwRoutes ||= await rd.loadHwRoutes(); } catch { return; }
      if (q.value !== v) return;
      res.replaceChildren(...findCandidates(v).map((it) => h("li", {},
        h("button", { type: "button", onclick: () => openFind(it) },
          h("b", { text: it.name }),
          h("small", { text: [it.name.includes(it.label) ? "" : it.label, it.lines, itemVisits(it).length ? "図鑑にあり" : ""].filter(Boolean).join("・") })))));
    } });
  main.append(h("section", { class: "card find" },
    h("h2", { text: "行ったことある？" }),
    q, res,
    h("p", { class: "muted", text: "名前で探すと、タイムラインの記録までさかのぼって、乗り降りした日・立ち寄った日・通った日を出します。日付をタップするとその日のルート。" })));
}

// さがした場所の1枚：図鑑の記録と、タイムラインで見つかった日の一覧
async function openFind(it) {
  const dlg = $("#sheet");
  const body = h("div", {}, h("p", { class: "muted", text: "記録を調べています…" }));
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("header", {},
      h("h2", { text: it.name }),
      h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
    h("p", { class: "muted", text: [it.label, it.lines].filter(Boolean).join("・") }),
    body));
  if (!dlg.open) dlg.showModal();
  try { await loadFind(); } catch (e) { body.replaceChildren(h("p", { class: "muted", text: String(e?.message || e) })); return; }
  const back = () => openFind(it);
  const here = { lat: it.lat, lng: it.lng, name: it.name, kind: it.sp?.kind };
  const vs = itemVisits(it).sort((a, b) => a.at.localeCompare(b.at));
  const mine = zukanOf(it);
  const rows = [...(findIdx.get(it.key) || new Map())].sort((a, b) => b[0].localeCompare(a[0]));
  const dayBtn = (d) => (dayKeys.includes(d)
    ? h("button", { type: "button", class: "linkish", text: ymd(d + "T12:00"), onclick: () => openDay(d, here, back) })
    : h("span", { text: ymd(d + "T12:00") }));
  body.replaceChildren(
    vs.length
      ? h("div", { class: "vrow" },
          h("span", {}, h("b", { text: `図鑑にあり・${vs.filter((v) => !v.pending).length}回` }), vs.some((v) => v.pending) ? "（確認待ちあり）" : ""),
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
      : h("p", { class: "muted", text: dayKeys.length ? `タイムラインの記録（${ymd(dayKeys[0] + "T12:00")}〜）には見つかりませんでした。` : "タイムラインを読み込むと、さかのぼって探せます。" }),
    h("p", { class: "links" }, h("a", { href: `https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lng}`, target: "_blank", rel: "noopener", text: "地図で見る" })));
}

// さがした場所を、見つかった日に行ったこととして図鑑に入れる
async function addFound(it, date) {
  const at = new Date(date + "T12:00").toISOString();
  const s = it.kind === "station" ? await ensureStation(it.m, date, "timeline") : await ensureSpot(it.sp, date, "timeline");
  if (s.rejected) { s.rejected = false; await db.put("stations", s); }
  await db.put("visits", { id: uid("v"), stationId: s.id, at, how: "timeline", lat: null, lng: null, acc: null });
  await load();
  toast(`${it.name} を図鑑に入れました（${ymd(at)}）`);
  openFind(it);
}

function renderLines(main) {
  const mode = (m, label) => h("button", { type: "button", "aria-pressed": String(linesMode === m), text: label,
    onclick: () => { linesMode = m; try { localStorage.setItem("eki.linesMode", m); } catch {} render(); } });
  main.append(h("div", { class: "seg" }, mode("train", "電車"), mode("hw", "高速道路")));
  if (linesMode === "hw") { renderHighways(main); return; }
  if (dayKeys.length && !rides) {
    main.append(h("p", { class: "empty", text: "乗った区間を計算しています…" }));
    // 計算できたときだけ描き直す（できないまま描き直すと、また loadRides を呼んで回り続ける）
    loadRides().then(() => { if (tab === "lines" && rides) render(); },
      () => { if (tab === "lines") $("#main").replaceChildren(h("p", { class: "empty", text: "駅データを読み込めませんでした。電波のある所で開き直してください。" })); });
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
  main.append(h("p", { class: "legend" },
    h("span", { class: "on" }, h("i"), "降りた"), h("span", { class: "via" }, h("i"), "通った"), h("span", {}, h("i"), "まだ")));
  for (const l of lines) {
    const st = lineStyle(l.name);
    const pct = (n) => Math.round((n / l.total) * 1000) / 10;
    const d = h("details", { class: "line" + (l.left === 0 ? " full" : ""), style: `--lc:${st.color}` },
      h("summary", {},
        h("span", { class: "lbadge", text: st.sym }),
        h("span", { class: "ln", text: l.name }),
        h("span", { class: "cnt", text: l.left === 0 ? "制覇！" : `${l.done}/${l.total}` }),
        h("span", { class: "bar" }, h("i", { style: `width:${pct(l.done)}%` }), h("i", { class: "via", style: `width:${pct(l.via)}%` })),
        l.via ? h("small", { class: "sub", text: `通った駅を入れると ${l.done + l.via}/${l.total}${l.done + l.via === l.total ? "（乗りつぶし）" : ""}` }) : null),
      h("ol", { class: "route" }, l.ids.map((id) => h("li", { class: got.has(id) ? "on" : l.rode.has(id) ? "via" : "" },
        h("i"), h("span", { text: master.byId[id].name })))));
    main.append(d);
  }
  main.append(h("p", { class: "hint", text: "路線をタップすると、端から順に駅が路線図のように並びます。「通った」はタイムラインの電車の乗り降りから計算した区間です（乗り換えを含む移動は使っていません）。支線のある路線は順番が少し前後します。記号と色は各社の路線カラーに近いものです（首都圏の主な路線だけ）。" }));
}

/* ---------- 最近のあしあと（最初の画面） ---------- */
function renderHome(main) {
  main.append(timelineNudge() || "", backupNudge() || "", renderConfirm() || "");
  if (dayKeys.length && (!allDays || (!roads && !summaryTried))) {
    main.append(h("p", { class: "empty", text: "記録を集計しています…" }));
    ensureAll().then(() => { if (tab === "home") render(); });
    return;
  }
  const days = allDays || [];
  // 初めて行った日（駅・施設ごと）
  const firstAt = new Map();
  for (const v of visits) if (!firstAt.has(v.stationId) || v.at < firstAt.get(v.stationId)) firstAt.set(v.stationId, v.at);
  const newOn = (date) => stations.filter((s) => firstAt.get(s.id) && localDay(firstAt.get(s.id)) === date);
  const dayKm = (d) => {
    const k = tl.kmByMode(d.acts); delete k.fly;
    if (roads && k.car) { const c = rd.splitCar(roads, d); delete k.car; k.hw = c.hw; k.general = c.general; }
    return k;
  };
  const chipsOf = (k) => Object.entries(k).filter(([, v]) => v >= 0.1).map(([m, v]) =>
    h("span", { class: "chip", style: `--c:${m === "hw" ? ROADCOLORS.hw : m === "general" ? ROADCOLORS.general : tl.MODES[m]?.color}`,
      text: `${m === "hw" ? "高速" : m === "general" ? "一般道" : tl.MODES[m]?.label} ${Math.round(v * 10) / 10}km` }));

  if (days.length) {
    // 今月
    const month = days.at(-1).date.slice(0, 7);
    const md0 = days.filter((d) => d.date.startsWith(month));
    const mk = {};
    for (const d of md0) for (const [m, v] of Object.entries(dayKm(d))) mk[m] = (mk[m] || 0) + v;
    const newM = stations.filter((s) => firstAt.get(s.id) && localDay(firstAt.get(s.id)).startsWith(month));
    main.append(h("section", { class: "card review" },
      h("p", { class: "muted", text: `${+month.slice(5)}月のあしあと` }),
      h("p", { class: "big" }, h("b", { text: Math.round(Object.values(mk).reduce((a, b) => a + b, 0)).toLocaleString() }), " km"),
      h("div", { class: "modes" }, chipsOf(mk)),
      newM.length ? h("p", { class: "muted", text: `初めて：${newM.map((s) => s.name).join("・")}` }) : null));
    // 最近の日
    const recent = days.slice(-7).reverse();
    main.append(h("h2", { class: "gridhead", text: "最近の日" }),
      h("ol", { class: "recent" }, recent.map((d) => {
        const nw = newOn(d.date);
        return h("li", {}, h("button", { type: "button", onclick: () => { mapDate = d.date; tab = "map"; render(); window.scrollTo(0, 0); } },
          h("b", { text: ymd(d.date + "T12:00") }),
          h("div", { class: "modes" }, chipsOf(dayKm(d))),
          nw.length ? h("small", { text: `初めて：${nw.map((s) => s.name).join("・")}` }) : null));
      })),
      h("p", { class: "muted", text: `移動の記録は ${ymd(days.at(-1).date + "T12:00")} まで。タイムラインを読み込むと続きが入ります。` }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む")));
  } else {
    main.append(h("section", { class: "card" },
      h("h2", { text: "移動の記録を読み込む" }),
      h("p", { text: "Googleマップのタイムラインを読み込むと、最近の移動・初めて行った場所・路線のあしあとが自動でたまります。" }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む", true))));
  }
  main.append(renderNext() || "");
  main.append(h("details", { class: "add gps" }, h("summary", { text: "今いる場所をその場で記録する（GPS）" }), renderNear()));
}

// 全日分の記録・道路・駅データを読む（集計する画面の前に1回）
function ensureAll() {
  summaryTried = true;
  return Promise.all([allDays ? null : db.getAll("days").then((d) => (allDays = d)),
    roads ? null : rd.loadRoads().then((r) => (roads = r)).catch(() => null),
    master ? null : geo.loadMaster().then((m) => (master = m)).catch(() => null)]);
}

/* ---------- あしあと図鑑 ---------- */
function renderZukan(main) {
  main.append(renderConfirm() || "");
  renderFind(main);
  const mine = stations.filter((s) => visitsOf(s.id).length);
  if (!mine.length) {
    main.append(h("p", { class: "empty", text: "まだありません。タイムラインを読み込むか、駅で「今いる場所を記録する」を押すと、初めて行った駅や施設がここに並びます。" }));
  } else {
    // 最近押した順
    const last = (s) => visitsOf(s.id).at(-1).at;
    const list = mine.sort((a, b) => last(b).localeCompare(last(a)));
    const groups = [["駅", list.filter((s) => !isSpot(s))],
      ...Object.entries(rd.GROUPS).map(([g, label]) => [label, list.filter((s) => rd.KINDS[s.kind]?.group === g)])];
    for (const [label, items] of groups) {
      if (items.length) main.append(h("h2", { class: "gridhead", text: `${label} ${items.length}` }), h("div", { class: "grid" }, items.map(stampButton)));
    }
    main.append(h("p", { class: "hint", text: "判子の日付は初めて行った日。タップすると、行った日の一覧が見られます。" }));
  }
  // 手で足す：打つと全国の駅から候補が出る
  const sugg = h("ul", { class: "sugg" });
  const name = h("input", { name: "name", placeholder: "駅名（例：吉祥寺）", required: true, autocomplete: "off", enterkeyhint: "done",
    oninput: async () => {
      const q = name.value;
      try { master ||= await geo.loadMaster(); } catch { return; }
      if (name.value !== q) return;
      sugg.replaceChildren(...geo.search(master, q).map((m) => h("li", {},
        h("button", { type: "button", onclick: async () => { await recordForgot(m); name.value = ""; sugg.replaceChildren(); } },
          h("b", { text: m.name }), h("small", { text: m.lines })))));
    } });
  main.append(h("details", { class: "add" },
    h("summary", { text: "記録に残っていない駅を手で足す" }),
    h("div", { class: "row" }, name), sugg,
    h("p", { class: "muted", text: "候補をタップすると、今日の日付で記録されます（記録には「タップ」と残ります）。" })));
  // 行った順
  const log = h("details", { class: "add" }, h("summary", { text: "行った順に見る" }));
  main.append(log);
  log.addEventListener("toggle", () => { if (log.open && log.children.length === 1) renderLog(log); });
}

/* ---------- 地図（1日の道のり） ---------- */
function renderMap(main) {
  if (!dayKeys.length) {
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
  if (!mapDate || !dayKeys.includes(mapDate)) mapDate = dayKeys.at(-1);
  const i = dayKeys.indexOf(mapDate);
  const go = (d) => { mapDate = d; render(); };
  const pick = h("input", { type: "date", value: mapDate, min: dayKeys[0], max: dayKeys.at(-1),
    onchange: () => {
      // 記録の無い日を選んだら、その日以前で一番近い記録のある日へ
      const v = pick.value;
      go([...dayKeys].reverse().find((d) => d <= v) || dayKeys[0]);
    } });
  main.append(h("div", { class: "daynav" },
    h("button", { type: "button", "aria-label": "前の日", disabled: i <= 0, onclick: () => go(dayKeys[i - 1]), text: "‹" }),
    pick,
    h("button", { type: "button", "aria-label": "次の日", disabled: i >= dayKeys.length - 1, onclick: () => go(dayKeys[i + 1]), text: "›" })));
  const sum = h("div", { class: "modes" });
  const box = h("div", { class: "map" });
  const below = h("div");
  main.append(sum, box, below);
  Promise.all([db.get("days", mapDate), rd.loadRoads().catch(() => null)]).then(([day, r]) => {
    if (!day || mapDate !== day.date) return;
    roads ||= r;
    const km = tl.kmByMode(day.acts);
    const car = roads && km.car ? rd.splitCar(roads, day) : null;
    const total = Object.values(km).reduce((a, b) => a + b, 0);
    const chips = Object.entries(km).filter(([, v]) => v > 0).flatMap(([m, v]) =>
      m === "car" && car
        ? [h("span", { class: "chip", style: `--c:${ROADCOLORS.hw}`, text: `高速 ${car.hw}km` }),
           h("span", { class: "chip", style: `--c:${ROADCOLORS.general}`, text: `一般道 ${car.general}km` })]
        : [h("span", { class: "chip", style: `--c:${tl.MODES[m].color}`, text: `${tl.MODES[m].label} ${v}km` })]);
    sum.replaceChildren(h("b", { text: `${ymd(mapDate + "T12:00")}　${total.toFixed(1)}km` }), ...chips);
    const stamped = visits.filter((v) => localDay(v.at) === mapDate)
      .map((v) => stations.find((s) => s.id === v.stationId)).filter((s) => s?.lat != null);
    drawDay(box, day, stamped, car);
    below.replaceChildren(
      car?.names.length ? h("p", { class: "muted", text: `走った高速：${car.names.slice(0, 6).join("・")}` }) : "",
      stamped.length ? h("p", { class: "muted", text: `この日に記録した場所：${[...new Set(stamped.map((s) => s.name))].join("・")}` }) : "",
      h("div", { class: "btns" }, ...timelinePicker("新しいタイムラインを読み込む")),
      h("p", { class: "muted", text: "記録はGoogleマップのタイムラインから。読み込みは足し算で、同じ日は記録が詳しいほうが残ります（古いスマホの書き出しも読めます）。" }));
  });
}

// 月ごと・手段ごとの移動距離
async function renderDistance(box) {
  allDays ||= await db.getAll("days");
  if (!allDays.length) return;
  try { roads ||= await rd.loadRoads(); } catch {}
  const months = new Map();
  const drives = [];
  for (const d of allDays) {
    const m = d.date.slice(0, 7);
    const cur = months.get(m) || {};
    const km = tl.kmByMode(d.acts);
    for (const [k, v] of Object.entries(km)) cur[k] = (cur[k] || 0) + v;
    if (roads && km.car) {
      const c = rd.splitCar(roads, d);
      cur.hw = (cur.hw || 0) + c.hw;
      cur.general = (cur.general || 0) + c.general;
      if (km.car >= 50) drives.push({ date: d.date, ...c, km: km.car });
    }
    months.set(m, cur);
  }
  const label = { hw: "高速", general: "一般道" };
  const cols = roads ? ["train", "hw", "general", "walk"] : ["train", "car", "walk"];
  const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  const fmt = (v) => (v ? Math.round(v).toLocaleString() : "–");
  box.replaceChildren(h("h2", { text: "移動距離（km）" }),
    h("div", { class: "tablewrap" }, h("table", { class: "dist" },
      h("thead", {}, h("tr", {}, h("th", { text: "月" }), ...cols.map((c) => h("th", { text: label[c] || tl.MODES[c].label })), h("th", { text: "合計" }))),
      h("tbody", {}, rows.map(([m, v]) => h("tr", {},
        h("td", { text: `${+m.slice(0, 4)}/${+m.slice(5)}` }),
        ...cols.map((c) => h("td", { text: fmt(v[c]) })),
        h("td", { text: fmt(Object.entries(v).filter(([k]) => !["fly", "hw", "general"].includes(k)).reduce((a, [, x]) => a + x, 0)) })))))),
    h("p", { class: "muted", text: "合計に飛行機は入れていません。高速／一般道は、道のりの点と高速道路の位置・速さから推定しています。" }),
    drives.length ? h("h2", { text: "ドライブ（車で50km以上の日）" }) : "",
    drives.length ? h("ol", { class: "drives" }, drives.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map((dv) => {
      const sp = visits.filter((v) => localDay(v.at) === dv.date).map((v) => stations.find((s) => s.id === v.stationId)).filter(isSpot);
      return h("li", {}, h("button", { type: "button", onclick: () => { mapDate = dv.date; tab = "map"; render(); window.scrollTo(0, 0); } },
        h("b", { text: ymd(dv.date + "T12:00") }),
        h("span", { text: `${Math.round(dv.km)}km（高速 ${Math.round(dv.hw)}・一般道 ${Math.round(dv.general)}）` }),
        h("small", { text: [dv.names.slice(0, 3).join("・"), sp.map((s) => s.name).join("・")].filter(Boolean).join("／") })));
    })) : "");
}

function renderSummary(main) {
  if (dayKeys.length && (!allDays || (!roads && !summaryTried))) {
    main.append(h("p", { class: "empty", text: "記録を集計しています…" }));
    ensureAll().then(() => { if (tab === "review" || tab === "life") render(); });
    return;
  }
  const days = allDays || [];
  if (tab === "review") {
    renderReview(main, { allDays: days, stations, visits, roads, master, year: reviewYear,
      setYear: (y) => { reviewYear = y; render(); },
      openDay: (d) => { mapDate = d; tab = "map"; render(); window.scrollTo(0, 0); } });
    if (days.length) { const box = h("section", { class: "card dist-card" }); main.append(box); renderDistance(box); }
  } else {
    const span = days.length ? new Set(days.map((d) => d.date.slice(0, 7))).size : 1;
    renderLife(main, { allDays: days, master, life, monthsSpan: span,
      save: async (next) => { life = next; await db.setMeta("life", next); render(); } });
  }
}
let summaryTried = false;

function renderLog(main) {
  if (!visits.length) { main.append(h("p", { class: "empty", text: "まだ記録がありません。" })); return; }
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
  const sorted = [...visits].sort((a, b) => b.at.localeCompare(a.at));
  let month = "";
  const list = h("ol", { class: "log" });
  for (const v of sorted) {
    const d = new Date(v.at);
    const m = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (m !== month) { month = m; list.append(h("li", { class: "month", text: m })); }
    const s = byId[v.stationId];
    list.append(h("li", { class: "row", style: `--ink:${inkOf(v.stationId)}` },
      h("span", { class: "d", text: md(v.at) }),
      h("span", { class: "n", text: s ? s.name : "（削除した駅）" }),
      h("span", { class: "w", text: HOW[v.how] || "" }),
      v.note ? h("span", { class: "nt", text: v.note }) : null));
  }
  main.append(list);
}

function renderBackup(main) {
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: () => { if (file.files[0]) importJson(file.files[0]); file.value = ""; } });
  const persistText = { yes: "消えにくい設定になっています", no: "ブラウザが「消えにくい設定」を断りました。ホーム画面に追加すると改善します", unsupported: "この端末は「消えにくい設定」に対応していません", "?": "確認中…" }[meta.persisted];
  main.append(
    h("section", { class: "card" },
      h("h2", { text: "バックアップ" }),
      h("p", { text: "あしあとはこのスマホの中にだけあります。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。" }),
      h("div", { class: "btns" },
        h("button", { type: "button", class: "primary", onclick: exportJson, text: "書き出す（JSON）" }),
        h("button", { type: "button", onclick: () => file.click(), text: "読み込む" }), file),
      h("p", { class: "muted", text: meta.lastExport ? `最後に書き出した日：${ymd(meta.lastExport)}` : "まだ書き出したことがありません" }),
      h("p", { class: "muted", text: "読み込みは「足し算」です。今ある記録は消えません。道のりの記録はバックアップに入りません（タイムラインから読み込み直せます）。" })),
    h("section", { class: "card" },
      h("h2", { text: "タイムライン" }),
      h("p", { text: dayKeys.length ? `${dayKeys.length}日分の道のりがあります（${dayKeys[0]}〜${dayKeys.at(-1)}）。` : "まだ読み込んでいません。" }),
      h("div", { class: "btns" }, ...timelinePicker("タイムラインを読み込む"))),
    h("section", { class: "card" },
      h("h2", { text: "この端末の状態" }),
      h("ul", { class: "facts" },
        h("li", { text: `保存：${persistText}` }),
        h("li", { text: `通信：${navigator.onLine ? "オンライン" : "オフライン（記録はできます）"}` }),
        h("li", { text: `起動のしかた：${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "ホーム画面のアプリ" : "ブラウザ"}` }),
        h("li", { text: `版：${APP_VERSION}` })),
      h("p", { class: "muted", text: "駅の位置：国土数値情報（鉄道データ N02-24）（国土交通省）を加工して作成。高速道路：国土数値情報（高速道路時系列データ N06-24）（国土交通省）を加工して作成。SA・PA・道の駅・銭湯・温泉：© OpenStreetMap contributors（ODbL）。地図：地理院タイル" })),
    h("section", { class: "card" },
      h("h2", { text: "ホーム画面に追加" }),
      h("p", { text: "iPhone：Safariの共有ボタン →「ホーム画面に追加」。Android：Chromeのメニュー →「ホーム画面に追加」→「インストール」。" }),
      h("p", { class: "muted", text: "iPhoneでは、Safariで開いたときとホーム画面から開いたときで記録が別々になります。ふだんはホーム画面のアイコンから使ってください。" })),
  );
}

/* ---------- 駅の詳細（下から出るシート） ---------- */
function openSheet(s) {
  const dlg = $("#sheet");
  const draw = () => {
    const vs = visitsOf(s.id);
    const delBtn = h("button", { type: "button", class: "danger", text: "図鑑から消す",
      onclick: async () => {
        if (delBtn.dataset.armed) { dlg.close(); await removeStation(s); return; }
        delBtn.dataset.armed = "1"; delBtn.textContent = "もう一度押すと削除（記録も消えます）";
      } });
    dlg.replaceChildren(h("div", { class: "sheet" },
      h("header", {},
        h("h2", { text: s.name }),
        h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
      h("p", { class: "muted", text: [s.area, s.lines, s.firstDate ? `${md(s.firstDate)}に追加` : ""].filter(Boolean).join("・") }),
      h("button", { type: "button", class: "primary big", text: "今日ここに来た",
        onclick: async () => { await addVisit(s); draw(); } }),
      vs.length
        ? h("ol", { class: "visits" }, vs.map((v) => {
            const undo = h("button", { type: "button", class: "small", text: "取り消す",
              onclick: async () => {
                if (undo.dataset.armed) { await removeVisit(v); draw(); return; }
                undo.dataset.armed = "1"; undo.textContent = "本当に？";
              } });
            const acc = v.how === "gps" && v.acc != null ? ` ±${meters(v.acc)}` : "";
            const day = localDay(v.at);
            const note = h("input", { class: "note", value: v.note || "", placeholder: "一言（例：家族で。黒湯がよかった）", maxlength: 120,
              onchange: async () => { v.note = note.value.trim(); await db.put("visits", v); toast("一言を残しました"); } });
            return h("li", { class: "visit" },
              h("div", { class: "vrow" },
                h("span", { text: `${ymd(v.at)}（${HOW[v.how] || ""}${acc}）` }),
                dayKeys.includes(day) ? h("button", { type: "button", class: "small", text: "その日のルート", onclick: () => openDay(day, s, () => openSheet(s)) }) : null,
                undo),
              note);
          }))
        : h("p", { class: "muted", text: "まだ記録はありません。" }),
      h("p", { class: "links" },
        s.lat != null ? h("a", { href: `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`, target: "_blank", rel: "noopener", text: "地図で見る" }) : null,
        s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: "駅のページ" }) : null),
      h("div", { class: "foot" }, delBtn)));
  };
  draw();
  dlg.showModal();
}

/* ---------- その日のルート（シートの中に地図） ---------- */
// back があれば「戻る」で前のシートへ
async function openDay(date, s, back = null) {
  const dlg = $("#sheet");
  const box = h("div", { class: "map dlgmap" });
  const sum = h("div", { class: "modes" });
  dlg.replaceChildren(h("div", { class: "sheet" },
    h("header", {},
      h("h2", { text: `${ymd(date + "T12:00")}のルート` }),
      h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
    sum, box,
    h("div", { class: "foot" },
      back ? h("button", { type: "button", class: "small", text: "← 戻る", onclick: back }) : null,
      h("button", { type: "button", class: "small", text: "地図タブで開く", onclick: () => { dlg.close(); mapDate = date; tab = "map"; render(); window.scrollTo(0, 0); } }))));
  if (!dlg.open) dlg.showModal();
  const [day, r] = await Promise.all([db.get("days", date), rd.loadRoads().catch(() => null)]);
  if (!day) { box.textContent = "この日の道のりの記録はありません。"; return; }
  roads ||= r;
  const km = tl.kmByMode(day.acts);
  const car = roads && km.car ? rd.splitCar(roads, day) : null;
  sum.replaceChildren(...Object.entries(km).filter(([m, v]) => v > 0 && m !== "fly").map(([m, v]) =>
    h("span", { class: "chip", style: `--c:${tl.MODES[m].color}`, text: `${tl.MODES[m].label} ${v}km` })));
  const here = s?.lat != null ? [s] : [];
  drawDay(box, day, here, car);
}

/* ---------- 起動 ---------- */
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  tab = b.dataset.tab;
  try { localStorage.setItem("eki.tab", tab); } catch {}
  render();
}));
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") e.target.close(); }); // 外側タップで閉じる
const syncOnline = () => { $("#offline").hidden = navigator.onLine; if (tab === "backup") render(); };
addEventListener("online", syncOnline);
addEventListener("offline", syncOnline);
syncOnline();

// サービスワーカー：一度開いたら、電波がなくても開けるようにする係
if ("serviceWorker" in navigator) {
  // 新しい版の門番が入れ替わったら1回だけ読み直す（初回の取り付けでは読み直さない）
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

(async () => {
  try {
    await dropChokanOnce();
    await load();
  } catch (e) {
    $("#main").replaceChildren(h("section", { class: "card" },
      h("h2", { text: "記録を読み込めませんでした" }),
      h("p", { text: String(e?.message || e) }),
      h("p", { class: "muted", text: "記録は消えていません。" }),
      h("button", { type: "button", class: "primary", text: "もう一度読む", onclick: () => location.reload() })));
    return;
  }
  meta.persisted = await askPersist().catch(() => "unsupported");
  if (tab === "backup") render();
  try { master = await geo.loadMaster(); await linkMaster(); render(); await loadRides(); render(); } catch {}
  try { await recheckSpotsOnce(); render(); await backfillSpots(); await recheckStationsOnce(); render(); } catch {}
  if (await geo.permitted()) findNear(); // 許可済みなら、開いたときに自動で探す
})();
