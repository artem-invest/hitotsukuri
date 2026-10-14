// タイムライン（Googleマップが裏で記録している「行った場所と道のり」）を読む
// スマホの 設定 → 位置情報 → 位置情報サービス → タイムライン →「タイムライン データをエクスポート」で出るJSON。
// 中身は semanticSegments（移動・滞在・道のりの点）。ここで日ごとにまとめ直してアプリに保存する。
import * as geo from "./geo.js";

export const MODES = {
  train: { label: "電車", color: "#d0472f" },
  car: { label: "車", color: "#3f6fc4" },
  walk: { label: "徒歩", color: "#3a9a62" },
  bus: { label: "バス", color: "#c7772a" },
  bike: { label: "自転車", color: "#9a5bb3" },
  boat: { label: "船", color: "#1f8a9e" },
  fly: { label: "飛行機", color: "#8a8f98" },
  other: { label: "その他", color: "#8a8f98" },
};
const MODE_OF = {
  IN_TRAIN: "train", IN_SUBWAY: "train", IN_TRAM: "train",
  IN_PASSENGER_VEHICLE: "car", IN_BUS: "bus",
  WALKING: "walk", RUNNING: "walk", CYCLING: "bike", FLYING: "fly",
  IN_FERRY: "boat", SAILING: "boat",
};

const r5 = (x) => Math.round(x * 1e5) / 1e5;
// "35.6812345°, 139.7671234°" → [35.68123, 139.76712]
function latLng(s) {
  const m = /(-?[\d.]+)°?\s*,\s*(-?[\d.]+)/.exec(s || "");
  return m ? [r5(+m[1]), r5(+m[2])] : null;
}
// 時刻は現地の時差つき（…+09:00）なので、先頭10文字がその土地での日付
const dayOf = (iso) => iso.slice(0, 10);
const sec = (iso) => Math.round(Date.parse(iso) / 1000);

// 日ごとの記録 [{date, pts:[[秒,緯度,経度]...], acts:[{s,e,mode,km,a,b}], stays:[{s,e,at}]}]
export function parseTimeline(data) {
  const segs = data?.semanticSegments;
  if (!Array.isArray(segs)) throw new Error("not-timeline");
  const days = new Map();
  const day = (d) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { date: d, pts: [], acts: [], stays: [] }));
    return x;
  };
  for (const s of segs) {
    if (s.timelinePath) {
      for (const p of s.timelinePath) {
        const ll = latLng(p.point);
        if (ll && p.time) day(dayOf(p.time)).pts.push([sec(p.time), ll[0], ll[1]]);
      }
    } else if (s.activity && s.startTime) {
      const a = s.activity;
      const A = latLng(a.start?.latLng), B = latLng(a.end?.latLng);
      if (!A || !B) continue;
      day(dayOf(s.startTime)).acts.push({
        s: sec(s.startTime), e: sec(s.endTime),
        mode: MODE_OF[a.topCandidate?.type] || "other",
        km: Math.round((+a.distanceMeters || 0) / 100) / 10,
        a: A, b: B,
      });
    } else if (s.visit && s.startTime) {
      const ll = latLng(s.visit.topCandidate?.placeLocation?.latLng);
      if (ll) day(dayOf(s.startTime)).stays.push({ s: sec(s.startTime), e: sec(s.endTime), at: ll });
    }
  }
  for (const d of days.values()) {
    d.pts.sort((x, y) => x[0] - y[0]);
    d.acts.sort((x, y) => x.s - y.s);
  }
  return [...days.values()].sort((x, y) => x.date.localeCompare(y.date));
}

// 電車で乗り降りした駅：電車の移動の「出発地点」「到着地点」から一番近い駅（radius m 以内）
// sure＝自信あり：駅から150m未満で、2番目に近い駅との差が80m以上（紛らわしい隣の駅が無い）
// 実データで167駅中16駅が「一度も自信ありが無い」（豪徳寺と山下、浜松町とモノレール浜松町など）
export function railStops(days, master, radius) {
  const out = [];
  for (const d of days) {
    for (const a of d.acts) {
      if (a.mode !== "train") continue;
      for (const [ll, t] of [[a.a, a.s], [a.b, a.e]]) {
        const [n, n2] = geo.nearest(master, ll[0], ll[1], 2);
        if (!n || n.dist > radius) continue;
        const sure = n.dist < 150 && !(n2 && n2.dist - n.dist < 80);
        out.push({ m: n, t, sure, alt: n2 && !sure ? n2.name : null });
      }
    }
  }
  return out;
}

