// SA・PA・道の駅と高速道路（roads.json）
// 車の道のりを「高速」と「一般道」に分け、立ち寄った SA・PA・道の駅を見つける。
import { distance } from "./geo.js";

export const SPOT_RADIUS = 250;  // 滞在した場所からこの距離[m]以内の SA・PA・道の駅にスタンプ
const HW_NEAR = 60;              // 高速道路の線からこの距離[m]以内なら「高速の上」
const HW_AROUND = 500;           // 点がまばらなときは、この距離[m]以内に高速があり、速ければ高速とみなす
const FAST_KMH = 55;             // 一般道で平均この速さを超えることはまず無い
// group：スタンプ帳での並べ方。radius/minStay：タイムラインで「立ち寄った」とみなす距離[m]と滞在[分]
// 銭湯は町の中に密集しているので、近く・長めの滞在に絞る（隣の銭湯と取り違えないように）
export const KINDS = {
  sa: { label: "SA", color: "#3f6fc4", group: "road", radius: SPOT_RADIUS, minStay: 0 },
  pa: { label: "PA", color: "#3a9a62", group: "road", radius: SPOT_RADIUS, minStay: 0 },
  michi: { label: "道の駅", color: "#c7772a", group: "road", radius: SPOT_RADIUS, minStay: 0 },
  sento: { label: "銭湯", color: "#2b6f8f", group: "bath", radius: 80, minStay: 20 },
  super: { label: "スーパー銭湯", color: "#7a3f8f", group: "bath", radius: 100, minStay: 20 },
  onsen: { label: "温泉", color: "#c8432b", group: "bath", radius: 150, minStay: 20 },
};
export const GROUPS = { road: "SA・PA・道の駅", bath: "銭湯・温泉" };

let roads = null;
let loading = null;
const CELL = 0.01; // 約1km四方のマス目で、近くの線だけを調べる
const key = (la, lo) => `${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`;

export function loadRoads() {
  if (roads) return Promise.resolve(roads);
  loading ||= fetch("./roads.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      const spots = d.spots.map(([id, name, kind, lat, lng]) => ({ id, name, kind, lat, lng }));
      // 高速道路の線分を、通るマス目ごとに登録しておく
      const grid = new Map();
      for (const [name, flat] of d.highways) {
        for (let i = 2; i < flat.length; i += 2) {
          const a = [flat[i - 2], flat[i - 1]], b = [flat[i], flat[i + 1]];
          const la0 = Math.floor(Math.min(a[0], b[0]) / CELL), la1 = Math.floor(Math.max(a[0], b[0]) / CELL);
          const lo0 = Math.floor(Math.min(a[1], b[1]) / CELL), lo1 = Math.floor(Math.max(a[1], b[1]) / CELL);
          for (let x = la0; x <= la1; x++) for (let y = lo0; y <= lo1; y++) {
            const k = `${x},${y}`;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push([a, b, name]);
          }
        }
      }
      roads = { spots, byId: Object.fromEntries(spots.map((s) => [s.id, s])), grid, source: d.source };
      return roads;
    })
    .catch((e) => { loading = null; throw e; });
  return loading;
}

// 点 p から線分 ab までの距離[m]（狭い範囲なので平面とみなす）
export function segDist(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * 111320 * k, ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * 111320 * k, by = (b[0] - p[0]) * 110540;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// いちばん近い高速道路 {d: 距離m, name} （radius より遠ければ null）
export function nearHighway(r, la, lo, radius = HW_AROUND) {
  const x = Math.floor(la / CELL), y = Math.floor(lo / CELL);
  let best = null;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [a, b, name] of r.grid.get(`${x + i},${y + j}`) || []) {
      const d = segDist([la, lo], a, b);
      if (d <= radius && (!best || d < best.d)) best = { d, name };
    }
  }
  return best;
}

// いちばん近い施設。radius を省くと種類ごとの距離（KINDS.radius）で判定。ok で種類を絞れる
export function nearestSpot(r, la, lo, radius = null, ok = () => true) {
  let best = null;
  for (const s of r.spots) {
    if (Math.abs(s.lat - la) > 0.015 || Math.abs(s.lng - lo) > 0.02 || !ok(s)) continue;
    const d = distance(la, lo, s.lat, s.lng);
    if (d <= (radius ?? KINDS[s.kind].radius) && (!best || d < best.dist)) best = { ...s, dist: d };
  }
  return best;
}

