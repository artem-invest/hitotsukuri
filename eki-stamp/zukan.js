// 図鑑：行った駅・施設の判子・詳しいシート・行った順・手で足す
import * as db from "./db.js";
import * as geo from "./geo.js";
import * as rd from "./roads.js";
import { $, h, md, ymdw, localDay, meters, toast } from "./ui.js";
import { S, visitsOf, isSpot, HOW, loadInBackground, needFind, needMaster, daysVisited } from "./state.js";
import { addVisit, removeVisit, removeStation, ensureStation } from "./data.js";
import { renderConfirm } from "./home.js";
import { openDay } from "./mapview.js";
import { openFind, itemOfStation } from "./find.js";

const INKS = ["#d0472f", "#3f6fc4", "#3a9a62", "#9a5bb3", "#c7772a"]; // 判子のインク（明暗どちらの地でも読める中間の濃さ）
function hash(s) { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n; }
const inkOf = (id) => INKS[hash(id) % INKS.length];
const tiltOf = (id) => (hash(id + "t") % 21) - 10; // -10〜+10度

// 判子1つ。×の数は「行った日数」（記録した日＋タイムラインで乗り降り・立ち寄りした日）
function stampButton(s) {
  const vs = visitsOf(s.id);
  const on = vs.length > 0;
  const n = on ? daysVisited(s).size : 0;
  return h("button", {
    type: "button",
    class: "stamp" + (on ? " on" : "") + (isSpot(s) ? " spot" : ""),
    style: on ? `--ink:${inkOf(s.id)};--tilt:${tiltOf(s.id)}deg` : "",
    "aria-label": `${s.name}${on ? `（${n}日）` : "（まだ）"}`,
    onclick: () => openSheet(s),
  },
    h("span", { class: "nm", text: s.name }),
    isSpot(s) ? h("small", { text: rd.KINDS[s.kind].label }) : (s.area || s.lines) ? h("small", { text: s.area || s.lines.split("・")[0] }) : null,
    on ? h("small", { class: "dt", text: md(vs[0].at) }) : null,
    n > 1 ? h("span", { class: "times", text: `×${n}` }) : null,
  );
}

export function renderZukan(main) {
  main.append(renderConfirm() || "");
  // 行った日数はタイムラインから数える。計算がまだなら裏で済ませて1回だけ描き直す（それまでは記録した日だけ）
  if (S.dayKeys.length) loadInBackground("find", needFind, () => !!S.findIdx);
  const mine = S.stations.filter((s) => visitsOf(s.id).length);
  if (!mine.length) {
    main.append(h("p", { class: "empty", text: "まだありません。タイムラインを読み込むか、駅で「今いる場所を記録する」を押すと、初めて行った駅や施設がここに並びます。" }));
  } else {
    const last = (s) => visitsOf(s.id).at(-1).at; // 最近行った順
    const list = mine.sort((a, b) => last(b).localeCompare(last(a)));
    const groups = [["駅", list.filter((s) => !isSpot(s))],
      ...Object.entries(rd.GROUPS).map(([g, label]) => [label, list.filter((s) => rd.KINDS[s.kind]?.group === g)])];
    for (const [label, items] of groups) {
      if (items.length) main.append(h("h2", { class: "gridhead", text: `${label} ${items.length}` }), h("div", { class: "grid" }, items.map(stampButton)));
    }
    main.append(h("p", { class: "hint", text: "判子の日付は初めて行った日、×は行った日数（タイムラインで乗り降り・立ち寄りした日も数えます）。右上の🔍で、まだ図鑑に無い場所もさがせます。" }));
  }
  // 手で足す：打つと全国の駅から候補が出る
  const sugg = h("ul", { class: "sugg" });
  const name = h("input", { name: "name", placeholder: "駅名（例：吉祥寺）", required: true, autocomplete: "off", enterkeyhint: "done",
    oninput: async () => {
      const q = name.value;
      try { await needMaster(); } catch { return; }
      if (name.value !== q) return;
      sugg.replaceChildren(...geo.search(S.master, q).map((m) => h("li", {},
        h("button", { type: "button", onclick: async () => { await addVisit(await ensureStation(m)); name.value = ""; sugg.replaceChildren(); } },
          h("b", { text: m.name }), h("small", { text: m.lines })))));
    } });
  main.append(h("details", { class: "add" },
    h("summary", { text: "記録に残っていない駅を手で足す（今日の日付）" }),
    h("div", { class: "row" }, name), sugg,
    h("p", { class: "muted", text: "候補をタップすると、今日の日付で記録されます。過去の日付で入れたいときは🔍でさがして「行った」を押してください。" })));
  const log = h("details", { class: "add" }, h("summary", { text: "行った順に見る" }));
  main.append(log);
  log.addEventListener("toggle", () => { if (log.open && log.children.length === 1) renderLog(log); });
}

