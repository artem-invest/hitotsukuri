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
  fly: { label: "飛行機", color: "#8a8f98" },
  other: { label: "その他", color: "#8a8f98" },
};
const MODE_OF = {
  IN_TRAIN: "train", IN_SUBWAY: "train", IN_TRAM: "train",
  IN_PASSENGER_VEHICLE: "car", IN_BUS: "bus",
  WALKING: "walk", RUNNING: "walk", CYCLING: "bike", FLYING: "fly",
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
export function railStops(days, master, radius) {
  const out = [];
  for (const d of days) {
    for (const a of d.acts) {
      if (a.mode !== "train") continue;
      for (const [ll, t] of [[a.a, a.s], [a.b, a.e]]) {
        const n = geo.nearest(master, ll[0], ll[1], 1)[0];
        if (n && n.dist <= radius) out.push({ m: n, t });
      }
    }
  }
  return out;
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
export function kmByMode(acts) {
  const out = {};
  for (const a of acts) out[a.mode] = Math.round(((out[a.mode] || 0) + a.km) * 10) / 10;
  return out;
}
