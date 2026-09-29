/* ============================================================
 * v2 · 置信度公式参数扫描
 *
 * 背景：闸门置信度由"检索强度 × 覆盖率聚合"构成，其行为取决于两个设计选择：
 *   ① 聚合方式：min（取小）还是几何平均（geo）
 *   ② 长度归一化指数 pow：coverage / n^pow
 * 手调参数很容易顾此失彼（松了开始编造、紧了把能答的也拒掉），
 * 因此这里做联合网格扫描，用评测集直接量化每组参数"能达到的最好水平"，
 * 从而做出可辩护的选择而不是拍脑袋。
 *
 * 关键实现细节：必须使用 rag 返回的**原始覆盖率**（cov.raw）重新聚合。
 * 若直接拿已经归一化过的 docCoverage/vocabCoverage 再除一次长度，
 * 就会重复归一化，得到"召回率 0%"这种明显错误的结论。
 *
 * 用法：node tools/tune-gate.js
 * ============================================================ */
"use strict";

const rag = require("../src/rag.js");
const { loadSet, resolveGold } = require("../src/eval.js");

const { questions } = loadSet("full");
const entries = rag.entries();
const goldById = new Map();
questions.forEach(q => {
  goldById.set(q.id, q.expectNoAnswer ? null : resolveGold(q, entries));
});

/** 用指定参数重算置信度 */
function confidenceWith(query, entry, rawTopScore, pow, mode, tokenCount) {
  const cov = rag.coverageGate(query, entry || { q: "", k: [], a: "", cat: "" });
  const scale = (v) => v / Math.pow(Math.max(tokenCount, 1), pow);
  const docC = scale(cov.raw.doc);
  const vocC = scale(cov.raw.vocab);
  const agg = mode === "min"
    ? Math.min(docC, vocC)
    : Math.sqrt(Math.max(docC, 0) * Math.max(vocC, 0));
  const scorePart = 0.55 + 0.45 * Math.min(1, (rawTopScore == null ? 0.9 : rawTopScore) / 0.9);
  return Math.max(0, Math.min(1, scorePart * agg));
}

function evaluate(pow, mode) {
  const rows = [];
  questions.forEach(q => {
    const r = rag.retrieveDetailed(q.q, { topK: 5 });
    const tokens = rag.tokenizeDetailed(q.q, { dict: rag._state.dict });
    const conf = confidenceWith(q.q, r.top[0] ? r.top[0].entry : null, r.topScore, pow, mode, tokens.length);
    if (q.expectNoAnswer) {
      rows.push({ conf, shouldAnswer: false, rank: null });
    } else {
      const gold = goldById.get(q.id) || new Set();
      let rank = null;
      for (let i = 0; i < r.top.length; i++) if (gold.has(r.top[i].id)) { rank = i + 1; break; }
      rows.push({ conf, shouldAnswer: true, rank });
    }
  });

  const unanswerable = rows.filter(r => !r.shouldAnswer).length;
  const answerable = rows.length - unanswerable;

  let best = null;
  const curve = [];
  for (let t = 0.04; t <= 0.96; t += 0.02) {
    const th = +t.toFixed(2);
    let tp = 0, fp = 0, fn = 0, tn = 0;
    rows.forEach(r => {
      const answered = r.conf >= th;
      if (r.shouldAnswer) {
        if (answered && r.rank != null) tp++;
        else if (answered) fp++;
        else fn++;
      } else {
        if (answered) fp++; else tn++;
      }
    });
    const spec = unanswerable ? tn / unanswerable : 1;
    const recall = answerable ? tp / answerable : 0;
    const precision = (tp + fp) ? tp / (tp + fp) : 0;
    const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
    const cand = { th, spec: +(spec * 100).toFixed(1), recall: +(recall * 100).toFixed(1), f1: +(f1 * 100).toFixed(1), precision: +(precision * 100).toFixed(1) };
    curve.push(cand);
    /* 目标：兜底准确率 ≥ 95%（防幻觉红线）的前提下，最大化可答题召回 */
    if (spec >= 0.95) {
      if (!best || cand.recall > best.recall || (cand.recall === best.recall && cand.f1 > best.f1)) best = cand;
    }
  }
  return { pow, mode, best, curve, answerable, unanswerable };
}

console.log("");
console.log("  置信度公式参数联合扫描（评测集 " + questions.length + " 题）");
console.log("  目标：兜底准确率 ≥ 95% 时，最大化可答题召回率");
console.log("  ────────────────────────────────────────────────────────────────────────");
console.log("  归一化指数   聚合方式     最优阈值   召回率    准确率    兜底准确率   F1");
const results = [];
[0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40].forEach(pow => {
  ["min", "geo"].forEach(mode => {
    const r = evaluate(pow, mode);
    results.push(r);
    const b = r.best;
    console.log("  " + String(pow).padEnd(13) + mode.padEnd(13) +
      (b ? String(b.th).padEnd(11) + String(b.recall + "%").padEnd(10) + String(b.precision + "%").padEnd(10) + String(b.spec + "%").padEnd(12) + b.f1 + "%"
        : "（无法达到 95% 兜底准确率）"));
  });
});
console.log("");

const ok = results.filter(r => r.best);
if (!ok.length) {
  console.log("  ⚠ 所有参数组合都无法在兜底准确率 ≥95% 时回答问题，说明混淆矩阵有误或覆盖率判据失效。");
} else {
  const pick = ok.slice().sort((a, b) => (b.best.recall - a.best.recall) || (b.best.f1 - a.best.f1))[0];
  console.log("  推荐参数：归一化指数 " + pick.pow + " · 聚合方式 " + pick.mode);
  console.log("    → 阈值 " + pick.best.th + "，可答召回 " + pick.best.recall + "%，兜底准确率 " + pick.best.spec + "%，F1 " + pick.best.f1 + "%");
}
console.log("");
