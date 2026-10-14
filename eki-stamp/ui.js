// 画面づくりの小道具（どの画面からも使う）
export const $ = (s) => document.querySelector(s);

// h("div", {class: "x", onclick: f}, 子要素...) で要素を作る。文字は text で渡す（HTMLとして解釈しない）
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}

const pad = (n) => String(n).padStart(2, "0");
export const md = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const ymd = (iso) => { const d = new Date(iso); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const WD = "日月火水木金土";
// 曜日つき：2026年7月2日（木）。"YYYY-MM-DD" だけを渡されたら、その土地の正午として読む（UTCで1日ずれないように）
const asDate = (x) => new Date(/^\d{4}-\d\d-\d\d$/.test(x) ? x + "T12:00" : x);
export const ymdw = (x) => { const d = asDate(x); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
export const mdw = (x) => { const d = asDate(x); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
export const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const today = () => localDay(new Date().toISOString());
export const meters = (d) => (d < 1000 ? `${Math.round(d / 10) * 10}m` : `${(d / 1000).toFixed(1)}km`);
export const km = (v) => (v >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());

export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}
