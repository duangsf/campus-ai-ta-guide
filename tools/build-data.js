/* ============================================================
 * v2 · 数据桥接构建脚本
 *
 * 问题：Node 端用 require/JSON.parse 读 data/*.json；
 *       浏览器不能直接读本地文件（file:// 与静态服务下的 fetch 行为不一致，
 *       且直接双击打开 index.html 时 fetch 会被 CORS 拦截）。
 *
 * 方案：把每个 JSON 包一层"挂到全局变量"的 JS 文件（data/*.js），
 *       浏览器用 <script> 顺序加载即可，无需 fetch、无需构建工具、离线可用。
 *       src/rag.js 是同一份代码，按运行环境自动选择数据来源 ——
 *       所以"界面上看到的检索过程"就是"服务端真实的检索过程"。
 *
 * 用法：node tools/build-data.js
 *      （修改 data/*.json 后需重新运行）
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

const FILES = [
  { json: "graph.json", global: "V2_GRAPH" },
  { json: "places.json", global: "V2_PLACES" },
  { json: "corpus.json", global: "V2_CORPUS", arrayKey: "entries" },
  { json: "forms.json", global: "V2_FORMS" },
  { json: "departments.json", global: "V2_DEPTS" },
  { json: "eval-set.json", global: "V2_EVAL_SET", arrayKey: "questions" },
];

const BANNER = "/* 本文件由 tools/build-data.js 从 {JSON} 自动生成，请勿手工编辑。 */\n";

let count = 0;
FILES.forEach(f => {
  const src = path.join(DATA_DIR, f.json);
  if (!fs.existsSync(src)) { console.warn("  跳过（不存在）: " + f.json); return; }
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  /* corpus / eval-set 在 rag.js 里按数组使用，这里直接导出数组并附上 meta */
  const payload = f.arrayKey ? (raw[f.arrayKey] || []) : raw;
  let text = BANNER.replace("{JSON}", f.json);
  text += "window." + f.global + " = " + JSON.stringify(payload, null, 0) + ";\n";
  if (f.arrayKey && raw.meta) {
    text += "window." + f.global + "_META = " + JSON.stringify(raw.meta, null, 0) + ";\n";
  }
  const out = path.join(DATA_DIR, f.json.replace(/\.json$/, ".js"));
  fs.writeFileSync(out, text, "utf8");
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  const size = Array.isArray(payload) ? payload.length + " 项" : Object.keys(payload).length + " 键";
  console.log("  ✓ " + f.json.padEnd(20) + " → " + path.basename(out).padEnd(20) + kb.padStart(8) + " KB   (" + size + ")");
  count++;
});

console.log("");
console.log("  数据桥接完成：" + count + " 个文件。浏览器端可直接用 <script> 加载，离线可用。");
console.log("");
