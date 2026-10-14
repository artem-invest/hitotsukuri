// あしあと帳：起動・下のタブ・左右フリック
// データの流れ： IndexedDB（db.js）→ 状態 S（state.js）→ render() で画面を作り直す
// 画面ごとのファイル：最近 home.js／図鑑 zukan.js／路線 lines.js／地図 mapview.js／その他 more.js／さがす find.js
// 記録の読み書きは data.js にまとめてある
import * as geo from "./geo.js";
import { $, h } from "./ui.js";
import { S, setRenderer, go, visitsOf, isSpot, needMaster, needRides } from "./state.js";
import { load, askPersist, runSteps, linkMaster } from "./data.js";
import { renderHome, findNear } from "./home.js";
import { renderZukan } from "./zukan.js";
import { renderLines } from "./lines.js";
import { renderMap } from "./mapview.js";
import { renderMore } from "./more.js";
import { openSearch } from "./find.js";

const TABS = ["home", "zukan", "lines", "map", "more"];

function renderAll() {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  const went = S.stations.filter((s) => visitsOf(s.id).length);
  const spots = went.filter(isSpot).length;
  $("#summary").textContent = `${went.length - spots}駅${spots ? `・${spots}か所` : ""}`;
  const main = $("#main");
  main.replaceChildren();
  ({ home: renderHome, zukan: renderZukan, lines: renderLines, map: renderMap, more: renderMore }[S.tab] || renderHome)(main);
}
setRenderer(renderAll);

/* ---------- タブ ---------- */
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
$("#search").addEventListener("click", openSearch);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") e.target.close(); }); // 外側タップで閉じる

// 左右のフリックで隣のタブへ。地図・横に流れる路線図・表・入力欄の上では動かさない（そちらの操作を優先）
// 画面の端から始まる指は、Androidの「戻る」の操作なので見ない
let touch = null;
const NOSWIPE = ".leaflet-container,.route,.tablewrap,.chips,.seg,input,select,textarea";
$(".wrap").addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  touch = e.touches.length === 1 && !e.target.closest(NOSWIPE) && t.clientX > 24 && t.clientX < innerWidth - 24
    ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
$(".wrap").addEventListener("touchend", (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x, dy = t.clientY - touch.y, quick = Date.now() - touch.at < 700;
  touch = null;
  if (!quick || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
  const next = TABS[TABS.indexOf(S.tab) + (dx < 0 ? 1 : -1)];
  if (!next) return;
  go(next);
  $("#main").animate([{ transform: `translateX(${dx < 0 ? 24 : -24}px)`, opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 160, easing: "ease-out" });
}, { passive: true });

const syncOnline = () => { $("#offline").hidden = navigator.onLine; };
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

/* ---------- 起動 ---------- */
(async () => {
  try {
    await runSteps(true); // 記録を読む前に行う更新手順
    await load();
  } catch (e) {
    $("#main").replaceChildren(h("section", { class: "card" },
      h("h2", { text: "記録を読み込めませんでした" }),
      h("p", { text: String(e?.message || e) }),
      h("p", { class: "muted", text: "記録は消えていません。" }),
      h("button", { type: "button", class: "primary", text: "もう一度読む", onclick: () => location.reload() })));
    return;
  }
  S.meta.persisted = await askPersist().catch(() => "unsupported");
  if (S.tab === "more") renderAll();
  try {
    await needMaster();
    await runSteps(false); // 駅・道路データを使う更新手順
    await linkMaster();
    renderAll();
    await needRides();
    renderAll();
  } catch {}
  if (await geo.permitted()) findNear(); // 許可済みなら、開いたときに自動で探す
})();
