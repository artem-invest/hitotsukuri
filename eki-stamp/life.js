// 家探し：よく行く場所（タイムラインの滞在）から、候補の駅ごとの「月あたりの移動時間の目安」を比べる
// 場所の名前・大事さ・候補の駅は、このスマホの中（meta の "life"）にだけ保存する。
// 町名は国土地理院の住所検索（逆ジオコーダ）で調べる。送るのは場所の緯度経度だけで、結果は life.addr に覚えておく
import { h, km } from "./ui.js";
import * as geo from "./geo.js";

const JOIN = 150;  // この距離[m]以内の滞在は同じ場所とみなす
const TOP = 12;    // 名前を付ける候補として出す数
export const WEIGHTS = [["0", "使わない"], ["1", "少し"], ["2", "普通"], ["3", "大事"]];

// 滞在をまとめて「よく行く場所」にする
// 戻り値 [{lat, lng, days(日数), hours, night(夜を過ごした日数), weekday(平日昼の日数), weekend(週末の日数)}]
export function findPlaces(allDays) {
  const places = [];
  for (const d of allDays) {
    const dow = new Date(d.date + "T12:00").getDay();
    for (const st of d.stays) {
      const [la, lo] = st.at;
      let p = places.find((x) => Math.abs(x.lat - la) < 0.003 && Math.abs(x.lng - lo) < 0.004 && geo.distance(x.lat, x.lng, la, lo) <= JOIN);
      if (!p) places.push((p = { lat: la, lng: lo, n: 0, dates: new Set(), nights: new Set(), wd: new Set(), we: new Set(), hours: 0 }));
      // 中心は滞在の平均に寄せていく
      p.lat = (p.lat * p.n + la) / (p.n + 1);
      p.lng = (p.lng * p.n + lo) / (p.n + 1);
      p.n++;
      p.dates.add(d.date);
      p.hours += (st.e - st.s) / 3600;
      const s = new Date(st.s * 1000), e = new Date(st.e * 1000);
      // 夜中の3時をまたぐ、または夜10時以降に始まる滞在＝夜を過ごした
      const three = new Date(s); three.setHours(3, 0, 0, 0); if (three < s) three.setDate(three.getDate() + 1);
      if (three <= e || s.getHours() >= 22) p.nights.add(d.date);
      if (dow >= 1 && dow <= 5 && s.getHours() < 17 && e.getHours() >= 10 && (st.e - st.s) >= 3 * 3600) p.wd.add(d.date);
      if (dow === 0 || dow === 6) p.we.add(d.date);
    }
  }
  return places
    .map((p) => ({ lat: p.lat, lng: p.lng, days: p.dates.size, hours: p.hours, night: p.nights.size, weekday: p.wd.size, weekend: p.we.size }))
    .sort((a, b) => b.days - a.days)
    .slice(0, TOP);
}

// 電車のふだんの速さ（記録の電車の距離 ÷ 乗っていた時間）。乗り換え・待ち時間込みの実感に近い
export function trainSpeed(allDays) {
  let k = 0, s = 0;
  for (const d of allDays) for (const a of d.acts) if (a.mode === "train" && a.km > 1) { k += a.km; s += a.e - a.s; }
  const v = s ? k / (s / 3600) : 30;
  return Math.min(45, Math.max(20, v));
}

// 片道の時間の目安[分]：駅まで歩く・待つ10分 ＋ 直線距離×1.3（線路は遠回りする）÷ ふだんの速さ
export const minutes = (distKm, speed) => Math.round(10 + ((distKm * 1.3) / speed) * 60);

// 保存してある名前を、今の「よく行く場所」に当てはめる（中心が少し動いても150m以内なら同じ場所）
export function attach(places, saved) {
  return places.map((p) => {
    const s = saved.find((x) => geo.distance(x.lat, x.lng, p.lat, p.lng) <= JOIN);
    return { ...p, name: s?.name || "", weight: s?.weight ?? "1", home: !!s?.home };
  });
}

