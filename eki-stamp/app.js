// 駅スタンプ帳：画面と操作
// データの流れ： IndexedDB（db.js）→ stations / visits の配列 → render() で画面を作り直す
import * as db from "./db.js";
import * as geo from "./geo.js";

const APP_VERSION = "1.2.0";
const INKS = ["#d0472f", "#3f6fc4", "#3a9a62", "#9a5bb3", "#c7772a"]; // スタンプのインク（明暗どちらの地でも読める中間の濃さ）

// 朝刊の駅スタンプ帳から引き継いだ記録（2026-10-13時点）。初回起動のときだけ入れる
const SEED = {
  stations: [
    { id: "station-musashikoyama", name: "武蔵小山", area: "品川区", firstDate: "2026-10-07", url: "https://www.tokyu.co.jp/railway/station/mg.html" },
    { id: "station-monzennakacho", name: "門前仲町", area: "江東区", firstDate: "2026-10-08", url: "https://www.tokyometro.jp/station/monzen-nakacho/index.html" },
    { id: "station-kitasenju", name: "北千住", area: "足立区", firstDate: "2026-10-09", url: "https://www.tokyometro.jp/station/kita-senju/index.html" },
    { id: "station-sangenjaya", name: "三軒茶屋", area: "世田谷区", firstDate: "2026-10-12", url: "https://www.tokyu.co.jp/railway/station/dt.html" },
    { id: "station-tsukiji", name: "築地", area: "中央区", firstDate: "2026-10-13", url: "https://www.tokyometro.jp/station/tsukiji/index.html" },
  ].map((s) => ({ ...s, lat: null, lng: null, source: "chokan" })),
  visits: [
    { stationId: "station-musashikoyama", at: "2026-10-09T01:40:59.752Z" },
    { stationId: "station-monzennakacho", at: "2026-10-09T01:40:36.666Z" },
    { stationId: "station-sangenjaya", at: "2026-10-12T12:35:35.168Z" },
    { stationId: "station-kitasenju", at: "2026-10-12T13:51:02.769Z" },
  ].map((v) => ({ id: "seed-" + v.stationId, ...v, how: "chokan", lat: null, lng: null })),
};

