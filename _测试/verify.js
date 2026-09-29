/* ============================================================
 * v2 · 交付前完整性校验（不需要服务运行）
 *
 * 检查项：
 *   ① 所有前端 JS 语法可解析
 *   ② index.html 引用的每个本地资源都真实存在
 *   ③ 前端引用的 DOM id 在后端 HTML 里存在（防止改 HTML 忘了改 JS）
 *   ④ 服务端模块可正常加载
 *   ⑤ 数据文件结构完整
 *   ⑥ 指标口径一致：标定阈值 == 运行时阈值，评测集/图谱/场所规模达标
 *
 * 用法：node _测试\verify.js
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const failures = [];
function T(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log("  ✗ " + name + "\n      → " + e.message); }
}
function group(t) { console.log("\n" + t); }

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/**
 * 语法检查：交给 Node 自己判断，而不是用正则剥掉 import/export。
 * 后者会破坏 `export function foo() {` 这类跨行结构，产生假失败。
 * 写法：把源码写成 .mjs 临时文件后执行 `node --check`，ES Module 语法由官方解析器裁决。
 */
function checkSyntax(src, label) {
  const tmp = path.join(os.tmpdir(), "v2check-" + Math.random().toString(36).slice(2) + ".mjs");
  fs.writeFileSync(tmp, src, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    throw new Error(label + " 语法错误：\n        " + msg.split("\n").slice(0, 6).join("\n        "));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
  }
}

/* ══════════ ① 前端 JS 语法 ══════════ */
group("① 前端模块语法");

const jsDir = path.join(ROOT, "js");
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith(".js"));
jsFiles.forEach(f => {
  T("语法可解析：js/" + f, () => {
    checkSyntax(fs.readFileSync(path.join(jsDir, f), "utf8"), f);
  });
});

T("src/rag.js 语法可解析（UMD 同构文件）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "rag.js"), "utf8");
  new vm.Script(src);
});

/* ══════════ ② 引用资源存在 ══════════ */
group("② index.html 引用的资源");

const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
  .filter(u => !/^https?:|^#|^data:/.test(u));

T("共 " + refs.length + " 个本地引用全部存在", () => {
  const missing = [];
  refs.forEach(u => {
    /* 统一按"HTML 所在目录"解析（浏览器语义），因此基准是 ROOT。
       /assets/* 也落在代码目录内（ROOT/assets），不再指向外部目录。 */
    let p;
    if (u.startsWith("/assets/")) {
      p = path.join(ROOT, "assets", decodeURIComponent(u.slice("/assets/".length)));
    } else if (u.startsWith("/")) {
      p = path.join(ROOT, u.slice(1).split("?")[0]);
    } else {
      p = path.resolve(ROOT, u.split("?")[0]);
    }
    if (!fs.existsSync(p)) missing.push(u + " → " + p);
  });
  if (missing.length) throw new Error("缺失引用：\n        " + missing.join("\n        "));
});

T("前端引用统一使用根路径（不再出现 ../ 相对写法）", () => {
  const bad = refs.filter(u => u.indexOf("../") >= 0);
  if (bad.length) throw new Error("仍存在相对越界引用：" + bad.join(", "));
});

T("前端引用的 DOM id 都存在于 HTML", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const missing = new Set();
  jsFiles.forEach(f => {
    const src = fs.readFileSync(path.join(jsDir, f), "utf8");
    /* 匹配 $("xxx") 与 getElementById("xxx") 两种写法 */
    [...src.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].forEach(m => {
      if (!htmlIds.has(m[1])) missing.add(m[1] + "  (js/" + f + ")");
    });
    [...src.matchAll(/getElementById\("([A-Za-z][\w-]*)"\)/g)].forEach(m => {
      if (!htmlIds.has(m[1])) missing.add(m[1] + "  (js/" + f + ")");
    });
  });
  /* 动态创建的元素 id（如看板/评测面板里的容器）不算缺失 */
  const dynamic = new Set(["intentChart", "hourChart", "scoreChart", "latChart",
    "evalGroupChart", "evalBarChart", "stQuestions", "stSessions", "stHitRate",
    "stFallback", "stFirst", "stFirst2", "stTotal", "stCare", "stSat", "clearRouteBtn",
    "navFromGate", "navFromDorm", "graphMeta"]);
  const real = [...missing].filter(m => !dynamic.has(m.split("  ")[0]));
  if (real.length) throw new Error("HTML 中不存在的 id：\n        " + real.join("\n        "));
});

/* ══════════ ③ 服务端模块 ══════════ */
group("③ 服务端模块");

["server/db.js", "server/llm.js", "src/rag.js", "src/eval.js"].forEach(m => {
  T("可加载：' + m + '", () => {
    const full = path.join(ROOT, m);
    new vm.Script(fs.readFileSync(full, "utf8"));
  });
});

T("llm.js 导出流式接口与重试上限", () => {
  const llm = require(path.join(ROOT, "server", "llm.js"));
  if (typeof llm.streamChat !== "function") throw new Error("缺少 streamChat");
  if (typeof llm.MAX_ATTEMPTS !== "number" || llm.MAX_ATTEMPTS < 2) throw new Error("重试上限异常：" + llm.MAX_ATTEMPTS);
});

T("db.js 具备自动迁移能力（旧库可平滑升级）", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "db.js"), "utf8");
  if (!/function migrate\(/.test(src)) throw new Error("未找到 migrate()");
  if (!/PRAGMA table_info/.test(src)) throw new Error("未使用 PRAGMA 探测列");
  if (!/latency_answer/.test(src)) throw new Error("缺少 latency_answer 列定义");
});

