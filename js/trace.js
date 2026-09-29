/* ============================================================
 * v2 前端 · RAG 检索链路可视化
 *
 * 这是本作品"把 AI 从黑箱里掏出来"的核心组件。提问后，右侧抽屉会
 * 逐帧点亮整条链路，而不是只给一个最终答案：
 *
 *   ① 查询理解   意图分类 + 实体链接 + 查询改写
 *   ② 分词       领域词典最大匹配 + n-gram 补全（展示实际参与检索的词项）
 *   ③ 三路召回   BM25 / 语义向量 / 知识图谱，分别给出候选与分数
 *   ④ 融合重排   0.45×BM25 + 0.35×向量 + 0.20×图谱，展示 Top-K 分数条
 *   ⑤ 置信度闸门 检索强度 × 文档覆盖 × 词表覆盖，与阈值比较
 *   ⑥ 域外识别   不属于校园问答范围的问题在此明确拒答并说明理由
 *   ⑦ Prompt 注入 实际送进模型的知识片段（给模型看的内容 = 给人看的内容）
 *   ⑧ 流式生成   首字延迟 + token 增量
 *   ⑨ 引用核验与落库  来源标注、耗时、写入 sqlite
 *
 * 设计原则：这里展示的每一个数字都来自真实检索结果（src/rag.js 的返回值），
 * 不存在"界面显示一套、背后跑另一套"的演示造假。
 * ============================================================ */

import { $, el, esc, fmtMs, clamp } from "./util.js";

const STEPS = [
  { id: "understand", name: "查询理解" },
  { id: "tokenize", name: "分词与关键词抽取" },
  { id: "recall", name: "三路召回" },
  { id: "fuse", name: "融合重排" },
  { id: "gate", name: "置信度闸门" },
  { id: "prompt", name: "Prompt 知识注入" },
  { id: "generate", name: "流式生成" },
  { id: "verify", name: "引用核验与落库" },
];

export class TraceView {
  constructor() {
    this.drawer = $("traceDrawer");
    this.body = $("traceBody");
    this.stepNodes = new Map();
    this.t0 = 0;
    this.timers = [];
    this.sources = [];

    const btn = $("btnTrace");
    if (btn) btn.onclick = () => this.toggle();
    const close = $("traceClose");
    if (close) close.onclick = () => this.close();
  }

  toggle() { this.drawer && this.drawer.classList.toggle("open"); }
  open() { this.drawer && this.drawer.classList.add("open"); }
  close() { this.drawer && this.drawer.classList.remove("open"); }

  clearTimers() {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
  }

  /** 开始一轮新的链路追踪 */
  begin(question) {
    this.clearTimers();
    this.stepNodes = new Map();
    this.sources = [];
    this.t0 = performance.now();
    if (!this.body) return;
    this.body.innerHTML = "";

    const head = el("div", "traceStep done");
    head.innerHTML =
      '<div class="marker">Q</div>' +
      '<div class="st">用户提问<span class="ms">' + esc(new Date().toLocaleTimeString("zh-CN")) + '</span></div>' +
      '<div class="sc">' + esc(question) + '</div>';
    this.body.appendChild(head);

    STEPS.forEach(s => {
      const node = el("div", "traceStep");
      node.innerHTML =
        '<div class="marker"></div>' +
        '<div class="st">' + esc(s.name) + '<span class="ms"></span></div>' +
        '<div class="sc"></div>';
      this.body.appendChild(node);
      this.stepNodes.set(s.id, node);
    });
    this.open();
  }

  _step(id) {
    const node = this.stepNodes.get(id);
    if (!node) return null;
    node.classList.add("active");
    this._scroll(node);
    return {
      node,
      st: node.querySelector(".st"),
      ms: node.querySelector(".ms"),
      sc: node.querySelector(".sc"),
      done(ms) {
        node.classList.remove("active");
        node.classList.add("done");
        node.querySelector(".marker").textContent = "✓";
        if (ms != null) this.ms.textContent = fmtMs(ms);
      },
      warn(ms) {
        node.classList.remove("active");
        node.classList.add("warn");
        node.querySelector(".marker").textContent = "!";
        if (ms != null) this.ms.textContent = fmtMs(ms);
      },
      fail(ms) {
        node.classList.remove("active");
        node.classList.add("fail");
        node.querySelector(".marker").textContent = "✕";
        if (ms != null) this.ms.textContent = fmtMs(ms);
      },
    };
  }