/* ---------- 小道具 ---------- */
const $ = (s) => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const md = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const ymd = (iso) => { const d = new Date(iso); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function hash(s) { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n; }
const inkOf = (id) => INKS[hash(id) % INKS.length];
const tiltOf = (id) => (hash(id + "t") % 21) - 10; // -10〜+10度
const HOW = { tap: "タップ", gps: "GPS", chokan: "朝刊から", import: "読み込み" };
const meters = (d) => (d < 1000 ? `${Math.round(d / 10) * 10}m` : `${(d / 1000).toFixed(1)}km`);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- 状態 ---------- */
let stations = [];
let visits = [];
let meta = { lastExport: null, persisted: "?" };
let tab = "stamps";
let near = { state: "idle" }; // 近くの駅：idle / locating / done / error
let master = null;            // 全国の駅データ（geo.loadMaster）
try { tab = localStorage.getItem("eki.tab") || "stamps"; } catch {}

const visitsOf = (id) => visits.filter((v) => v.stationId === id).sort((a, b) => a.at.localeCompare(b.at));

async function load() {
  [stations, visits] = await Promise.all([db.getAll("stations"), db.getAll("visits")]);
  meta.lastExport = await db.getMeta("lastExport");
  render();
}

// 位置の無い駅（朝刊から来た駅・手で足した駅）を、名前が1つに決まれば全国データと結びつける
async function linkMaster() {
  const changed = [];
  for (const s of stations) {
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

async function seedIfFirst() {
  if (await db.getMeta("seeded")) return;
  await db.putMany([
    ...SEED.stations.map((s) => ["stations", s]),
    ...SEED.visits.map((v) => ["visits", v]),
  ]);
  await db.setMeta("seeded", new Date().toISOString());
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
  toast(`${station.name} にスタンプを押しました`);
  render();
}

async function removeVisit(v) {
  await db.remove("visits", v.id);
  visits = visits.filter((x) => x.id !== v.id);
  render();
}

// 全国データの駅 m に対応する手持ちの駅を返す。無ければ作る
async function ensureStation(m) {
  let s = stations.find((x) => x.gid === m.id);
  if (s) return s;
  const c = geo.center(m);
  s = { id: m.id, gid: m.id, name: m.name, lines: m.lines, area: "", firstDate: today(), url: "", lat: c.lat, lng: c.lng, source: "master" };
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
    near = { state: "done", pos, list: geo.nearest(m, pos.lat, pos.lng, 3) };
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
  const s = await ensureStation(m);
  await addVisit(s, near.pos);
}

async function removeStation(s) {
  await db.removeStation(s.id);
  stations = stations.filter((x) => x.id !== s.id);
  visits = visits.filter((v) => v.stationId !== s.id);
  toast(`${s.name} を削除しました`);
  render();
}

/* ---------- バックアップ（JSONの書き出し・読み込み） ---------- */
async function exportJson() {
  const data = { app: "eki-stamp", format: 1, exportedAt: new Date().toISOString(), stations, visits };
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
    toast("駅スタンプ帳のバックアップではありません"); return;
  }
  const okS = data.stations.filter((s) => s && typeof s.id === "string" && typeof s.name === "string");
  const okV = data.visits.filter((v) => v && typeof v.id === "string" && typeof v.stationId === "string" && !isNaN(Date.parse(v.at)));
  const newS = okS.filter((s) => !stations.some((x) => x.id === s.id)).length;
  const newV = okV.filter((v) => !visits.some((x) => x.id === v.id)).length;
  // 足し合わせる（今ある記録は消さない）。同じIDは同じ記録なので上書きしても中身は同じ
  await db.putMany([...okS.map((s) => ["stations", s]), ...okV.map((v) => ["visits", v])]);
  await load();
  toast(`読み込みました（新しい駅 ${newS}・スタンプ ${newV}）`);
}

/* ---------- 画面 ---------- */
function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  const went = stations.filter((s) => visitsOf(s.id).length);
  $("#summary").textContent = `${went.length}駅・スタンプ ${visits.length}個`;
  const main = $("#main");
  main.replaceChildren();
  if (tab === "stamps") renderStamps(main);
  else if (tab === "lines") renderLines(main);
  else if (tab === "log") renderLog(main);
  else renderBackup(main);
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
    class: "stamp" + (on ? " on" : ""),
    style: on ? `--ink:${inkOf(s.id)};--tilt:${tiltOf(s.id)}deg` : "",
    "aria-label": `${s.name}${on ? `（${vs.length}回）` : "（まだ）"}`,
    onclick: () => openSheet(s),
  },
    h("span", { class: "nm", text: s.name }),
    (s.area || s.lines) ? h("small", { text: s.area || s.lines.split("・")[0] }) : null,
    on ? h("small", { class: "dt", text: md(vs[0].at) }) : null,
    vs.length > 1 ? h("span", { class: "times", text: `×${vs.length}` }) : null,
  );
}

function renderNear() {
  const box = h("section", { class: "near" });
  box.append(h("button", { type: "button", class: "primary big", onclick: findNear,
    disabled: near.state === "locating",
    text: near.state === "locating" ? "現在地を確かめています…" : near.state === "done" ? "もう一度探す" : "近くの駅を探す（GPS）" }));
  if (near.state === "error") box.append(h("p", { class: "warn", text: near.msg }));
  if (near.state === "done") {
    const { pos, list } = near;
    if (pos.acc > geo.STAMP_RADIUS) box.append(h("p", { class: "warn", text: `位置の誤差が大きめです（±${meters(pos.acc)}）。少し待ってもう一度探すと正確になります。` }));
    if (!list.length) box.append(h("p", { class: "muted", text: "5km以内に駅がありません。" }));
    box.append(h("ol", { class: "nearlist" }, list.map((m) => {
      const ok = m.dist <= geo.STAMP_RADIUS;
      const done = stampedToday(stations.find((x) => x.gid === m.id));
      return h("li", { class: ok ? "in" : "" },
        h("div", {}, h("b", { text: m.name }), h("small", { text: `${meters(m.dist)}・${m.lines}` })),
        ok
          ? h("button", { type: "button", class: "primary", disabled: done, text: done ? "今日は押した" : "スタンプ",
              onclick: async (e) => { e.currentTarget.disabled = true; await stampHere(m); } })
          : h("span", { class: "muted", text: `あと${meters(m.dist - geo.STAMP_RADIUS)}` }));
    })));
  }
  return box;
}

