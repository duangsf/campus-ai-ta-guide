/* ============================================================
 * v2 · 知识入库流水线（corpus → 检索条目）
 *
 * 这是设计文档里承诺、但 v1 从未实现的"知识库构建"环节：
 *
 *   原始文档(.md) → 解析元信息 → 按标题切块 → 清洗合并
 *                 → 自动抽取关键词 → 标注图谱实体 → 去重
 *                 → 输出 data/corpus.json（检索索引的数据源）
 *
 * 为什么值得单独做一个脚本：
 *  1. 评委可以现场演示"上传一份新文档 → 重新入库 → 立刻能答上来"的闭环；
 *  2. 关键词由算法抽取而非手工堆砌，在评测中更能体现检索算法的真实强度
 *     （手工关键词等于把答案喂给检索器，评测会虚高）；
 *  3. 有这条流水线，"知识库可扩展"才是事实而不是口号。
 *
 * 用法：node tools/ingest.js
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const V2_ROOT = path.join(__dirname, "..");
const CORPUS_DIR = path.join(V2_ROOT, "corpus");
const OUT_FILE = path.join(V2_ROOT, "data", "corpus.json");

const rag = require(path.join(V2_ROOT, "src", "rag.js"));

/* ---------- 停用词与低价值词 ---------- */
const STOP = new Set(("的 了 是 我 你 他 她 它 们 在 有 和 与 及 或 也 都 很 就 还 要 会 能 可以 什么 怎么 如何 哪里 哪个 哪些 多少 几 吗 呢 吧 啊 呀 哦 嗯 一下 请问 麻烦 想 问 说 给 帮 这 那 这个 那个 一个 请 需 需要 一般 通常 建议 注意 例如 使用 进行 提供 相关 具体 之后 之前 以上 以下 同时 此外 以及 方面 情况 问题 时候 需要 应当 应当 可以 不要 不得 请勿 之中 之间 通过 如果 因此 但是 而且 并且 或者 由于 为了 根据 按照 关于 对于 其中 包括 主要 常见 常见问题 每学年 每年 每周 每天 左右 之后 之前").split(/\s+/));

/* ---------- 1. 读取并解析 markdown ---------- */
function listDocs() {
  return fs.readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith(".md"))
    .sort()
    .map(f => ({ file: f, full: path.join(CORPUS_DIR, f) }));
}