// 1日の車の移動を、高速と一般道に分ける
// タイムラインの道のりの点は数km〜十数kmおきで、道路から数百mずれることもある（実データで確認）。そこで、隣り合う2点の間を
//   ・どちらも高速の線から60m以内で、時速30km以上 → 高速（点が細かいとき）
//   ・どちらかの近く500m以内に高速があり、平均で時速55km以上 → 高速（点がまばらなとき。一般道ではまず出ない速さ）
// として判定する
// 距離は「高速の割合 × 記録の距離」で配分する（点はまばらなので、合計はタイムラインの距離に合わせる）
export function splitCar(r, day) {
  let hw = 0, general = 0;
  const names = new Set();
  const segs = []; // 地図用 [{hw: bool, path: [[lat,lng],...]}]
  for (const a of day.acts) {
    if (a.mode !== "car") continue;
    const pts = day.pts.filter((p) => p[0] >= a.s && p[0] <= a.e);
    pts.unshift([a.s, a.a[0], a.a[1]]);
    pts.push([a.e, a.b[0], a.b[1]]);
    let hwM = 0, allM = 0;
    let prevHw = null;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const m = distance(p[1], p[2], q[1], q[2]);
      if (!m) continue;
      const kmh = q[0] > p[0] ? (m / (q[0] - p[0])) * 3.6 : 0;
      const n1 = nearHighway(r, p[1], p[2]), n2 = nearHighway(r, q[1], q[2]);
      const close = n1 && n2 && n1.d <= HW_NEAR && n2.d <= HW_NEAR;
      const isHw = !!((close && kmh >= 30) || ((n1 || n2) && kmh >= FAST_KMH));
      if (isHw) { hwM += m; names.add((n2 || n1).name); }
      allM += m;
      const last = segs.at(-1);
      if (last && prevHw === isHw && last.end === p) last.path.push([q[1], q[2]]);
      else segs.push({ hw: isHw, path: [[p[1], p[2]], [q[1], q[2]]] });
      segs.at(-1).end = q;
      prevHw = isHw;
    }
    const share = allM ? hwM / allM : 0;
    hw += a.km * share;
    general += a.km * (1 - share);
  }
  return { hw: Math.round(hw * 10) / 10, general: Math.round(general * 10) / 10, names: [...names], segs };
}

// 立ち寄ったかもしれない SA・PA・道の駅・銭湯・温泉 [{spot, t, mins(滞在分・発着地点はnull), dist(m)}]
// 手がかりは「滞在」と「車の移動の出発・到着地点」。短い休憩は滞在として残らないことが多いため（実データで確認）
// 銭湯・温泉は「滞在」だけを見て、種類ごとの距離と滞在時間（KINDS.minStay）を満たすものに限る
export function spotStops(r, days) {
  const out = [];
  const road = (s) => KINDS[s.kind].group === "road";
  const hit = (la, lo, t, ok, mins = null) => {
    const s = nearestSpot(r, la, lo, null, ok);
    if (s && !s.name.includes("大型")) out.push({ spot: s, t, mins, dist: s.dist });
  };
  for (const d of days) {
    for (const st of d.stays) {
      const mins = (st.e - st.s) / 60;
      hit(st.at[0], st.at[1], st.s, (s) => mins >= KINDS[s.kind].minStay, mins);
    }
    for (const a of d.acts) if (a.mode === "car") { hit(a.a[0], a.a[1], a.s, road); hit(a.b[0], a.b[1], a.e, road); }
  }
  return out;
}

// 高速道路ごとの SA・PA の並び（hwroutes.json。tools/build_hwroutes.py で roads.json から作る）
// routes: [{legal: 法令名, name: 呼び名, sym: 記号, places: [{name, ids: [spot id（上り・下りなど）]}]}]
let hwLoading = null;
export function loadHwRoutes() {
  hwLoading ||= fetch("./hwroutes.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => d.routes.map(([legal, name, sym, places]) => ({ legal, name, sym, places: places.map(([n, ids]) => ({ name: n, ids })) })))
    .catch((e) => { hwLoading = null; throw e; });
  return hwLoading;
}

const PASS_M = 1500; // 高速を走った区間（点と点を結んだ線）からこの距離[m]以内の SA・PA を「通った」とする（点がまばらなので広め）
// 車で高速を走った日に、そばを通った SA・PA → Map(場所のキー＝ids[0] → Set(日付))
export function hwPasses(r, routes, days) {
  const grid = new Map(); // 約1km四方のマス目 → [場所]
  for (const rt of routes) for (const p of rt.places) {
    const s = r.byId[p.ids[0]];
    if (!s) continue;
    const k = key(s.lat, s.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ key: p.ids[0], lat: s.lat, lng: s.lng });
  }
  const out = new Map();
  const R = 2; // 線分の外側 2マス（約2km）まで見る
  for (const d of days) {
    if (!d.acts.some((a) => a.mode === "car")) continue;
    for (const seg of splitCar(r, d).segs) {
      if (!seg.hw) continue;
      for (let i = 1; i < seg.path.length; i++) {
        const a = seg.path[i - 1], b = seg.path[i];
        const x0 = Math.floor(Math.min(a[0], b[0]) / CELL) - R, x1 = Math.floor(Math.max(a[0], b[0]) / CELL) + R;
        const y0 = Math.floor(Math.min(a[1], b[1]) / CELL) - R, y1 = Math.floor(Math.max(a[1], b[1]) / CELL) + R;
        if ((x1 - x0) * (y1 - y0) > 40000) continue; // 点が飛びすぎ（数百km）
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          for (const p of grid.get(`${x},${y}`) || []) {
            if (out.get(p.key)?.has(d.date) || segDist([p.lat, p.lng], a, b) > PASS_M) continue;
            if (!out.has(p.key)) out.set(p.key, new Set());
            out.get(p.key).add(d.date);
          }
        }
      }
    }
  }
  return out;
}
