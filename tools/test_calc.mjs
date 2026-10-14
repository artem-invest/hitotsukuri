// 計算の自動テスト（ブラウザ無しで、アプリの計算部分だけを確かめる）
//   node tools/test_calc.mjs
// 道のりは作り物（本人のタイムラインは使わない）。1つでも外れたら終了コード1
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eki-stamp");
// アプリは fetch("./xxx.json") でデータを読むので、ファイルから返すようにする
globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(readFileSync(path.join(dir, u.replace("./", "")), "utf8")) });
globalThis.atob ||= (b) => Buffer.from(b, "base64").toString("binary");
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
const geo = await load("geo.js"), rd = await load("roads.js"), tl = await load("timeline.js");
const master = await geo.loadMaster(), roads = await rd.loadRoads(), land = await rd.loadLand();
const isSea = rd.seaTest(land);

let ng = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ng++;
  console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `：${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`}`);
};
// 点の列から1日を作る（1分おき・移動1回）
const day = (mode, path, km = 50) => ({ date: "2026-01-01", stays: [],
  pts: path.map(([la, lo], i) => [1000 + i * 60, la, lo]),
  acts: [{ s: 1000, e: 1000 + (path.length - 1) * 60, mode, km, a: path[0], b: path.at(-1) }] });
const boat = (path) => { const d = day("car", path); tl.fixBoats([d], isSea); return d.acts[0].mode; };

console.log("— 船の見分け");
check("福岡の沖へ出て戻る（2026-07-02 の実例に近い形）", boat([[33.90, 130.53], [33.97, 130.47], [34.05, 130.40], [34.12, 130.28], [34.17, 130.12], [34.10, 130.25], [34.0, 130.42], [33.90, 130.53]]), "boat");
const oki = Array(20).fill([34.24, 130.11]); // 沖の島の同じ1点に何度も戻る（位置の推定が島に吸い寄せられる）
check("沖の島の同じ点が何度も出ても船", boat([[33.88, 130.53], [34.0, 130.35], ...oki, [34.18, 129.93], [34.30, 129.95], [34.32, 129.88], [34.24, 129.85], [34.20, 130.22], [34.10, 130.39], [33.88, 130.53]]), "boat");
check("東名（横浜→沼津）は車のまま", boat([[35.47, 139.58], [35.44, 139.40], [35.38, 139.20], [35.30, 139.00], [35.25, 138.90], [35.13, 138.86]]), "car");
check("アクアラインは車のまま", boat([[35.53, 139.75], [35.50, 139.80], [35.47, 139.85], [35.44, 139.90], [35.40, 139.93]]), "car");
check("宮古島の中のドライブは車のまま（3.0.0 で直した誤判定）", boat([[24.80925, 125.20678], [24.81119, 125.21837], [24.79138, 125.26961], [24.79154, 125.26679], [24.79203, 125.27642]]), "car");
check("北海道の山道（天馬街道）は車のまま", boat([[42.17, 142.77], [42.25, 142.90], [42.30, 143.05], [42.35, 143.15], [42.45, 143.25]]), "car");
check("石垣島の中は車のまま", boat([[24.34, 124.16], [24.40, 124.18], [24.45, 124.20], [24.50, 124.22]]), "car");

console.log("— 電車の乗り降り");
const train = (a, b) => ({ date: "2026-01-02", stays: [], pts: [], acts: [{ s: 0, e: 600, mode: "train", km: 5, a, b }] });
const stops = tl.railStops([train([35.6896, 139.7006], [35.6580, 139.7016])], master, geo.STAMP_RADIUS).map((x) => x.m.name);
check("新宿→渋谷の乗り降り駅", stops, ["新宿", "渋谷"]);
const rides = tl.railRides([train([35.6896, 139.7006], [35.6580, 139.7016])], master, geo.STAMP_RADIUS);
check("新宿→渋谷で代々木・原宿を通る", rides.length ? ["代々木", "原宿"].every((n) => rides[0].ids.some((id) => master.byId[id].name === n)) : false, true);

console.log("— 高速");
// 東名（第一東海自動車道）の線の上の点を拾い、時速90kmで走ったことにする
const line = JSON.parse(readFileSync(path.join(dir, "roads.json"), "utf8")).highways.find(([n, f]) => n === "第一東海自動車道" && f.length > 400)[1];
const pts = [];
for (let i = 0; i < line.length && pts.length < 8; i += 60) pts.push([line[i], line[i + 1]]);
const tomei = day("car", pts, 0);
let t = 1000, km = 0;
tomei.pts = pts.map(([la, lo], i) => {
  if (i) { const m = geo.distance(pts[i - 1][0], pts[i - 1][1], la, lo); km += m / 1000; t += Math.max(60, Math.round(m / 25)); }
  return [t, la, lo];
});
Object.assign(tomei.acts[0], { e: t, km: Math.round(km * 10) / 10, b: pts.at(-1) });
const car = rd.splitCar(roads, tomei);
check("東名を時速90kmで走ると高速が半分以上", car.hw > car.general, true);
const routes = await rd.loadHwRoutes();
const pass = rd.hwPasses(roads, routes, [tomei]);
const tomeiRoute = routes.find((r) => r.name === "東名高速");
check("東名のSA・PAを1つ以上通ったことになる", tomeiRoute.places.some((p) => pass.has(p.ids[0])), true);
const michi = await rd.loadMichi();
check("道の駅は47都道府県", michi.length, 47);

console.log(ng ? `\n外れ ${ng}件` : "\nすべてOK");
process.exit(ng ? 1 : 0);