  _scroll(node) {
    if (!this.body) return;
    const top = node.offsetTop - 60;
    this.body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  /* ══════════════ ① 查询理解 ══════════════ */
  stepUnderstand(q) {
    const s = this._step("understand");
    if (!s) return;
    s.sc.innerHTML =
      '<dl class="kvMini">' +
      '<dt>意图分类</dt><dd>' + esc(q.intent || "—") + '</dd>' +
      '<dt>实体链接</dt><dd>' + (q.entities && q.entities.length ? esc(q.entities.map(e => e.term).join("、")) : "无") + '</dd>' +
      '<dt>查询改写</dt><dd>' + (q.rewritten ? q.rewritten.length : 0) + ' 条子查询</dd>' +
      '</dl>';
    if (q.rewritten && q.rewritten.length) {
      const box = el("div", "tokens");
      q.rewritten.forEach((r, i) => {
        const t = el("span", "tok" + (i === 0 ? " dict" : ""), r);
        box.appendChild(t);
      });
      s.sc.appendChild(box);
    }
    s.done();
  }

  /* ══════════════ ② 分词 ══════════════ */
  stepTokenize(q) {
    const s = this._step("tokenize");
    if (!s) return;
    const toks = q.tokens || [];
    s.sc.innerHTML = '<div style="margin-bottom:4px">参与检索的词项 <b style="color:var(--cyan)">' +
      toks.length + '</b> 个（领域词典优先做最大匹配，未命中片段补 2-gram）：</div>';
    const box = el("div", "tokens");
    const missSet = new Set(q.uncoveredTerms || []);
    toks.slice(0, 26).forEach(t => {
      const isMiss = missSet.has(t);
      box.appendChild(el("span", "tok" + (isMiss ? " miss" : (t.length >= 3 ? " dict" : "")), t));
    });
    if (toks.length > 26) box.appendChild(el("span", "tok", "…+" + (toks.length - 26)));
    s.sc.appendChild(box);
    s.done();
  }

  /* ══════════════ ③ 三路召回 + ④ 融合重排 ══════════════ */
  stepRecall(q) {
    const s = this._step("recall");
    if (!s) return;
    const top = q.top || [];
    s.sc.innerHTML =
      '<div>三路召回共得到 <b style="color:var(--cyan)">' + (q.candidates || 0) + '</b> 条候选' +
      (q.vectorDims ? '，语义向量维度 <b>' + q.vectorDims + '</b>' : '') + '</div>';
    if (q.entities && q.entities.length) {
      s.sc.innerHTML += '<div style="margin-top:5px">图谱命中实体：' +
        q.entities.map(e => '<span class="tok dict">' + esc(e.term) + '</span>').join(" ") + '</div>';
    }
    if (q.graphPaths && q.graphPaths.length) {
      const paths = q.graphPaths.slice(0, 5).map(p =>
        '<span class="tok">' + esc(p.from) + ' —' + esc(p.rel) + '→ ' + esc(p.to) + '</span>');
      s.sc.innerHTML += '<div style="margin-top:5px">多跳路径（前 ' + Math.min(5, q.graphPaths.length) + ' 条）：</div><div class="tokens">' +
        paths.join("") + '</div>';
    }
    const total = (q.timeline && q.timeline.length) ? q.timeline[q.timeline.length - 1].at : null;
    s.done(total);
  }

  stepFuse(q) {
    const s = this._step("fuse");
    if (!s) return;
    const top = q.top || [];
    const w = q.weights || {};
    s.sc.innerHTML = '<div style="margin-bottom:6px">权重：BM25 <b>' + (w.bm25 || 0) + '</b> · 语义向量 <b>' +
      (w.vector || 0) + '</b> · 知识图谱 <b>' + (w.graph || 0) + '</b></div>';
    const bars = el("div", "scoreBar");
    top.slice(0, 5).forEach((t, i) => {
      const row = el("div", "scoreRow");
      row.innerHTML =
        '<span class="rk">#' + (i + 1) + '</span>' +
        '<span class="track"><i class="fill" style="width:' + clamp(t.scorePct || 0, 2, 100) + '%"></i></span>' +
        '<span class="sc">' + (t.score != null ? t.score.toFixed(3) : "—") + '</span>';
      const bd = t.breakdown || {};
      const sub = el("div", "q");
      sub.innerHTML = '[' + esc(t.id) + '] ' + esc(t.q || "") +
        ' <span style="color:var(--text-mute)">' +
        (bd.bm25 != null ? 'BM25 ' + bd.bm25.toFixed(2) : '') +
        (bd.vector != null ? ' · 向量 ' + bd.vector.toFixed(2) : '') +
        (bd.graph ? ' · 图谱 ' + bd.graph.toFixed(2) : '') + '</span>';
      row.appendChild(sub);
      bars.appendChild(row);
    });
    s.sc.appendChild(bars);
    const fuseStage = (q.timeline || []).find(t => t.stage === "fuse");
    s.done(fuseStage ? fuseStage.at : null);
  }

  /* ══════════════ ⑤⑥ 置信度闸门 + 域外识别 ══════════════ */
  stepGate(q) {
    const s = this._step("gate");
    if (!s) return;
    const conf = q.confidence == null ? 0 : q.confidence;
    const th = q.threshold == null ? 0.12 : q.threshold;
    const pass = !!q.pass;

    const g = el("div", "gauge " + (pass ? "pass" : "fail"));
    g.innerHTML =
      '<div class="track">' +
      '<i class="fill" style="width:' + clamp(conf * 100, 1, 100) + '%"></i>' +
      '<i class="threshold" style="left:' + clamp(th * 100, 0, 99) + '%"></i>' +
      '<span class="label">置信度 ' + conf.toFixed(3) + ' / 阈值 ' + th.toFixed(2) + '</span>' +
      '</div>';
    s.sc.appendChild(g);

    const detail = el("dl", "kvMini");
    detail.style.marginTop = "8px";
    detail.innerHTML =
      '<dt>文档级覆盖</dt><dd>' + (q.docCoverage != null ? q.docCoverage.toFixed(3) : "—") + '</dd>' +
      '<dt>词表级覆盖</dt><dd>' + (q.vocabCoverage != null ? q.vocabCoverage.toFixed(3) : "—") + '</dd>' +
      '<dt>聚合判定值</dt><dd>' + (q.aggregate != null ? q.aggregate.toFixed(3) : "—") + '</dd>' +
      '<dt>最高分 / 次高分</dt><dd>' + (q.topScore != null ? q.topScore.toFixed(3) : "—") + ' / ' +
      (q.secondScore != null ? q.secondScore.toFixed(3) : "—") + '</dd>';
    s.sc.appendChild(detail);

    if (q.outOfScope) {
      const box = el("div", "oosBox");
      box.innerHTML = '<b>域外意图识别命中：' + esc(q.oosLabel || "") + '</b><br>' +
        '该问题在意图上不属于校园导览范围，因此明确拒答 —— 这比让模型自由发挥更安全。';
      s.sc.appendChild(box);
      s.warn();
      return;
    }
    if (!pass && q.uncoveredTerms && q.uncoveredTerms.length) {
      const box = el("div", "missBox");
      box.innerHTML = '<b>判定为知识库未收录</b><br>以下实词在整个知识库中都不存在：' +
        q.uncoveredTerms.map(t => '<span class="tok miss">' + esc(t) + '</span>').join(" ") +
        '<br>因此拒绝编造，转而引导用户咨询对应部门。';
      s.sc.appendChild(box);
      s.warn();
      return;
    }
    s.done();
  }

  /* ══════════════ ⑦ Prompt 知识注入 ══════════════ */
  stepPrompt(sources) {
    const s = this._step("prompt");
    if (!s) return;
    if (!sources || !sources.length) {
      s.sc.innerHTML = '<div style="color:var(--text-mute)">未注入校园知识片段：本轮问题不需要检索，或闸门判定为未收录。</div>';
      s.done();
      return;
    }
    s.sources = sources;
    s.sc.innerHTML = '<div style="margin-bottom:5px">注入 <b style="color:var(--green)">' + sources.length +
      '</b> 条知识片段（给模型看的内容与下方来源标注完全一致）：</div>';
    sources.slice(0, 4).forEach(src => {
      const row = el("div");
      row.style.cssText = "margin-top:6px;padding:7px 9px;border-radius:8px;background:rgba(120,165,220,.08);border:1px solid var(--line);font-size:11.5px;line-height:1.7";
      row.innerHTML = '<b style="color:#bae6fd">[' + esc(src.id) + '] ' + esc(src.q || "") + '</b>' +
        (src.score != null ? ' <span style="color:var(--text-mute)">score ' + (+src.score).toFixed(3) + '</span>' : '') +
        '<br>' + esc((src.snippet || "").slice(0, 120)) + '…';
      s.sc.appendChild(row);
    });
    s.done();
  }

  /* ══════════════ ⑧ 流式生成 ══════════════ */
  stepGenerate() {
    const s = this._step("generate");
    if (!s) return;
    s.sc.innerHTML = '<div style="color:var(--text-mute)">等待首字…</div>';
    return s;
  }

  markFirstToken(ms) {
    const node = this.stepNodes.get("generate");
    if (!node) return;
    const sc = node.querySelector(".sc");
    if (sc) sc.innerHTML = '<div>模型已开始响应（含工具调用决策） <b style="color:var(--cyan)">' +
      fmtMs(ms) + '</b>，正在处理…</div>';
  }

  /** 最终答案的首字延迟 —— 这才是用户真正感知到的等待时长 */
  markFirstAnswer(ms) {
    const node = this.stepNodes.get("generate");
    if (!node) return;
    const sc = node.querySelector(".sc");
    if (sc) sc.innerHTML = '<div>答案首字延迟 <b style="color:var(--green)">' + fmtMs(ms) +
      '</b>（从提问到看到第一个字），正在流式输出…</div>';
  }

  bumpTokens(n) {
    const node = this.stepNodes.get("generate");
    if (!node) return;
    const sc = node.querySelector(".sc");
    if (sc) {
      const cur = Number(sc.dataset.tokens || 0) + n;
      sc.dataset.tokens = cur;
      sc.innerHTML = '<div>已生成 <b style="color:var(--cyan)">' + cur + '</b> 字，流式输出中…</div>';
    }
  }

  finishGenerate(ms) {
    const s = this._step("generate");
    if (s) s.done(ms);
  }

  /* ══════════════ ⑨ 引用核验与落库 ══════════════ */
  stepVerify(info) {
    const s = this._step("verify");
    if (!s) return;
    const total = info && info.latencyTotal != null ? info.latencyTotal : (performance.now() - this.t0);
    const first = info && info.latencyFirst != null ? info.latencyFirst : null;
    const answer = info && info.latencyAnswer != null ? info.latencyAnswer : null;
    const rounds = info && info.rounds != null ? info.rounds : 0;
    s.sc.innerHTML =
      '<dl class="kvMini">' +
      '<dt>端到端耗时</dt><dd>' + fmtMs(total) + '</dd>' +
      /* 两个延迟分开列：模型决策延迟 ≠ 用户感知等待，混在一起会让指标口径失真 */
      '<dt>答案首字延迟</dt><dd>' + fmtMs(answer) + '（用户感知）</dd>' +
      '<dt>首次响应延迟</dt><dd>' + fmtMs(first) + '（含工具决策）</dd>' +
      '<dt>工具调用轮数</dt><dd>' + rounds + '</dd>' +
      '<dt>引用来源</dt><dd>' + ((info && info.sources) ? info.sources.length : 0) + ' 条</dd>' +
      '<dt>落库状态</dt><dd>' + (info && info.qaId ? "已写入 sqlite · #" + info.qaId : "本地模式（未落库）") + '</dd>' +
      '</dl>';
    s.done();
  }

  /** 工具调用步骤（查询状态 / 导航 / 图谱遍历 / 办事流程 / 工单 / 转人工） */
  addTool(tool) {
    if (!this.body) return;
    const kindName = {
      retrieval: "知识检索", graph: "图谱多跳", status: "实时状态",
      navigate: "地图导航", form: "办事流程", ticket: "知识盲区工单", handoff: "转人工",
    }[tool.name] || tool.name;

    const node = el("div", "traceStep " + (tool.ok ? "done" : "fail"));
    node.innerHTML =
      '<div class="marker">' + (tool.ok ? "✓" : "✕") + '</div>' +
      '<div class="st">工具调用 · ' + esc(kindName) + '<span class="ms">' + fmtMs(tool.ms) + '</span></div>';
    const sc = el("div", "sc");
    sc.innerHTML = '<div style="color:#6ee7b7;font-family:var(--mono);font-size:11px">' +
      esc(tool.name) + '(' + esc(JSON.stringify(tool.args || {})) + ')</div>';
    if (tool.summary) {
      const line = el("div", null, tool.summary);
      line.style.marginTop = "5px";
      sc.appendChild(line);
    }
    /* 实时状态：直接渲染开放列表 */
    if (tool.trace && tool.trace.kind === "status" && tool.trace.list && tool.trace.list.length) {
      const chips = el("div", "chips");
      chips.style.marginTop = "7px";
      tool.trace.list.slice(0, 10).forEach(p => {
        chips.appendChild(el("span", "chip " + (p.open ? "ok" : "no"),
          (p.open ? "● " : "○ ") + p.name + " " + (p.today || "")));
      });
      sc.appendChild(chips);
    }
    /* 图谱多跳：渲染路径 */
    if (tool.trace && tool.trace.kind === "graph" && tool.trace.paths && tool.trace.paths.length) {
      const box = el("div", "tokens");
      box.style.marginTop = "6px";
      tool.trace.paths.slice(0, 6).forEach(p => {
        box.appendChild(el("span", "tok", p.from + " —" + p.rel + "→ " + p.to));
      });
      sc.appendChild(box);
    }
    /* 导航：渲染路径节点 */
    if (tool.trace && tool.trace.kind === "navigate" && tool.trace.path) {
      const box = el("div", "tokens");
      box.style.marginTop = "6px";
      tool.trace.path.forEach((n, i) => {
        box.appendChild(el("span", "tok" + (i === 0 || i === tool.trace.path.length - 1 ? " dict" : ""), n));
      });
      sc.appendChild(box);
    }
    /* 办事流程：材料 + 步骤 */
    if (tool.trace && tool.trace.kind === "form" && tool.trace.found) {
      if (tool.trace.materials) {
        const box = el("div", "chips");
        box.style.marginTop = "7px";
        tool.trace.materials.forEach(m => box.appendChild(el("span", "chip", m)));
        sc.appendChild(box);
      }
      const ol = el("div");
      ol.style.cssText = "margin-top:7px;font-size:11.5px;line-height:1.85";
      (tool.trace.steps || []).forEach((step, i) => {
        const line = el("div", null, (i + 1) + ". " + step);
        ol.appendChild(line);
      });
      sc.appendChild(ol);
    }
    node.appendChild(sc);
    this.body.appendChild(node);
    this._scroll(node);
  }

  /** 回答结束：补一个未走完的步骤（本地知识库模式没有真实生成阶段） */
  finalize(info) {
    ["understand", "tokenize", "recall", "fuse", "gate", "prompt"].forEach(id => {
      const n = this.stepNodes.get(id);
      if (n && !n.classList.contains("done") && !n.classList.contains("warn") && !n.classList.contains("fail")) {
        n.classList.remove("active");
        n.classList.add("done");
        n.querySelector(".marker").textContent = "✓";
      }
    });
    const gen = this.stepNodes.get("generate");
    if (gen && !gen.classList.contains("done")) {
      gen.classList.remove("active");
      gen.classList.add("done");
      gen.querySelector(".marker").textContent = "✓";
      const sc = gen.querySelector(".sc");
      if (sc && !sc.textContent.trim()) sc.textContent = info && info.local ? "本地知识库模式：直接返回检索结果" : "生成完成";
    }
    this.stepVerify(info);
  }

  /** 出错时把当前活动步骤标红 */
  failCurrent(msg) {
    let target = null;
    this.stepNodes.forEach((node) => {
      if (node.classList.contains("active")) target = node;
    });
    if (target) {
      target.classList.remove("active");
      target.classList.add("fail");
      target.querySelector(".marker").textContent = "✕";
      const sc = target.querySelector(".sc");
      if (sc) sc.innerHTML = '<div style="color:#fecdd3">' + esc(msg) + '</div>';
    }
    this._scroll(target || this.body);
  }
}