// 乗った区間（乗りつぶし）：電車の移動1回ごとに、乗った駅と降りた駅が同じ路線にあれば、その間の駅を「通った」とする
// 返り値 [{li: 路線番号, ids: [駅ID...（乗った駅〜降りた駅）], date}]
export function railRides(days, master, radius) {
  const pos = (id) => (master.byId[id].c ||= geo.center(master.byId[id]));
  const gap = (x, y) => { const p = pos(x), q = pos(y); return geo.distance(p.lat, p.lng, q.lat, q.lng) / 1000; };
  const segKm = (ids) => ids.slice(1).reduce((s, id, k) => s + gap(ids[k], id), 0);
  // 環状線（端と端が3km以内）なら、逆回りも候補にする
  const isLoop = (ids) => ids.length >= 8 && gap(ids[0], ids.at(-1)) < 3;
  const routes = (ids, i, j) => {
    const out = [i < j ? ids.slice(i, j + 1) : ids.slice(j, i + 1).reverse()];
    if (isLoop(ids)) {
      const n = ids.length, step = i < j ? -1 : 1, r = [];
      for (let k = i; ; k = (k + step + n) % n) { r.push(ids[k]); if (k === j) break; }
      out.push(r);
    }
    return out;
  };
  const rides = [];
  for (const d of days) {
    for (const a of d.acts) {
      if (a.mode !== "train") continue;
      const A = geo.nearest(master, a.a[0], a.a[1], 1)[0];
      const B = geo.nearest(master, a.b[0], a.b[1], 1)[0];
      if (!A || !B || A.dist > radius || B.dist > radius || A.id === B.id) continue;
      let best = null;
      for (const li of A.li) {
        if (!B.li.includes(li)) continue;
        const ids = master.lines[li].ids;
        for (const r of routes(ids, ids.indexOf(A.id), ids.indexOf(B.id))) {
          const km = segKm(r);
          if (!best || km < best.km) best = { li, ids: r, km };
        }
      }
      // 線路沿いの距離が記録の距離より極端に長いもの（乗り換えを含む移動・並び順の推定違い）は使わない
      const ref = Math.max(a.km, gap(A.id, B.id));
      if (best && best.km <= ref * 1.5 + 2) rides.push({ li: best.li, ids: best.ids, date: d.date });
    }
  }
  return rides;
}

// 1日の道のりを、手段ごとに色を分けた線の集まりにする
// 道のりの点に移動の始点・終点を足して時刻順に並べ、隣り合う2点の間を「その時刻の移動手段」で塗る
export function dayLines(d) {
  const pts = [...d.pts];
  for (const a of d.acts) { pts.push([a.s, a.a[0], a.a[1]]); pts.push([a.e, a.b[0], a.b[1]]); }
  pts.sort((x, y) => x[0] - y[0]);
  const modeAt = (t) => d.acts.find((a) => a.s <= t && t <= a.e)?.mode || null;
  const runs = [];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (p[1] === q[1] && p[2] === q[2]) continue;
    const mode = modeAt((p[0] + q[0]) / 2);
    if (!mode) continue; // 滞在中や記録の切れ目は線にしない
    const last = runs.at(-1);
    if (last && last.mode === mode && last.end === p) last.path.push([q[1], q[2]]);
    else runs.push({ mode, path: [[p[1], p[2]], [q[1], q[2]]] });
    runs.at(-1).end = q;
  }
  return runs.map(({ mode, path }) => ({ mode, path }));
}

// 手段ごとの距離 {train: 12.3, ...}
// 海の上を走った「車」を船に直す。Googleは小さな船（釣り船など）を乗用車と判定することがある（2026-07-02 本人の実例）
// isSea(緯度, 経度) は陸から遠い海の上か。移動中の点（両端を含む）の半分以上・3点以上が海なら船とみなす
// 半分にしたのは、北海道の山道（天馬街道など）にも陸の手がかりが少ない所があり、そこを一部通る車の移動を船にしないため
export function fixBoats(days, isSea) {
  const changed = [];
  for (const d of days) {
    let hit = false;
    for (const a of d.acts) {
      if (a.mode !== "car") continue;
      const pts = [a.a, ...d.pts.filter((p) => p[0] >= a.s && p[0] <= a.e).map((p) => [p[1], p[2]]), a.b];
      const sea = pts.filter((p) => isSea(p[0], p[1])).length;
      if (sea >= 3 && sea * 2 >= pts.length) { a.mode = "boat"; hit = true; }
    }
    if (hit) changed.push(d);
  }
  return changed;
}

export function kmByMode(acts) {
  const out = {};
  for (const a of acts) out[a.mode] = Math.round(((out[a.mode] || 0) + a.km) * 10) / 10;
  return out;
}
