// 駅の位置データと現在地
// stations.json（全国約9,000駅）を読み、現在地から近い駅や、駅名の候補を返す。

export const STAMP_RADIUS = 300; // 駅（どれかのホーム）からこの距離[m]以内ならスタンプを押せる

let master = null;
let loading = null;

// 1行 [id, 駅名, 路線, [[経度,緯度],...]] → 使いやすい形に
export function loadMaster() {
  if (master) return Promise.resolve(master);
  loading ||= fetch("./stations.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      master = d.stations.map(([id, name, lines, pts]) => ({ id, name, lines, pts }));
      master.byId = Object.fromEntries(master.map((m) => [m.id, m]));
      master.source = d.source;
      return master;
    })
    .catch((e) => { loading = null; throw e; });
  return loading;
}

// 2点間の距離[m]（地球を球とみなす。駅の近さを測るには十分）
export function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 駅の代表地点（ホームの中点の平均）
export const center = (m) => ({
  lat: m.pts.reduce((s, p) => s + p[1], 0) / m.pts.length,
  lng: m.pts.reduce((s, p) => s + p[0], 0) / m.pts.length,
});

// 現在地から近い順に n 駅。距離は「いちばん近いホーム」まで
export function nearest(list, lat, lng, n = 3) {
  const box = 0.05; // 約5km四方だけ厳密に測る（全駅を毎回測らない）
  const out = [];
  for (const m of list) {
    const p0 = m.pts[0];
    if (Math.abs(p0[1] - lat) > box || Math.abs(p0[0] - lng) > box * 1.3) continue;
    const d = Math.min(...m.pts.map((p) => distance(lat, lng, p[1], p[0])));
    out.push({ ...m, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, n);
}

// 駅名の候補：前方一致を先に、次に部分一致
export function search(list, q, n = 8) {
  q = q.trim().replace(/駅$/, "");
  if (!q) return [];
  const head = [], mid = [];
  for (const m of list) {
    if (m.name.startsWith(q)) head.push(m);
    else if (m.name.includes(q)) mid.push(m);
    if (head.length >= n) break;
  }
  return [...head, ...mid].slice(0, n);
}

// 現在地を1回取る。高精度（GPS）で、15秒待っても取れなければ失敗
export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("unsupported")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

// すでに位置情報を許可済みか（許可済みなら、開いたときに自動で探す）
export async function permitted() {
  try { return (await navigator.permissions.query({ name: "geolocation" })).state === "granted"; }
  catch { return false; }
}
