// 記録の保存（IndexedDB）
// ブラウザの中にある小さなデータベース。localStorage より容量が大きく、
// 「駅」と「訪問」を別々の表として持てるので、あとから地図やGPSを足しやすい。

const DB_NAME = "eki-stamp";
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 初回（またはバージョンを上げたとき）だけ表を作る
    req.onupgradeneeded = () => {
      const db = req.result;
      // 駅＝スタンプ台。lat/lng は次回のGPS用に空のまま持っておく
      if (!db.objectStoreNames.contains("stations")) {
        db.createObjectStore("stations", { keyPath: "id" });
      }
      // 訪問＝押したスタンプ1回で1行。同じ駅に何度でも押せる
      if (!db.objectStoreNames.contains("visits")) {
        const visits = db.createObjectStore("visits", { keyPath: "id" });
        visits.createIndex("stationId", "stationId");
      }
      // 設定・メモ（最後に書き出した日など）
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const result = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function getAll(store) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  return finished(tx);
}

export async function remove(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return finished(tx);
}

// 複数の表へまとめて書く。全部成功するか、全部なかったことになる（読み込みの途中で壊れない）
export async function putMany(items) {
  if (!items.length) return;
  const db = await openDB();
  const stores = [...new Set(items.map(([store]) => store))];
  const tx = db.transaction(stores, "readwrite");
  for (const [store, value] of items) tx.objectStore(store).put(value);
  return finished(tx);
}

// 駅を消すときは、その駅の訪問もいっしょに消す
export async function removeStation(id) {
  const db = await openDB();
  const tx = db.transaction(["stations", "visits"], "readwrite");
  tx.objectStore("stations").delete(id);
  const cursorReq = tx.objectStore("visits").index("stationId").openCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  return finished(tx);
}

export async function getMeta(key) {
  const db = await openDB();
  return result(db.transaction("meta").objectStore("meta").get(key));
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value, key);
  return finished(tx);
}