/* ---------- 路線の塗り絵 ---------- */
// 押した駅（全国データと結びついたもの）の集合
const visitedGids = () => new Set(stations.filter((s) => s.gid && visitsOf(s.id).length).map((s) => s.gid));

// 押した駅が1つでもある路線と、その埋まり具合
function myLines() {
  if (!master) return [];
  const got = visitedGids();
  const touched = new Set();
  for (const g of got) for (const i of master.byId[g]?.li || []) touched.add(i);
  return [...touched].map((i) => {
    const l = master.lines[i];
    const done = l.ids.filter((id) => got.has(id)).length;
    return { ...l, done, total: l.ids.length, left: l.ids.length - done };
  }).sort((a, b) => b.done / b.total - a.done / a.total || a.left - b.left);
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
      if (!cur || l.left < cur.line.left) seen.set(id, { m, d, line: l });
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
    h("ol", { class: "nearlist" }, list.map(({ m, d, line }) => h("li", {},
      h("div", {}, h("b", { text: m.name }), h("small", { text: `${line.name} あと${line.left}駅で制覇・${meters(d)}` })),
      h("a", { class: "maplink", href: `https://www.google.com/maps/search/?api=1&query=${geo.center(m).lat},${geo.center(m).lng}`, target: "_blank", rel: "noopener", text: "地図" })))));
}

function renderLines(main) {
  const lines = myLines();
  if (!lines.length) {
    main.append(h("p", { class: "empty", text: "駅でスタンプを押すと、その駅を通る路線がここに並びます。全駅で降りたら「制覇」です。" }));
    return;
  }
  const got = visitedGids();
  const full = lines.filter((l) => l.left === 0).length;
  main.append(h("p", { class: "linesum" }, h("b", { text: `${lines.length}路線` }), ` に足あと・制覇 ${full}路線`));
  for (const l of lines) {
    const pct = Math.round((l.done / l.total) * 100);
    const d = h("details", { class: "line" + (l.left === 0 ? " full" : "") },
      h("summary", {},
        h("span", { class: "ln", text: l.name }),
        h("span", { class: "cnt", text: l.left === 0 ? "制覇！" : `${l.done}/${l.total}` }),
        h("span", { class: "bar" }, h("i", { style: `width:${pct}%` }))),
      h("ol", { class: "dots" }, l.ids.map((id) => h("li", { class: got.has(id) ? "on" : "" }, master.byId[id].name))));
    main.append(d);
  }
  main.append(h("p", { class: "hint", text: "路線をタップすると、端から順に駅が並びます（色つき＝降りた駅）。支線のある路線は順番が少し前後します。" }));
}

function renderStamps(main) {
  main.append(backupNudge() || "", renderNear());
  const mine = stations.filter((s) => visitsOf(s.id).length);
  if (!mine.length) {
    main.append(h("p", { class: "empty", text: "まだスタンプがありません。駅に着いたら「近くの駅を探す」を押してください。" }));
  } else {
    // 最近押した順
    const last = (s) => visitsOf(s.id).at(-1).at;
    const list = mine.sort((a, b) => last(b).localeCompare(last(a)));
    main.append(h("div", { class: "grid" }, list.map(stampButton)));
    main.append(h("p", { class: "hint", text: "駅をタップすると、記録を見たり、もう一度押したりできます。" }));
  }
  main.append(renderNext() || "");
  // 押し忘れた駅を記録：打つと全国の駅から候補が出る
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
    h("summary", { text: "GPSで押し忘れた駅を記録する" }),
    h("div", { class: "row" }, name), sugg,
    h("p", { class: "muted", text: "候補をタップすると、今日の日付でスタンプが押されます（記録には「タップ」と残ります）。" })));
}