/* ---------- 町名（国土地理院の住所検索） ---------- */
const akey = (p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
let munis = null;
const asking = new Set();
async function lookup(p) {
  munis ||= await fetch("./munis.json").then((r) => r.json());
  const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${p.lat.toFixed(5)}&lon=${p.lng.toFixed(5)}`).then((x) => x.json());
  const c = r?.results;
  return c ? `${munis[String(parseInt(c.muniCd, 10))] || ""}${c.lv01Nm === "－" ? "" : c.lv01Nm || ""}` : "";
}
// まだ町名の無い場所をまとめて調べ、終わったら1回だけ保存する
async function fillAddresses(places, app) {
  if (!navigator.onLine) return;
  const todo = places.filter((p) => !app.life.addr?.[akey(p)] && !asking.has(akey(p)));
  if (!todo.length) return;
  todo.forEach((p) => asking.add(akey(p)));
  const addr = { ...(app.life.addr || {}) };
  for (const p of todo) {
    try { addr[akey(p)] = await lookup(p); } catch { /* 取れなければ次に開いたときに再挑戦 */ }
  }
  todo.forEach((p) => asking.delete(akey(p)));
  app.save({ ...app.life, addr });
}

/* ---------- よく行く場所の地図（番号つきのピン） ---------- */
let pmap = null;
function drawPlaces(el, places) {
  const L = window.L;
  if (!L) return;
  if (pmap) { pmap.remove(); pmap = null; }
  pmap = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
  }).addTo(pmap);
  places.forEach((p, i) => L.marker([p.lat, p.lng], {
    icon: L.divIcon({ className: "", html: `<span class="numpin${p.home ? " home" : ""}">${i + 1}</span>`, iconSize: null }),
  }).addTo(pmap));
  pmap.fitBounds(places.map((p) => [p.lat, p.lng]), { padding: [20, 20], maxZoom: 14 });
}

// app: { allDays, master, life: {places:[], candidates:[], addr:{}}, save(life), monthsSpan }
export function renderLife(main, app) {
  const { allDays, master } = app;
  if (!allDays.length || !master) {
    main.append(h("p", { class: "empty", text: "地図タブでタイムラインを読み込むと、よく行く場所から家探しの比較ができます。" }));
    return;
  }
  const life = app.life;
  const found = attach(findPlaces(allDays), life.places);
  const speed = trainSpeed(allDays);
  const months = Math.max(1, app.monthsSpan);
  const nearSt = (p) => geo.nearest(master, p.lat, p.lng, 1)[0];
  // 名前が無いときの推測：夜を過ごした日がいちばん多い所＝自宅、平日昼が多い所＝職場
  const homeGuess = [...found].sort((a, b) => b.night - a.night)[0];
  const workGuess = [...found].filter((p) => p !== homeGuess).sort((a, b) => b.weekday - a.weekday)[0];

  const save = (p, patch) => {
    const rest = life.places.filter((x) => geo.distance(x.lat, x.lng, p.lat, p.lng) > JOIN);
    const cur = { lat: p.lat, lng: p.lng, name: p.name, weight: p.weight, home: p.home, ...patch };
    if (cur.home) rest.forEach((x) => (x.home = false)); // 今の家は1か所だけ
    app.save({ ...life, places: [...rest, cur] });
  };

  // 1. よく行く場所
  const mapBox = h("div", { class: "placemap" });
  main.append(h("section", { class: "card" },
    h("h2", { text: "よく行く場所" }),
    h("p", { class: "muted", text: `タイムラインの滞在から、行った日数の多い順に${found.length}か所。名前と大事さを付けると、下の比較に使われます。` }),
    mapBox,
    h("ol", { class: "places" }, found.map((p, i) => {
      const st = nearSt(p);
      const hint = p === homeGuess ? "自宅？" : p === workGuess ? "職場？" : "";
      const pattern = [p.night >= p.days * 0.5 && "夜が多い", p.weekday >= p.days * 0.4 && "平日昼が多い", p.weekend >= p.days * 0.5 && "週末が多い"].filter(Boolean).join("・");
      const name = h("input", { value: p.name, placeholder: hint || `${st?.name || ""}付近`, "aria-label": "場所の名前",
        onchange: () => save(p, { name: name.value.trim() }) });
      const wt = h("select", { "aria-label": "大事さ", onchange: () => save(p, { weight: wt.value }) },
        WEIGHTS.map(([v, t]) => h("option", { value: v, selected: v === p.weight, text: t })));
      const home = h("label", { class: "homechk" },
        h("input", { type: "checkbox", checked: p.home, onchange: (e) => save(p, { home: e.target.checked }) }), "今の家");
      const addr = life.addr?.[akey(p)];
      return h("li", {},
        h("div", { class: "pl-head" },
          h("b", { class: "numpin" + (p.home ? " home" : ""), text: `${i + 1}` }),
          h("div", {},
            h("strong", { text: addr || (navigator.onLine ? "町名を調べています…" : "（町名はオンラインのときに調べます）") }),
            h("span", { text: `${st ? `${st.name}駅から${km(st.dist / 1000)}km・` : ""}${p.days}日（月${(p.days / months).toFixed(1)}日）${pattern ? "・" + pattern : ""}` }),
            h("a", { href: `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, target: "_blank", rel: "noopener", text: "Googleマップで見る" }))),
        h("div", { class: "row" }, name, wt, home));
    })),
    h("p", { class: "muted", text: "「今の家」に印を付けた場所は比較から外し、今の家からの時間として並べます。町名は国土地理院の住所検索で調べています（送るのは場所の緯度経度だけ）。" })));
  if (found.length) { drawPlaces(mapBox, found); fillAddresses(found, app); }

  // 2. 候補の駅
  const cands = life.candidates.map((id) => master.byId[id]).filter(Boolean);
  const sugg = h("ul", { class: "sugg" });
  const input = h("input", { placeholder: "候補の駅（例：経堂）", autocomplete: "off", enterkeyhint: "done",
    oninput: () => {
      sugg.replaceChildren(...geo.search(master, input.value, 6).map((m) => h("li", {},
        h("button", { type: "button", onclick: () => { if (!life.candidates.includes(m.id)) app.save({ ...life, candidates: [...life.candidates, m.id] }); } },
          h("b", { text: m.name }), h("small", { text: m.lines })))));
    } });
  main.append(h("section", { class: "card" },
    h("h2", { text: "候補の駅" }),
    h("div", { class: "candchips" }, cands.map((m) => h("button", { type: "button", class: "chip", style: "--c:var(--accent)",
      onclick: () => app.save({ ...life, candidates: life.candidates.filter((x) => x !== m.id) }), text: `${m.name} ×` }))),
    h("div", { class: "row" }, input), sugg));

  // 3. 比べる
  const targets = found.filter((p) => p.weight !== "0" && !p.home);
  const home = found.find((p) => p.home);
  const cols = [...(home ? [{ name: "今の家", lat: home.lat, lng: home.lng }] : []),
    ...cands.map((m) => ({ name: m.name, ...geo.center(m) }))];
  if (!cols.length || !targets.length) {
    main.append(h("p", { class: "empty", text: "候補の駅を足すと、ここに比較の表が出ます。" }));
    return;
  }
  const cell = (c, p) => {
    const d = geo.distance(c.lat, c.lng, p.lat, p.lng) / 1000;
    return { d, min: minutes(d, speed) };
  };
  // 月あたりの移動時間の目安 ＝ Σ（往復の時間 × その場所に行く日数／月 × 大事さ）
  const monthly = cols.map((c) => targets.reduce((s, p) => s + cell(c, p).min * 2 * (p.days / months) * Number(p.weight), 0) / 60);
  const bestCol = monthly.indexOf(Math.min(...monthly));
  main.append(h("section", { class: "card" },
    h("h2", { text: "比べる" }),
    h("div", { class: "tablewrap" }, h("table", { class: "dist life" },
      h("thead", {}, h("tr", {}, h("th", { text: "行き先" }), cols.map((c) => h("th", { text: c.name })))),
      h("tbody", {},
        targets.map((p) => {
          const cs = cols.map((c) => cell(c, p));
          const minI = cs.indexOf(cs.reduce((a, b) => (b.min < a.min ? b : a)));
          return h("tr", {}, h("td", { text: p.name || life.addr?.[akey(p)] || `${nearSt(p)?.name || ""}付近` }),
            cs.map((x, i) => h("td", { class: i === minI ? "best" : "", text: `${x.min}分` }, h("small", { text: `${km(x.d)}km` }))));
        }),
        h("tr", { class: "sumrow" }, h("td", { text: "月の移動時間（重み付き）" }),
          monthly.map((v, i) => h("td", { class: i === bestCol ? "best" : "", text: `${Math.round(v)}時間` })))))),
    h("p", { class: "muted", text: `時間は目安です：駅まで歩く・待つ10分＋直線距離×1.3÷あなたの電車のふだんの速さ（記録から時速${Math.round(speed)}km）。乗り換えの回数や本数は見ていません。月の移動時間は「往復×月に行く日数×大事さ（少し1・普通2・大事3）」の合計です。` })));
}