function renderLog(box) {
  if (!S.visits.length) { box.append(h("p", { class: "empty", text: "まだ記録がありません。" })); return; }
  const byId = Object.fromEntries(S.stations.map((s) => [s.id, s]));
  let month = "";
  const list = h("ol", { class: "log" });
  for (const v of [...S.visits].sort((a, b) => b.at.localeCompare(a.at))) {
    const d = new Date(v.at);
    const m = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (m !== month) { month = m; list.append(h("li", { class: "month", text: m })); }
    const s = byId[v.stationId];
    list.append(h("li", { class: "row", style: `--ink:${inkOf(v.stationId)}` },
      h("span", { class: "d", text: md(v.at) }),
      h("span", { class: "n", text: s ? s.name : "（削除した駅）" }),
      h("span", { class: "w", text: HOW[v.how] || "" }),
      v.note ? h("span", { class: "nt", text: v.note }) : null));
  }
  box.append(list);
}

/* ---------- 図鑑の1枚（下から出るシート） ---------- */
export function openSheet(s) {
  const dlg = $("#sheet");
  const draw = () => {
    const vs = visitsOf(s.id);
    const tlDays = [...daysVisited(s)].filter((d) => !vs.some((v) => localDay(v.at) === d));
    const delBtn = h("button", { type: "button", class: "danger", text: "図鑑から消す",
      onclick: async () => {
        if (delBtn.dataset.armed) { dlg.close(); await removeStation(s); return; }
        delBtn.dataset.armed = "1"; delBtn.textContent = "もう一度押すと削除（記録も消えます）";
      } });
    dlg.replaceChildren(h("div", { class: "sheet" },
      h("header", {},
        h("h2", { text: s.name }),
        h("button", { type: "button", class: "close", "aria-label": "閉じる", text: "×", onclick: () => dlg.close() })),
      h("p", { class: "muted", text: [isSpot(s) ? rd.KINDS[s.kind].label : "", s.area, s.lines].filter(Boolean).join("・") }),
      h("button", { type: "button", class: "primary big", text: "今日ここに来た", onclick: async () => { await addVisit(s); draw(); } }),
      vs.length
        ? h("ol", { class: "visits" }, vs.map((v) => {
            const undo = h("button", { type: "button", class: "small", text: "取り消す",
              onclick: async () => {
                if (undo.dataset.armed) { await removeVisit(v); draw(); return; }
                undo.dataset.armed = "1"; undo.textContent = "本当に？";
              } });
            const acc = v.how === "gps" && v.acc != null ? ` ±${meters(v.acc)}` : "";
            const day = localDay(v.at);
            const note = h("input", { class: "note", value: v.note || "", placeholder: "一言（例：家族で。黒湯がよかった）", maxlength: 120,
              onchange: async () => { v.note = note.value.trim(); await db.put("visits", v); toast("一言を残しました"); } });
            return h("li", { class: "visit" },
              h("div", { class: "vrow" },
                h("span", { text: `${ymdw(day)}（${HOW[v.how] || ""}${acc}）` }),
                S.dayKeys.includes(day) ? h("button", { type: "button", class: "small", text: "その日のルート", onclick: () => openDay(day, s, () => openSheet(s)) }) : null,
                undo),
              note);
          }))
        : h("p", { class: "muted", text: "まだ記録はありません。" }),
      tlDays.length
        ? h("p", {}, `ほかにタイムラインで ${tlDays.length}日 行っています。`,
            h("button", { type: "button", class: "linkish", text: "日付を見る", onclick: () => openFind(itemOfStation(s)) }))
        : null,
      h("p", { class: "links" },
        s.lat != null ? h("a", { href: `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`, target: "_blank", rel: "noopener", text: "地図で見る" }) : null,
        s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", text: "駅のページ" }) : null),
      h("div", { class: "foot" }, delBtn)));
  };
  draw();
  if (!dlg.open) dlg.showModal();
}
