// 地図：1日の道のりを手段ごとの色で描く（Leaflet＋地理院タイル）
// 地図の画像はネットから取るので、電波が無いときは線と駅の点だけが出る。
import { MODES, dayLines } from "./timeline.js";

let map = null;

export function drawDay(el, day, stamps) {
  const L = window.L;
  if (!L) { el.textContent = "地図の部品を読み込めませんでした。"; return; }
  if (map) { map.remove(); map = null; } // 画面を作り直すたびに地図も作り直す
  map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
  }).addTo(map);

  const bounds = [];
  for (const run of dayLines(day)) {
    // 白い縁取りの上に色の線を重ねて、地図の上でも読みやすくする
    L.polyline(run.path, { color: "#fff", weight: 7, opacity: 0.8 }).addTo(map);
    L.polyline(run.path, { color: MODES[run.mode].color, weight: 4, opacity: 0.95 }).addTo(map);
    bounds.push(...run.path);
  }
  for (const s of stamps) {
    L.circleMarker([s.lat, s.lng], { radius: 7, color: "#fff", weight: 2, fillColor: MODES.train.color, fillOpacity: 1 })
      .bindTooltip(s.name, { direction: "top", offset: [0, -6] })
      .addTo(map);
    bounds.push([s.lat, s.lng]);
  }
  if (!bounds.length) for (const st of day.stays) bounds.push(st.at);
  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
  else map.setView([35.68, 139.76], 11);
}
