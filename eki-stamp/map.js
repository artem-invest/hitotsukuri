// 地図：1日の道のりを手段ごとの色で描く（Leaflet＋地理院タイル）
// 地図の画像はネットから取るので、電波が無いときは線と駅の点だけが出る。
import { MODES, dayLines } from "./timeline.js";
import { KINDS } from "./roads.js";

export const ROADCOLORS = { hw: "#1d3f8f", general: "#79a6e8" };

let map = null;

// car：roads.splitCar の結果（無ければ車も1色で描く）
// 地図の大きさが変わったとき（全画面の切り替えなど）に描き直させる
export const refreshMap = () => map?.invalidateSize();

export function drawDay(el, day, stamps, car = null) {
  const L = window.L;
  if (!L) { el.textContent = "地図の部品を読み込めませんでした。"; return; }
  if (map) { map.remove(); map = null; } // 画面を作り直すたびに地図も作り直す
  map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
  }).addTo(map);

  const bounds = [];
  const line = (path, color) => {
    // 白い縁取りの上に色の線を重ねて、地図の上でも読みやすくする
    L.polyline(path, { color: "#fff", weight: 7, opacity: 0.8 }).addTo(map);
    L.polyline(path, { color, weight: 4, opacity: 0.95 }).addTo(map);
    bounds.push(...path);
  };
  for (const run of dayLines(day)) if (!(car && run.mode === "car")) line(run.path, MODES[run.mode].color);
  if (car) for (const sg of car.segs) line(sg.path, sg.hw ? ROADCOLORS.hw : ROADCOLORS.general);
  for (const s of stamps) {
    const kind = KINDS[s.kind];
    const icon = kind
      ? L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<span class="spotpin" style="--c:${kind.color}">${kind.label}</span>`, iconSize: null }) })
      : L.circleMarker([s.lat, s.lng], { radius: 7, color: "#fff", weight: 2, fillColor: MODES.train.color, fillOpacity: 1 });
    icon.bindTooltip(s.name, { direction: "top", offset: [0, -8] }).addTo(map);
    bounds.push([s.lat, s.lng]);
  }
  if (!bounds.length) for (const st of day.stays) bounds.push(st.at);
  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
  else map.setView([35.68, 139.76], 11);
}