T("server.js 未硬编码任何 API Key", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  if (/ark-[a-z0-9-]{20,}/i.test(src)) throw new Error("server.js 中出现疑似硬编码 Key");
});

T("index.html 未硬编码任何 API Key", () => {
  if (/ark-[a-z0-9-]{20,}/i.test(html)) throw new Error("index.html 中出现疑似硬编码 Key");
});

/* ══════════ ④ 数据完整性 ══════════ */
group("④ 数据文件");

const DATA = ["graph.json", "places.json", "corpus.json", "forms.json", "departments.json", "eval-set.json", "calibration.json"];
DATA.forEach(f => {
  T("存在且可解析：data/" + f, () => {
    const p = path.join(ROOT, "data", f);
    if (!fs.existsSync(p)) throw new Error("文件不存在");
    JSON.parse(fs.readFileSync(p, "utf8"));
  });
});

T("浏览器数据桥接文件与 JSON 同步生成", () => {
  DATA.filter(f => f !== "calibration.json").forEach(f => {
    const js = path.join(ROOT, "data", f.replace(/\.json$/, ".js"));
    if (!fs.existsSync(js)) throw new Error("缺少桥接文件 " + path.basename(js) + "（请运行 node tools/build-data.js）");
  });
});

T("语料桥接内容与 corpus.json 条目数一致", () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "corpus.json"), "utf8"));
  const js = fs.readFileSync(path.join(ROOT, "data", "corpus.js"), "utf8");
  const m = js.match(/window\.V2_CORPUS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error("无法解析桥接文件");
  const arr = JSON.parse(m[1]);
  if (arr.length !== json.entries.length) throw new Error("条目数不一致：" + arr.length + " vs " + json.entries.length);
});

T("图谱结构完整（实体含 id/name/type，关系含 from/to/rel）", () => {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "graph.json"), "utf8"));
  g.entities.forEach(e => { if (!e.id || !e.name || !e.type) throw new Error("实体缺字段：" + JSON.stringify(e)); });
  const ids = new Set(g.entities.map(e => e.id));
  g.relations.forEach(r => {
    if (!r.from || !r.to || !r.rel) throw new Error("关系缺字段：" + JSON.stringify(r));
    if (!ids.has(r.from) || !ids.has(r.to)) throw new Error("关系指向不存在的实体：" + r.from + "→" + r.to);
  });
});

T("场所结构完整（含坐标与开放时段）", () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8"));
  p.places.forEach(x => {
    if (typeof x.x !== "number" || typeof x.y !== "number") throw new Error(x.name + " 缺少坐标");
    if (!Array.isArray(x.hours) || !x.hours.length) throw new Error(x.name + " 缺少开放时段");
    x.hours.forEach(h => {
      if (!/^\d{2}:\d{2}$/.test(h.open) || !/^\d{2}:\d{2}$/.test(h.close)) {
        throw new Error(x.name + " 时段格式错误：" + h.open + "-" + h.close);
      }
    });
  });
});

/* ══════════ ⑤ 指标口径一致性 ══════════ */
group("⑤ 指标口径一致性");

T("运行时阈值 == 标定推荐阈值", () => {
  const rag = require(path.join(ROOT, "src", "rag.js"));
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "calibration.json"), "utf8"));
  if (rag.DEFAULT_THRESHOLD !== cal.best.hybrid.threshold) {
    throw new Error("运行时 " + rag.DEFAULT_THRESHOLD + " ≠ 标定 " + cal.best.hybrid.threshold + "（请重跑 tools/calibrate.js）");
  }
});

T("索引规模达标", () => {
  const rag = require(path.join(ROOT, "src", "rag.js"));
  const s = rag.indexStats();
  if (s.entries < 100) throw new Error("知识条目仅 " + s.entries);
  if (s.corpus < 50) throw new Error("语料条目仅 " + s.corpus + "（语料可能未进入索引）");
  if (s.entities < 50 || s.relations < 60) throw new Error("图谱规模不足");
  if (s.places < 20) throw new Error("场所数量不足");
});

T("评测集规模与标注完整", () => {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "eval-set.json"), "utf8"));
  if (set.questions.length < 50) throw new Error("评测集仅 " + set.questions.length + " 题");
  const refuse = set.questions.filter(q => q.expectNoAnswer);
  if (refuse.length < 6) throw new Error("应拒答样本仅 " + refuse.length + " 题");
  set.questions.forEach(q => {
    if (!q.expectNoAnswer && (!Array.isArray(q.goldKeywords) || !q.goldKeywords.length)) {
      throw new Error(q.id + " 既未标注 goldKeywords 也未标 expectNoAnswer");
    }
  });
});

/* 原先这里断言"v1 稳定版本仍在上级目录可运行"。
   代码目录已独立出来、v1 亦已下线，该断言不再成立，改为校验本项目自包含：
   assets/ 必须随目录一起分发，否则数字人立绘会 404。 */
T("资源自包含（assets/ 随代码目录分发）", () => {
  ["数字人_小岚.png", "数字人_小航.png"].forEach(f => {
    const p = path.join(ROOT, "assets", f);
    if (!fs.existsSync(p)) throw new Error("assets 缺失：" + f);
  });
});

console.log("");
console.log("  ────────────────────────────────────────────");
console.log("  完整性校验：" + pass + " 通过，" + fail + " 失败 " + (fail ? "❌" : "✅"));
if (fail) {
  console.log("");
  failures.forEach(f => console.log("   · " + f.name + "\n     " + f.msg));
}
console.log("");
process.exit(fail ? 1 : 0);