function renderLog(main) {
  if (!visits.length) { main.append(h("p", { class: "empty", text: "まだスタンプがありません。" })); return; }
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
      h("span", { class: "w", text: HOW[v.how] || "" })));
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
      h("p", { text: "記録はこのスマホの中にだけあります。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。" }),
      h("div", { class: "btns" },
        h("button", { type: "button", class: "primary", onclick: exportJson, text: "書き出す（JSON）" }),
        h("button", { type: "button", onclick: () => file.click(), text: "読み込む" }), file),
      h("p", { class: "muted", text: meta.lastExport ? `最後に書き出した日：${ymd(meta.lastExport)}` : "まだ書き出したことがありません" }),
      h("p", { class: "muted", text: "読み込みは「足し算」です。今ある記録は消えません。" })),
    h("section", { class: "card" },
      h("h2", { text: "この端末の状態" }),
      h("ul", { class: "facts" },
        h("li", { text: `保存：${persistText}` }),
        h("li", { text: `通信：${navigator.onLine ? "オンライン" : "オフライン（記録はできます）"}` }),
        h("li", { text: `起動のしかた：${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "ホーム画面のアプリ" : "ブラウザ"}` }),
        h("li", { text: `版：${APP_VERSION}` })),
      h("p", { class: "muted", text: "駅の位置：国土数値情報（鉄道データ N02-24）（国土交通省）を加工して作成" })),
    h("section", { class: "card" },
      h("h2", { text: "ホーム画面に追加" }),
      h("p", { text: "iPhone：Safariの共有ボタン →「ホーム画面に追加」。Android：Chromeのメニュー →「ホーム画面に追加」。" }),
      h("p", { class: "muted", text: "iPhoneでは、Safariで開いたときとホーム画面から開いたときで記録が別々になります。ふだんはホーム画面のアイコンから使ってください。" })),
  );
}

/* ---------- 駅の詳細（下から出るシート） ---------- */
function openSheet(s) {
  const dlg = $("#sheet");
  const draw = () => {
    const vs = visitsOf(s.id);
    const delBtn = h("button", { type: "button", class: "danger", text: "この駅を削除",
      onclick: async () => {
        if (delBtn.dataset.armed) { dlg.close(); await removeStation(s); return; }
        delBtn.dataset.armed = "1"; delBtn.textContent = "もう一度押すと削除（記録も消えます）";
      } });
    dlg.replaceChildren(h("div", { class: "sheet" },
      h("header", {},
        h("h2", { text: s.name }),
        h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
      h("p", { class: "muted", text: [s.area, s.lines, s.firstDate ? `${md(s.firstDate)}に追加` : ""].filter(Boolean).join("・") }),
      h("button", { type: "button", class: "primary big", text: "今日ここに来た（スタンプ）",
        onclick: async () => { await addVisit(s); draw(); } }),
      vs.length
        ? h("ol", { class: "visits" }, vs.map((v) => {
            const undo = h("button", { type: "button", class: "small", text: "取り消す",
              onclick: async () => {
                if (undo.dataset.armed) { await removeVisit(v); draw(); return; }
                undo.dataset.armed = "1"; undo.textContent = "本当に？";
              } });
            const acc = v.how === "gps" && v.acc != null ? ` ±${meters(v.acc)}` : "";
            return h("li", {}, h("span", { text: `${ymd(v.at)}（${HOW[v.how] || ""}${acc}）` }), undo);
          }))
        : h("p", { class: "muted", text: "まだスタンプはありません。" }),
      h("p", { class: "links" },
        s.lat != null ? h("a", { href: `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`, target: "_blank", rel: "noopener", text: "地図で見る" }) : null,
        s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: "駅のページ" }) : null),
      h("div", { class: "foot" }, delBtn)));
  };
  draw();
  dlg.showModal();
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
    await seedIfFirst();
    await load();
  } catch (e) {
    $("#main").replaceChildren(h("p", { class: "empty", text: "記録を読み込めませんでした。プライベートブラウズでは使えないことがあります。" }));
    return;
  }
  meta.persisted = await askPersist().catch(() => "unsupported");
  if (tab === "backup") render();
  try { master = await geo.loadMaster(); await linkMaster(); render(); } catch {}
  if (await geo.permitted()) findNear(); // 許可済みなら、開いたときに自動で探す
})();
