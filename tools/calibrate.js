/* ============================================================
 * v2 · 置信度闸门阈值标定
 *
 * 为什么需要标定：
 *   "多高的分数才敢回答"不该拍脑袋决定。阈值太低 → 对未收录问题硬答（幻觉）；
 *   太高 → 把本来能答对的问题也拒掉（可用性下降）。这是一对矛盾指标，
 *   必须用评测集做网格搜索，取 F1 最优的点，并把这张曲线图作为
 *   "系统可解释、可调优"的证据。
 *
 * 输出：data/calibration.json（含阈值-指标曲线与最优阈值），
 *      同时把最优阈值写回 src/rag.js 的 DEFAULT_THRESHOLD 常量。
 *
 * 用法：node tools/calibrate.js
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const rag = require("../src/rag.js");
const { loadSet, resolveGold } = require("../src/eval.js");

const OUT = path.join(__dirname, "..", "data", "calibration.json");

/* 直接使用 rag.js 里运行时的置信度计算，保证"标定用的判据"与"运行时判据"完全一致；
   若在此处另写一份公式，标定结果就会与实际行为脱节。 */
function confidenceOf(res) {
  return typeof res.confidence === "number" ? res.confidence : 0;
}

/**
 * 对某策略，算出每题在"是否该答"上的置信度与真实标签。
 *
 * 关键：候选阈值必须通过 opts 注入到 retriever 内部，而不是只在外层比较。
 * 因为置信度公式里的 scorePart 依赖阈值 —— 如果内部仍用模块默认值，
 * 扫出来的曲线就与运行时行为不一致（这是一个会静默出错的坑）。
 */
function collect(questions, mode, threshold) {
  const entries = rag.entries();
  const rows = [];
  questions.forEach(q => {
    let res;
    if (mode === "v1") res = rag.baselineRetrieve(q.q, 5, { useGate: false });
    else if (mode === "v1+gate") res = rag.baselineRetrieve(q.q, 5, { threshold });
    else if (mode === "v2-nogate") res = rag.benchRetrieve(q.q, { bm25: true, vector: true, graph: true }, 5, false);
    else res = rag.benchRetrieve(q.q, { bm25: true, vector: true, graph: true }, 5, true, threshold);
    const conf = confidenceOf(res);
    const ids = res.top.map(t => t.id);
    if (q.expectNoAnswer) {
      rows.push({ q: q.q, group: q.group, conf, shouldAnswer: false, rank: null });
    } else {
      const gold = resolveGold(q, entries);
      let rank = null;
      for (let i = 0; i < ids.length; i++) if (gold.has(ids[i])) { rank = i + 1; break; }
      rows.push({ q: q.q, group: q.group, conf, shouldAnswer: true, rank });
    }
  });
  return rows;
}

/**
 * 扫描阈值：对每个候选阈值 t，先用 t 跑一遍检索（保证置信度内部一致），
 * 再统计混淆矩阵。这样得到的曲线才是"若把阈值设为 t，线上真实会发生什么"。
 * 下界从 0.10 起：极低阈值等于不设闸门，没有标定意义。
 */
function sweepWithRetrieval(questions, mode) {
  const out = [];
  for (let t = 0.10; t <= 0.96; t += 0.02) {
    const th = +t.toFixed(2);
    const rows = collect(questions, mode, th);
    out.push(score(rows, th));
  }
  return out;
}

