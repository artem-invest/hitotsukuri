// サービスワーカー：ページとブラウザの間に立つ「門番」
// 1回目に開いたとき、アプリ本体のファイルをスマホの中（Cache Storage）にしまっておく。
// 2回目からは、しまっておいたものをすぐ返す（電波がなくても開ける）。
// 裏でネットから最新版を取りに行き、取れたら差し替える（次に開いたときに新しい版になる）。

const VERSION = "eki-stamp-v12"; // アプリ本体を変えたらここを上げる → 古いしまい場所を捨てる
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./db.js",
  "./geo.js",
  "./timeline.js",
  "./map.js",
  "./roads.js",
  "./ui.js",
  "./review.js",
  "./life.js",
  "./linestyle.js",
  "./munis.json",
  "./roads.json",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./stations.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // cache:"reload" … ブラウザの一時保存を通さず、必ずサーバーから新しい版を取る（古い駅データが混ざらないように）
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("eki-stamp-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return; // 外部リンクは素通し
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { event.waitUntil(fresh); return cached; }      // しまってあれば即返す
      return (await fresh) || (await cache.match("./index.html")) || Response.error();
    })
  );
});
