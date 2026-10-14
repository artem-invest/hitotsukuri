// 公開（push）の前に回す点検
//   node tools/check.mjs
// 1. eki-stamp の .js がすべて構文として読めるか
// 2. 計算の自動テスト（tools/test_calc.mjs）
// 3. アプリのファイルが sw.js の SHELL（オフライン用にしまう一覧）に全部載っているか・載っているファイルが実在するか
// 4. 公開中（origin/main）からアプリを変えたのに sw.js の VERSION を上げ忘れていないか（上げないとスマホに古い版が残る）
import { readFileSync, readdirSync, existsSync } from "fs";
import { execSync, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "eki-stamp");
let ng = 0;
const say = (ok, msg) => { if (!ok) ng++; console.log(`${ok ? "OK" : "NG"}  ${msg}`); };

// 1
for (const f of readdirSync(app).filter((f) => f.endsWith(".js"))) {
  const r = spawnSync(process.execPath, ["--check", path.join(app, f)], { encoding: "utf8" });
  if (r.status) say(false, `構文：${f}\n${r.stderr}`);
}
say(true, "構文（エラーがあれば上に出ています）");

// 2
const t = spawnSync(process.execPath, [path.join(root, "tools", "test_calc.mjs")], { encoding: "utf8" });
say(t.status === 0, `計算のテスト${t.status ? "\n" + t.stdout : ""}`);

// 3
const sw = readFileSync(path.join(app, "sw.js"), "utf8");
const shell = [...sw.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
const own = readdirSync(app).filter((f) => /\.(js|json|html|webmanifest)$/.test(f) && f !== "sw.js");
const missing = own.filter((f) => !shell.includes(f));
say(!missing.length, `SHELL の登録漏れ${missing.length ? "：" + missing.join("・") : "なし"}`);
const ghost = shell.filter((f) => !existsSync(path.join(app, f)));
say(!ghost.length, `SHELL にあるのに無いファイル${ghost.length ? "：" + ghost.join("・") : "なし"}`);

// 4
const ver = (s) => (s.match(/const VERSION = "([^"]+)"/) || [])[1];
try {
  const changed = execSync("git diff --name-only origin/main -- eki-stamp", { cwd: root, encoding: "utf8" }).trim();
  const pub = ver(execSync("git show origin/main:eki-stamp/sw.js", { cwd: root, encoding: "utf8" }));
  const now = ver(sw);
  say(!changed || now !== pub, changed ? `版：公開中 ${pub} → 今 ${now}${now === pub ? "（アプリを変えたのに上げていません）" : ""}` : "版：アプリの変更なし");
} catch (e) { say(false, "版：origin/main と比べられませんでした " + e.message); }

console.log(ng ? `\n要対応 ${ng}件` : "\n公開してよい状態です");
process.exit(ng ? 1 : 0);
