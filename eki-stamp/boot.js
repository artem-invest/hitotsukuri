// 起動の目印：どこまで進んだかを localStorage（eki.bootlog）と「読み込んでいます…」の横に残す
// スマホでだけ最初の画面が出ない不具合（2026-10-14）の原因を探すため。診断ページ（../diag.html）からも読める
const t0 = performance.now();
export function boot(step) {
  const ms = Math.round(performance.now() - t0);
  try {
    const log = JSON.parse(sessionStorage.getItem("eki.bootlog.cur") || "[]");
    log.push(`${step} ${ms}ms`);
    sessionStorage.setItem("eki.bootlog.cur", JSON.stringify(log));
    localStorage.setItem("eki.bootlog", JSON.stringify(log.slice(-30)));
  } catch {}
  const m = document.getElementById("main");
  const p = m && m.querySelector(".empty");
  if (p && p.textContent.startsWith("読み込んでいます")) p.textContent = `読み込んでいます…（${step}）`;
}
// このファイルが動いた＝アプリの部品が全部そろって、組み立てが始まった
boot("部品がそろった");
