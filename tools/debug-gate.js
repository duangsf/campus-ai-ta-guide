/* 诊断脚本：打印代表性问题的分词、改写、覆盖率与闸门判定。
 * 用途：定位"为什么这个问题被放行/被拦截"，用数据而不是靠猜。
 * 用法：node tools/debug-gate.js
 */
"use strict";
const rag = require("../src/rag.js");

const CASES = [
  /* 应当放行 */
  "图书馆几点开门",
  "寝室能洗澡不，有热水么",
  "饭堂几点开饭",
  "心情特别差，晚上睡不着",
  "从宿舍出发最近的自习室在哪里",
  "家里条件不好，学费交不上咋整",
  "挂科了怎么办",
  /* 应当拦截 */
  "食堂三楼川菜窗口的招牌菜是什么",
  "明天兴安校区的天气怎么样",
  "帮我写一段 Python 快排代码",
  "我们学校校长的手机号是多少",
  "宿舍楼后面那棵树的树龄是多少年",
];

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };

CASES.forEach(q => {
  const r = rag.retrieveDetailed(q, { topK: 3 });
  console.log("");
  console.log("Q: " + q);
  console.log("  分词(" + r.tokenCount + "): " + r.tokens.slice(0, 16).join(" / "));
  console.log("  改写: " + r.rewritten.join(" ｜ "));
  console.log("  意图: " + r.intent + "   OOS: " + (r.outOfScope ? r.oosLabel : "否"));
  console.log("  文档覆盖 " + pad(r.docCoverage, 6) + " 词表覆盖 " + pad(r.vocabCoverage, 6)
    + " 聚合 " + pad(r.aggregate, 6) + " 置信 " + pad(r.confidence, 6) + " 阈值 " + r.threshold);
  console.log("  未覆盖词: " + ((r.uncoveredTerms || []).join("、") || "（无）"));
  console.log("  Top3: " + r.top.map(t => t.id + "(" + t.score + ")").join(", "));
  console.log("  判定: " + (r.pass ? "✅ 放行" : "⛔ 拦截") + "  " + (r.gateReason || ""));
});
console.log("");