function parseDoc(text) {
  const meta = {};
  let body = text;
  /* 元信息块形如（允许出现在 H1 大标题之后、正文之前）：
   *   ---
   *   title: xxx
   *   category: yyy
   *   entities: a, b, c
   *   ---
   * 为避免把 markdown 的水平分割线误判为元信息，要求块内至少包含一个 "key: value"。
   */
  const re = /^[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*\r?\n?/m;
  const m = text.match(re);
  if (m && /^[ \t]*[\w\u4e00-\u9fa5-]+[ \t]*:[ \t]*\S/m.test(m[1])) {
    m[1].split(/\r?\n/).forEach(line => {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    body = text.slice(0, m.index) + "\n" + text.slice(m.index + m[0].length);
  }
  return { meta, body };
}

/* ---------- 2. 按标题切块 ---------- */
function splitByHeading(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { heading: "", lines: [] };
  let sawH1 = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (h[1] === "#" && !sawH1) { sawH1 = true; cur.heading = h[2].trim(); continue; }   // 文档大标题作为默认 heading
      if (cur.heading || cur.lines.join("").trim()) sections.push(cur);
      cur = { heading: h[2].trim(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.heading || cur.lines.join("").trim()) sections.push(cur);
  return sections.map(s => ({ heading: s.heading, text: clean(s.lines.join("\n")) })).filter(s => s.text);
}

function clean(t) {
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/* 合并过短的相邻小节，避免产生只有一句话的碎片块（碎片会污染 BM25 的长度归一化） */
function mergeSections(sections, minLen) {
  const out = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (last && (last.text.length < minLen || s.text.length < minLen) && (last.text.length + s.text.length) < 900) {
      last.heading = last.heading || s.heading;
      last.text = last.text + "\n" + (s.heading ? s.heading + "。" : "") + s.text;
    } else {
      out.push({ heading: s.heading, text: s.text });
    }
  }
  return out;
}

/* ---------- 3. 关键词自动抽取 ---------- */
/**
 * 思路：语料块内的候选词（2~6 字 n-gram 与词典词）按
 *   score = tf * log(1 + 全局逆文档频率) * 长度权重 * 标题加权
 * 排序，再做"去除被更长入选词包含的短词"的后处理，避免
 * 同时出现"图书馆"和"书馆"这类冗余项。
 */
function extractKeywords(text, heading, dict, globalDf, docCount) {
  const toks = rag.tokenize(text, { dict });
  const tf = new Map();
  toks.forEach(t => { if (t.length >= 2) tf.set(t, (tf.get(t) || 0) + 1); });
  /* 词典命中优先：领域词比任意 n-gram 更有检索价值 */
  const dictHits = [];
  dict.forEach(w => {
    if (w.length >= 2 && w.length <= 8 && text.indexOf(w) >= 0) dictHits.push(w);
  });
  /* 实体 id / 英文标识符（如 place_dorm、sys_card）不是检索词，剔除 */
  const isJunk = (t) => /^[a-z0-9_]+$/i.test(t) || t.indexOf("_") >= 0;

  const candidates = new Map();
  tf.forEach((count, term) => {
    if (STOP.has(term) || isJunk(term)) return;
    const df = globalDf.get(term) || 1;
    const idf = Math.log(1 + docCount / df);
    let score = count * (0.5 + idf) * (1 + Math.min(term.length, 6) * 0.12);
    if (heading && heading.indexOf(term) >= 0) score *= 2.2;
    candidates.set(term, score);
  });
  dictHits.forEach(w => { if (!isJunk(w)) candidates.set(w, (candidates.get(w) || 0) + 6); });

  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const picked = [];
  for (const term of ranked) {
    if (STOP.has(term) || isJunk(term)) continue;
    if (picked.some(p => p.indexOf(term) >= 0)) continue;      // 已被更长词覆盖
    picked.push(term);
    if (picked.length >= 12) break;
  }
  return picked;
}

/* ---------- 4. 去重（2-gram Jaccard） ---------- */
function grams(text, n) {
  const s = rag.normalize(text).replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  a.forEach(g => { if (b.has(g)) inter++; });
  return inter / (a.size + b.size - inter || 1);
}

/* ---------- 5. 主流程 ---------- */
function main() {
  const docs = listDocs();
  if (!docs.length) { console.error("corpus 目录下没有 .md 文档"); process.exit(1); }

  const parsed = docs.map(d => {
    const raw = fs.readFileSync(d.full, "utf8");
    const { meta, body } = parseDoc(raw);
    return { file: d.file, meta, body, sections: mergeSections(splitByHeading(body), 90) };
  });

  /* 先做一遍全局统计，用于 IDF */
  const globalDf = new Map();
  let docCount = 0;
  parsed.forEach(p => {
    p.sections.forEach(s => {
      docCount++;
      const seen = new Set(rag.tokenize(s.text, { dict: rag._state.dict }).filter(t => t.length >= 2));
      seen.forEach(t => globalDf.set(t, (globalDf.get(t) || 0) + 1));
    });
  });

  const entries = [];
  const keepGrams = [];
  let seq = 0;
  let skipped = 0;

  parsed.forEach(p => {
    const base = path.basename(p.file, ".md").replace(/^\d+-/, "");
    p.sections.forEach((s, i) => {
      const body = s.text.replace(/\s+/g, " ").trim();
      if (body.length < 60) { skipped++; return; }
      const g = grams(body, 2);
      if (keepGrams.some(k => jaccard(g, k) > 0.72)) { skipped++; return; }
      keepGrams.push(g);

      seq++;
      const kw = extractKeywords(body, s.heading, rag._state.dict, globalDf, docCount);
      const entities = (p.meta.entities || "").split(/[,，\s]+/).filter(Boolean);
      entries.push({
        id: "c" + String(seq).padStart(3, "0"),
        cat: p.meta.category || "校园信息",
        q: s.heading || p.meta.title || base,
        k: kw,
        a: body.length > 900 ? body.slice(0, 900) + "…" : body,
        src: p.meta.source || ("校内文档《" + p.file + "》"),
        entities: entities,
        fromCorpus: true,
        doc: p.file,
        chars: body.length,
      });
    });
  });

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      generator: "tools/ingest.js",
      pipeline: "markdown → 元信息解析 → 标题切块 → 短块合并 → 关键词自动抽取(2~6gram+词典, IDF加权) → 图谱实体标注 → 2-gram Jaccard 去重",
      docs: docs.length,
      sections: seq,
      skipped,
      note: "本文件由脚本生成，请勿手工编辑；修改语料请改 corpus/*.md 后重新运行 node tools/ingest.js",
    },
    entries,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  /* 控制台报告，路演时可直接投屏展示入库结果 */
  console.log("");
  console.log("  知识入库流水线执行完成");
  console.log("  ────────────────────────────────────────────");
  console.log("  输入文档      " + docs.length + " 份（v2/corpus/*.md）");
  console.log("  切块合并后    " + docCount + " 个语义块");
  console.log("  入库条目      " + seq + " 条（跳过过短或高度重复 " + skipped + " 块）");
  console.log("  平均正文长度  " + Math.round(entries.reduce((s, e) => s + e.chars, 0) / (entries.length || 1)) + " 字");
  console.log("  关键词总数    " + entries.reduce((s, e) => s + e.k.length, 0) + " 个（算法自动抽取）");
  console.log("  输出          " + path.relative(V2_ROOT, OUT_FILE));
  console.log("");
  console.log("  样例（前 3 条）：");
  entries.slice(0, 3).forEach(e => {
    console.log("   · [" + e.id + "] " + e.cat + " / " + e.q);
    console.log("     关键词：" + e.k.slice(0, 8).join("、"));
  });
  console.log("");
}

main();
