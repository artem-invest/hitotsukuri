// 駅スタンプ帳：画面と操作
// データの流れ： IndexedDB（db.js）→ stations / visits の配列 → render() で画面を作り直す
import * as db from "./db.js";

const APP_VERSION = "1.0.0";
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
try { tab = localStorage.getItem("eki.tab") || "stamps"; } catch {}

const visitsOf = (id) => visits.filter((v) => v.stationId === id).sort((a, b) => a.at.localeCompare(b.at));

async function load() {
  [stations, visits] = await Promise.all([db.getAll("stations"), db.getAll("visits")]);
  meta.lastExport = await db.getMeta("lastExport");
  render();
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
async function addVisit(station) {
  const v = { id: uid("v"), stationId: station.id, at: new Date().toISOString(), how: "tap", lat: null, lng: null };
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

async function addStation(name, area) {
  name = name.trim().replace(/駅$/, "");
  if (!name) return;
  if (stations.some((s) => s.name === name)) { toast(`${name} はもうあります`); return; }
  const s = { id: uid("u"), name, area: area.trim(), firstDate: today(), url: "", lat: null, lng: null, source: "manual" };
  await db.put("stations", s);
  stations.push(s);
  toast(`${name} を追加しました`);
  render();
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
  $("#summary").textContent = `${went.length}駅 / ${stations.length}駅・スタンプ ${visits.length}個`;
  const main = $("#main");
  main.replaceChildren();
  if (tab === "stamps") renderStamps(main);
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
    s.area ? h("small", { text: s.area }) : null,
    on ? h("small", { class: "dt", text: md(vs[0].at) }) : null,
    vs.length > 1 ? h("span", { class: "times", text: `×${vs.length}` }) : null,
  );
}

function renderStamps(main) {
  main.append(backupNudge() || "");
  if (!stations.length) {
    main.append(h("p", { class: "empty", text: "まだ駅がありません。下から駅を追加してください。" }));
  } else {
    const list = [...stations].sort((a, b) => (a.firstDate || "").localeCompare(b.firstDate || "") || a.name.localeCompare(b.name, "ja"));
    main.append(h("div", { class: "grid" }, list.map(stampButton)));
    main.append(h("p", { class: "hint", text: "駅をタップすると、スタンプを押したり記録を見たりできます。" }));
  }
  const name = h("input", { name: "name", placeholder: "駅名（例：吉祥寺）", required: true, autocomplete: "off", enterkeyhint: "done" });
  const area = h("input", { name: "area", placeholder: "区・市（任意）", autocomplete: "off" });
  main.append(h("form", {
    class: "add",
    onsubmit: (e) => { e.preventDefault(); addStation(name.value, area.value); },
  }, h("h2", { text: "駅を追加" }), h("div", { class: "row" }, name, area, h("button", { type: "submit", text: "追加" }))));
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
        h("li", { text: `版：${APP_VERSION}` }))),
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
      h("p", { class: "muted", text: [s.area, s.firstDate ? `${md(s.firstDate)}に追加` : ""].filter(Boolean).join("・") }),
      h("button", { type: "button", class: "primary big", text: "今日ここに来た（スタンプ）",
        onclick: async () => { await addVisit(s); draw(); } }),
      vs.length
        ? h("ol", { class: "visits" }, vs.map((v) => {
            const undo = h("button", { type: "button", class: "small", text: "取り消す",
              onclick: async () => {
                if (undo.dataset.armed) { await removeVisit(v); draw(); return; }
                undo.dataset.armed = "1"; undo.textContent = "本当に？";
              } });
            return h("li", {}, h("span", { text: `${ymd(v.at)}（${HOW[v.how] || ""}）` }), undo);
          }))
        : h("p", { class: "muted", text: "まだスタンプはありません。" }),
      s.url ? h("p", {}, h("a", { href: s.url, target: "_blank", rel: "noopener", text: "駅のページ" })) : null,
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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

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
})();