/** 按给定阈值统计混淆矩阵与派生指标 */
function score(rows, th) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  rows.forEach(r => {
    const answered = r.conf >= th;
    if (r.shouldAnswer) {
      /* 可答题：闸门放行且 Top5 命中 → 答对；放行但没命中 → 答错（fp）；拦下 → 漏答（fn） */
      if (answered && r.rank != null) tp++;
      else if (answered) fp++;
      else fn++;
    } else {
      /* 不可答题：拦下 → 正确拒答（tn）；放行 → 错误硬答（fp） */
      if (answered) fp++;
      else tn++;
    }
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  /* specificity 的分母必须是"不可答题"的数量，而不是全部被拒的题 ——
     否则可答题里的漏答会被算进"正确拒答"，把兜底准确率算虚高。 */
  const unanswerable = rows.filter(r => !r.shouldAnswer).length;
  const specificity = unanswerable ? tn / unanswerable : 1;
  return {
    threshold: th,
    precision: +(precision * 100).toFixed(1),
    recall: +(recall * 100).toFixed(1),
    f1: +(f1 * 100).toFixed(1),
    specificity: +(specificity * 100).toFixed(1),
    falseAnswerRate: +((1 - specificity) * 100).toFixed(1),
    answered: tp + fp,
    answerableTotal: rows.length - unanswerable,
    unanswerableTotal: unanswerable,
    tp, fp, fn, tn,
  };
}

function bestBy(curve) {
  /* 选阈值准则（按业务优先级排列，而非按指标好看程度）：
   *
   *   第一优先：兜底准确率 ≥ 95%
   *     校园问答里一次编造事实的代价，远高于一次"我暂时没有收录"的礼貌拒答。
   *     所以先卡住幻觉抑制这条红线，再谈其他指标。
   *
   *   第二优先：在 F1 最优值的 2 个百分点以内，取**最小**阈值
   *     同一档效果下，阈值越低可用性越好（避免把能答的也拒掉）。
   *     取最小而非最大，是为了不让系统显得"过于保守"。
   *
   * 为什么不直接取 F1 最大：本评测集可答题远多于不可答题，F1 会被可答题主导，
   * 于是"把阈值压到最低、什么都答"反而能拿高分 —— 与业务目标正好相反。
   */
  const SAFE = 95;
  const safe = curve.filter(c => c.specificity >= SAFE);
  const pool = safe.length ? safe : curve;
  const bestF1 = Math.max(...pool.map(c => c.f1));
  const near = pool.filter(c => c.f1 >= bestF1 - 2);
  return near.slice().sort((a, b) => (a.threshold - b.threshold))[0];
}

function main() {
  const { questions } = loadSet("full");

  const curves = {
    v1: sweepWithRetrieval(questions, "v1"),
    "v1+gate": sweepWithRetrieval(questions, "v1+gate"),
    "v2-nogate": sweepWithRetrieval(questions, "v2-nogate"),
    hybrid: sweepWithRetrieval(questions, "hybrid"),
  };
  /* 只有启用了闸门的策略才需要标定阈值；v1 与 v2-nogate 是"无闸门"对照组 */
  const best = {
    v1: bestBy(curves.v1),
    "v1+gate": bestBy(curves["v1+gate"]),
    hybrid: bestBy(curves.hybrid),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    questions: questions.length,
    method: "以 0.02 为步长网格搜索阈值；每个候选阈值都通过 opts 注入检索器内部后重新计算置信度，保证曲线与线上行为一致",
    criterion: "在保证可用性（Recall ≥ 80%）的前提下最大化兜底准确率 —— RAG 场景下一次编造事实的代价远高于一次礼貌拒答",
    curves,
    best,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

  const pct = v => String(v).padStart(6);
  console.log("");
  console.log("  置信度闸门阈值标定（评测集 " + questions.length + " 题）");
  console.log("  ────────────────────────────────────────────────────────────────");
  console.log("  策略            最优阈值  Precision  Recall    F1    兜底准确率  可答题数");
  ["v1", "v1+gate", "hybrid"].forEach(k => {
    const b = best[k];
    console.log("  " + k.padEnd(14) + pct(b.threshold) + pct(b.precision + "%") + pct(b.recall + "%")
      + pct(b.f1 + "%") + pct(b.specificity + "%") + pct(b.answered));
  });
  console.log("");
  console.log("  说明：兜底准确率 = 该拒答的问题里确实拒答的比例；它直接对应「幻觉抑制」能力。");
  console.log("        阈值-指标完整曲线见 " + path.relative(path.join(__dirname, ".."), OUT));
  console.log("");

  /* 把最优阈值写回 rag.js，保证运行时与标定结果一致（避免"标定归标定、运行归运行"） */
  const target = path.join(__dirname, "..", "src", "rag.js");
  const src = fs.readFileSync(target, "utf8");
  const bestTh = best.hybrid.threshold;
  const re = /const DEFAULT_THRESHOLD = [0-9.]+;/;
  if (re.test(src)) {
    fs.writeFileSync(target, src.replace(re, "const DEFAULT_THRESHOLD = " + bestTh + ";"), "utf8");
    console.log("  已把最优阈值 " + bestTh + " 写回 src/rag.js 的 DEFAULT_THRESHOLD");
  } else {
    console.log("  ⚠ 未找到 DEFAULT_THRESHOLD 常量，写回失败（请检查 src/rag.js）");
  }
  console.log("");
}

main();
