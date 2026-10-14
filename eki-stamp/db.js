// 記録の保存（IndexedDB）
// ブラウザの中にある小さなデータベース。localStorage より容量が大きく、
// 「駅」と「訪問」を別々の表として持てるので、あとから地図やGPSを足しやすい。
//
// 2.3.0（2026-10-14）から：読み書きのたびにデータベースを開き、終わったら閉じる。
// 1本のつなぎを開きっぱなしにして読み書きを重ねると、本人のスマホ（Android 10・Chrome 155）でだけ
// 3回目の読み出しで画面ごと固まった（タブも反応せず、12秒の見張りも動かない）。
// 同じ記録を「毎回開いて閉じる」診断ページでは固まらなかったので、その読み方に合わせた。

import { boot } from "./boot.js";

const DB_NAME = "eki-stamp";
const DB_VERSION = 2; // 2: タイムラインの日ごとの記録（days）を追加
let ready = null;

const opened = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => boot("記録を開くのを待たされている");
});

// 表がそろっているか確かめ、足りなければ作る（起動して最初の1回だけ）
function ensureSchema() {
  ready ||= (async () => {
    boot("記録を開く");
    const db = await opened(indexedDB.open(DB_NAME)); // 版を指定しない＝今の版のまま開く
    const ok = db.version >= DB_VERSION && ["stations", "visits", "days", "meta"].every((s) => db.objectStoreNames.contains(s));
    db.close();
    if (!ok) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // 駅・施設＝図鑑の1枚
        if (!d.objectStoreNames.contains("stations")) d.createObjectStore("stations", { keyPath: "id" });
        // 訪問＝行った1回で1行。同じ場所に何度でも
        if (!d.objectStoreNames.contains("visits")) d.createObjectStore("visits", { keyPath: "id" }).createIndex("stationId", "stationId");
        // 日ごとの移動の記録（タイムラインから）。1日＝1行
        if (!d.objectStoreNames.contains("days")) d.createObjectStore("days", { keyPath: "date" });
        // 設定・メモ（最後に書き出した日など）
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      };
      (await opened(req)).close();
    }
    boot("記録を開いた");
  })();
  return ready;
}
export const openDB = ensureSchema; // 起動時に呼ぶ名前は今までどおり
export function reconnect() { /* 毎回開いて閉じるので、つなぎ直しは要らない */ }

// 1回の読み書き：開く → 1つのトランザクションで fn を実行 → 終わったら閉じる
// ms を過ぎても終わらなければ「待たされている」として失敗にする（黙って止まらない）
async function use(stores, mode, fn, ms = 8000) {
  await ensureSchema();
  const db = await opened(indexedDB.open(DB_NAME));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Object.assign(new Error("待たされている"), { busy: true })); }, ms);
    let tx;
    try { tx = db.transaction(stores, mode); } catch (e) { clearTimeout(timer); db.close(); reject(e); return; }
    const box = {};
    fn(tx, box);
    tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(box.value); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); db.close(); reject(tx.error || new Error("記録の読み書きに失敗")); };
  });
}
const into = (box, req) => { req.onsuccess = () => { box.value = req.result; }; };

// いくつかの表を1回で読む
export function readAll(stores, ms) {
  return use(stores, "readonly", (tx, box) => {
    box.value = {};
    for (const s of stores) {
      const r = tx.objectStore(s).getAll();
      r.onsuccess = () => { box.value[s] = r.result; boot(`${s} を読んだ`); };
    }
  }, ms);
}

export const getAll = (store) => use(store, "readonly", (tx, box) => into(box, tx.objectStore(store).getAll()));
export const get = (store, key) => use(store, "readonly", (tx, box) => into(box, tx.objectStore(store).get(key)));
export const getAllKeys = (store) => use(store, "readonly", (tx, box) => into(box, tx.objectStore(store).getAllKeys()));
export const put = (store, value) => use(store, "readwrite", (tx) => { tx.objectStore(store).put(value); });
export const remove = (store, key) => use(store, "readwrite", (tx) => { tx.objectStore(store).delete(key); });

// 複数の表へまとめて書く。全部成功するか、全部なかったことになる（読み込みの途中で壊れない）
export function putMany(items) {
  if (!items.length) return Promise.resolve();
  const stores = [...new Set(items.map(([store]) => store))];
  return use(stores, "readwrite", (tx) => { for (const [store, value] of items) tx.objectStore(store).put(value); }, 30000);
}

// 駅を消すときは、その駅の訪問もいっしょに消す
export const removeStation = (id) => use(["stations", "visits"], "readwrite", (tx) => {
  tx.objectStore("stations").delete(id);
  const cur = tx.objectStore("visits").index("stationId").openCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } };
});

export const getMeta = (key) => use("meta", "readonly", (tx, box) => into(box, tx.objectStore("meta").get(key)));
export const setMeta = (key, value) => use("meta", "readwrite", (tx) => { tx.objectStore("meta").put(value, key); });
