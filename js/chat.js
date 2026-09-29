/* ============================================================
 * v2 前端 · 对话主逻辑
 *
 * 两条作答通道，靠"效率优先"选择：
 *   A. 云端 Agent 通道（有 API Key）
 *      客户端只负责把历史发过去；检索、工具调用、多跳推理都在服务端
 *      Agent 循环里完成，并通过 SSE 把过程推回来 → 界面才能可视化链路。
 *      好处：API Key 不出服务端，且检索逻辑只有一份实现。
 *   B. 本地知识库通道（无 Key / 断网 / 用户强制）
 *      直接用浏览器里的同一份 src/rag.js 做检索与闸门判定，
 *      命中即用知识库原文作答，未命中给出引导与工单 —— 完全离线可用。
 *
 * 两条通道共用同一套检索引擎与同一个闸门，因此"离线演示"和"联网演示"
 * 的判定行为一致，评审现场切换模式不会出现两套不同的表现。
 * ============================================================ */

import { $, el, esc, toast, streamChat, fmtMs, hhmm, api } from "./util.js";

const BOT_META = {
  female: { name: "小岚", tag: "学生服务助手", ava: "岚" },
  male: { name: "小航", tag: "校园事务助手", ava: "航" },
};

export class ChatView {
  constructor(ctx) {
    this.ctx = ctx;                    // { avatar, trace, config, rag }
    this.list = $("chatList");
    this.scroll = $("chatScroll");
    this.input = $("txt");
    this.btnSend = $("btnSend");
    this.btnVoice = $("btnVoice");
    this.tip = $("composerTip");

    this.history = [];                 // [{role, content}]
    this.answering = false;
    this.qaCount = 0;
    this.md = window.markdownit
      ? window.markdownit({ html: false, breaks: true, linkify: true })
      : null;
    if (this.md) {
      this.md.renderer.rules.table_open = () => '<div class="md-table"><table>\n';
      this.md.renderer.rules.table_close = () => '</table></div>\n';
      this.md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
        tokens[idx].attrSet("target", "_blank");
        tokens[idx].attrSet("rel", "noopener noreferrer");
        return self.renderToken(tokens, idx, opts);
      };
    }
    this.speech = new SpeechIO(this);
    this._bind();
  }

  get role() {
    return this.ctx.getRole ? this.ctx.getRole() : "female";
  }
  get bot() {
    return BOT_META[this.role];
  }

  /* ══════════════ 事件绑定 ══════════════ */
  _bind() {
    this.btnSend.onclick = () => this.send();
    this.input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) this.send();
    });
    /* 按住说话：鼠标与触摸都要支持（一体机触屏场景） */
    this.btnVoice.addEventListener("mousedown", () => this.speech.start());
    this.btnVoice.addEventListener("mouseup", () => this.speech.stopAndSend());
    this.btnVoice.addEventListener("mouseleave", () => this.speech.stopAndSend());
    this.btnVoice.addEventListener("touchstart", e => { e.preventDefault(); this.speech.start(); });
    this.btnVoice.addEventListener("touchend", e => { e.preventDefault(); this.speech.stopAndSend(); });
  }

  setTip(text) {
    if (this.tip) this.tip.textContent = text || "";
  }

  /* ══════════════ 快捷提问 ══════════════ */
  renderQuick(list) {
    const row = $("quickRow");
    if (!row) return;
    row.innerHTML = "";
    (list || []).forEach(q => {
      const b = el("button", "qbtn", q);
      b.type = "button";
      b.onclick = () => { this.input.value = q; this.send(); };
      row.appendChild(b);
    });
  }

  /* ══════════════ 消息渲染 ══════════════ */
  appendUser(text) {
    const wrap = el("div", "msg user");
    wrap.innerHTML = '<div class="ava">我</div><div class="bubble">' + esc(text) + '</div>';
    this.list.appendChild(wrap);
    this._toBottom();
    return wrap.querySelector(".bubble");
  }

  appendBot(placeholder) {
    const wrap = el("div", "msg bot");
    wrap.innerHTML = '<div class="ava">' + esc(this.bot.ava) + '</div><div class="bubble"></div>';
    this.list.appendChild(wrap);
    this._toBottom();
    const bubble = wrap.querySelector(".bubble");
    if (placeholder) bubble.textContent = placeholder;
    return { wrap, bubble };
  }

  /** 流式增量写入：用纯文本累积，结束后再整体转 Markdown（避免每帧重排 Markdown） */
  streamInto(bubble, text) {
    bubble.classList.add("streaming");
    bubble.textContent = text;
    this._toBottom();
  }

  renderMarkdown(bubble, text) {
    bubble.classList.remove("streaming", "error");
    bubble.classList.add("md");
    bubble.innerHTML = this.md ? this.md.render(text) : esc(text).replace(/\n/g, "<br>");
    this._toBottom();
  }

  renderError(bubble, msg) {
    bubble.classList.remove("streaming", "md");
    bubble.classList.add("error");
    bubble.textContent = msg;
    this._toBottom();
  }

  /* 来源标注：与 RAG 链路抽屉里"注入的知识片段"是同一份数据 */
  addSources(bubble, sources) {
    if (!sources || !sources.length) return;
    const box = el("div", "srcRow");
    sources.forEach(s => {
      const tag = el("span", "srcTag");
      tag.innerHTML = '<b>来源</b>' + esc(s.src || s.q || "");
      tag.title = (s.q || "") + (s.score != null ? " · 相关度 " + (+s.score).toFixed(3) : "");
      box.appendChild(tag);
    });
    bubble.appendChild(box);
  }

  /** 工具调用摘要（对话内嵌一行，详情在 RAG 链路抽屉里） */
  addToolLine(bubble, tool) {
    let stack = bubble.querySelector(".toolStack");
    if (!stack) {
      stack = el("div", "toolStack");
      bubble.appendChild(stack);
    }
    const kindName = {
      retrieval: "知识检索", graph: "图谱多跳", status: "实时状态",
      navigate: "地图导航", form: "办事流程", ticket: "知识盲区工单", handoff: "转人工",
    }[tool.name] || tool.name;
    const line = el("div", "toolLine" + (tool.ok ? "" : " fail"));
    line.innerHTML = '🔧 <span class="name">' + esc(tool.name) + '</span> ' +
      '<span>' + esc(kindName) + '</span>' +
      (tool.summary ? ' · ' + esc(tool.summary) : '') +
      '<span class="ms">' + fmtMs(tool.ms) + '</span>';
    stack.appendChild(line);
    this._toBottom();
  }

  /* 富媒体卡片（离线模式与卡片型知识共用） */
  addCard(bubble, card) {
    const box = el("div", "card");
    if (card.type === "schedule") {
      box.innerHTML = '<div class="ct">📋 ' + esc(card.title || "开放时间") + '</div>';
      (card.rows || []).forEach(r => {
        const row = el("div", "crow");
        row.innerHTML = '<span>' + esc(r[0]) + '</span><span class="' + (r[2] === true ? "open" : r[2] === false ? "closed" : "") + '">' + esc(r[1]) + '</span>';
        box.appendChild(row);
      });
      if (card.note) {
        const n = el("div");
        n.style.cssText = "margin-top:8px;font-size:11.5px;color:var(--text-mute)";
        n.textContent = card.note;
        box.appendChild(n);
      }
    } else if (card.type === "places") {
      box.innerHTML = '<div class="ct">📍 ' + esc(card.title || "相关地点") + '</div>';
      const chips = el("div", "chips");
      (card.items || []).forEach(p => {
        const c = el("span", "chip " + (p.open === true ? "ok" : p.open === false ? "no" : ""),
          (p.open === true ? "● " : p.open === false ? "○ " : "· ") + p.name + (p.today ? " " + p.today : ""));
        c.style.cursor = "pointer";
        c.onclick = () => this.ctx.focusPlace && this.ctx.focusPlace(p.id);
        chips.appendChild(c);
      });
      box.appendChild(chips);
    } else if (card.type === "route") {
      box.innerHTML = '<div class="ct">🧭 ' + esc(card.title || "步行路线") + '</div>' +
        '<div class="crow"><span>起点 → 终点</span><span>' + esc(card.from) + ' → ' + esc(card.to) + '</span></div>' +
        '<div class="crow"><span>距离 / 步行时间</span><span class="open">' + card.distance + ' 米 · 约 ' + card.minutes + ' 分钟</span></div>';
      const chips = el("div", "chips");
      chips.style.marginTop = "9px";
      (card.path || []).forEach(n => chips.appendChild(el("span", "chip", n)));
      box.appendChild(chips);
    } else if (card.type === "form") {
      box.innerHTML = '<div class="ct">📝 ' + esc(card.name) + '</div>' +
        '<div class="crow"><span>责任部门</span><span>' + esc(card.department) + '</span></div>' +
        '<div class="crow"><span>办理地点</span><span>' + esc(card.location || "—") + '</span></div>' +
        '<div class="crow"><span>预计时长</span><span>' + esc(card.duration || "—") + '</span></div>';
      if (card.materials && card.materials.length) {
        const t = el("div");
        t.style.cssText = "margin-top:10px;font-size:12px;color:var(--text-dim)";
        t.textContent = "所需材料";
        box.appendChild(t);
        const chips = el("div", "chips");
        chips.style.marginTop = "6px";
        card.materials.forEach(m => chips.appendChild(el("span", "chip", m)));
        box.appendChild(chips);
      }
      if (card.steps && card.steps.length) {
        const t = el("div");
        t.style.cssText = "margin-top:10px;font-size:12px;color:var(--text-dim)";
        t.textContent = "办理步骤";
        box.appendChild(t);
        const ol = el("div");
        ol.style.cssText = "margin-top:6px;font-size:12.5px;line-height:1.9";
        card.steps.forEach((s, i) => ol.appendChild(el("div", null, (i + 1) + ". " + s)));
        box.appendChild(ol);
      }
    }
    bubble.appendChild(box);
    this._toBottom();
  }

  /* 反馈（写入后端 sqlite，直接进运营看板的满意度指标） */
  addFeedback(bubble, question, answer, qaId) {
    const box = el("div", "feedback");
    const up = el("button", null, "👍 有帮助");
    const down = el("button", null, "👎 待改进");
    const done = (vote, btn) => {
      up.classList.remove("on"); down.classList.remove("on");
      btn.classList.add("on");
      api("/api/feedback", {
        method: "POST",
        body: JSON.stringify({ vote: vote ? 1 : 0, qaId: qaId || null, session: this.ctx.session }),
      }).catch(() => { /* 离线时忽略，不影响演示 */ });
      toast(vote ? "感谢反馈，已记录" : "已记录，我们会优化这条回答", "ok");
    };
    up.onclick = () => done(1, up);
    down.onclick = () => done(0, down);
    box.appendChild(up);
    box.appendChild(down);
    bubble.appendChild(box);
  }

  _toBottom() {
    if (this.scroll) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /* ══════════════ 主流程 ══════════════ */
  async send(preset) {
    const text = (preset != null ? preset : this.input.value).trim();
    if (!text || this.answering) return;
    if (preset == null) this.input.value = "";
    this.speech.stop();

    this.answering = true;
    this.btnSend.disabled = true;
    this.qaCount++;
    this.ctx.onQuestion && this.ctx.onQuestion();

    this.appendUser(text);
    this.history.push({ role: "user", content: text });

    const { bubble } = this.appendBot("…");
    const thinking = this.ctx.avatar && this.ctx.avatar.setEmotion("thinking");
    this.ctx.setStatus("thinking", "检索与推理中…");

    const useCloud = this.ctx.useCloud();
    try {
      if (useCloud) await this._cloud(text, bubble);
      else await this._local(text, bubble);
    } catch (e) {
      console.error(e);
      this.renderError(bubble, "处理失败：" + (e.message || e));
      this.ctx.trace.failCurrent(e.message || String(e));
      this.ctx.setStatus("error", "出现错误");
      this.ctx.avatar.setEmotion("neutral");
    } finally {
      this.answering = false;
      this.btnSend.disabled = false;
      this.speech.finish();
    }
  }

  /* ── A. 云端 Agent 通道 ── */
  async _cloud(question, bubble) {
    const trace = this.ctx.trace;
    trace.begin(question);
    let acc = "";
    let qaId = null;
    let firstAt = null;
    let answerAt = null;
    const sources = [];
    const toolCalls = [];

    this.ctx.setStatus("thinking", "云端 Agent 推理中…");
    const setEmotion = (em) => this.ctx.avatar.setEmotion(em);

    /* ── 极速模式的"预检索" ──
       完整 Agent 流程需要两轮模型往返（第一轮决定调工具、第二轮才生成答案），
       实测端到端约 4~5 秒。极速模式先用浏览器内的同一套检索引擎跑一次本地检索，
       把命中的知识直接作为上下文注入，从而省掉"决策"那一轮，只保留一次往返。
       两种模式共用同一个闸门与同一份知识，答案口径一致，只是链路长度不同：
         · Agent 模式：链路可见（评委能看到工具调用），代价是多一次往返
         · 极速模式：省一轮往返，代价是链路里看不到工具调用过程
       通过设置项切换，现场可按网络状况选择。 */
    let preSources = [];
    let preTrace = null;
    if (this.ctx.config.fastMode) {
      const rag = window.RAG;
      if (rag) {
        const r = rag.retrieveDetailed(question, { topK: 4 });
        preTrace = r;
        /* 本地检索与可视化链路同步展示，保证"界面所见"与"实际注入"一致 */
        trace.stepUnderstand(r);
        trace.stepTokenize(r);
        trace.stepRecall(r);
        trace.stepFuse(r);
        trace.stepGate(r);
        if (r.pass) {
          preSources = r.top.slice(0, 3).map(t => ({ id: t.id, q: t.q, src: t.src, score: t.score, snippet: t.snippet }));
          trace.stepPrompt(preSources);
          this.ctx.setStatus("thinking", "已本地预检索命中，直接生成答案…");
        } else {
          trace.stepPrompt([]);
          this.ctx.setStatus("thinking", "本地未收录，交由模型判断…");
        }
      }
    }

    await streamChat({
      messages: this._buildMessages(question, preSources, preTrace),
      apiKey: this.ctx.config.apiKey,
      model: this.ctx.config.model,
      session: this.ctx.session,
      role: this.role,
      /* 极速模式已注入知识，不再下发工具，避免模型又走一轮工具调用 */
      toolsHint: this.ctx.config.fastMode ? "none" : "auto",
    }, {
      error: (d) => {
        if (d.code === "NO_KEY") throw new Error(d.message);
        this.renderError(bubble, d.message || "模型服务异常");
        trace.failCurrent(d.message || "模型服务异常");
        this.ctx.setStatus("error", "模型服务异常");
      },
      /* retry 事件：上游瞬时故障时后端会自动重试（仅在尚未输出正文时），
         这里如实显示出来，避免"界面卡住但没有任何解释" */
      retry: (d) => {
        this.ctx.setStatus("thinking", "上游波动，正在重试（第 " + d.attempt + "/" + d.max + " 次）…");
        trace.addTool({ name: "upstream_retry", ok: false, ms: d.waitMs, summary: "模型服务瞬时异常，退避 " + d.waitMs + "ms 后重试：" + d.reason, args: { attempt: d.attempt }, trace: null });
      },
      first_token: (d) => {
        firstAt = d.at;
        trace.markFirstToken(d.at);
        this.ctx.setStatus("speaking", "生成中…");
        setEmotion("neutral");
      },
      /* 最终答案的第一个字 —— 与"任何输出"区分开：
         前面几轮的输出只是模型在说明"我要去查资料"，不该算进用户等待时长 */
      first_answer: (d) => {
        answerAt = d.at;
        trace.markFirstAnswer(d.at);
      },
      delta: (d) => {
        acc += d.text || "";
        this.streamInto(bubble, acc);
        trace.bumpTokens((d.text || "").length);
      },
      tool: (t) => {
        toolCalls.push(t);
        trace.addTool(t);
        this.addToolLine(bubble, t);
        if (t.sources) t.sources.forEach(s => {
          if (!sources.some(x => x.id === s.id)) sources.push(s);
        });
        /* 工具返回的结构化数据直接驱动地图/图谱联动 */
        if (t.detail) this.ctx.applyToolDetail(t.detail);
        if (t.trace && t.trace.kind === "retrieval") {
          trace.stepUnderstand(t.trace);
          trace.stepTokenize(t.trace);
          trace.stepRecall(t.trace);
          trace.stepFuse(t.trace);
          trace.stepGate(t.trace);
        }
        trace.stepPrompt(sources);
        this.ctx.setStatus("thinking", t.summary || "工具执行完成");
      },
      final: (f) => { qaId = f.qaId; },
    });

    if (!acc.trim()) {
      this.renderError(bubble, "模型未返回内容，请重试。");
      trace.failCurrent("模型未返回内容");
      return;
    }
    this.renderMarkdown(bubble, acc);
    this.addAnswerCards(bubble, toolCalls);
    this.addSources(bubble, sources);
    this.addFeedback(bubble, question, acc, qaId);
    trace.stepVerify({
      latencyTotal: performance.now() - trace.t0,
      latencyFirst: firstAt, latencyAnswer: answerAt,
      sources, qaId, rounds: toolCalls.length,
    });
    trace.finishGenerate(answerAt || firstAt);

    this.history.push({ role: "assistant", content: acc });
    this._trim();
    this.ctx.setStatus("idle", "还有什么想问我的？");
    this.speech.speak(acc);
    this.ctx.afterAnswer && this.ctx.afterAnswer({ question, answer: acc, sources, local: false });
  }

  /* ── B. 本地知识库通道（离线） ── */
  async _local(question, bubble) {
    const trace = this.ctx.trace;
    const rag = window.RAG;
    trace.begin(question);

    /* 步骤之间有短延时，让评委看清链路（同时也是给渲染留出帧时间） */
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const em = this._emotion(question);
    const t0 = performance.now();

    const r = rag.retrieveDetailed(question, { topK: 6 });
    trace.stepUnderstand(r);
    await wait(160);
    trace.stepTokenize(r);
    await wait(200);
    trace.stepRecall(r);
    await wait(200);
    trace.stepFuse(r);
    await wait(220);
    trace.stepGate(r);
    await wait(180);

    const answer = r.pass ? this._composeLocal(r, em) : this._fallbackAnswer(r, em);

    trace.stepPrompt(r.pass ? r.top.slice(0, 3).map(t => ({
      id: t.id, q: t.q, src: t.src, score: t.score, snippet: t.snippet,
    })) : []);
    await wait(160);

    this.ctx.setStatus("speaking", "生成回答…");
    const gen = trace.stepGenerate();
    /* 本地模式没有真实 token 流，用逐字回放模拟打字机效果 —— 这一点在界面文案里
       会标注为"本地知识库模式"，不谎称是模型流式输出。 */
    let acc = "";
    for (let i = 0; i < answer.length; i++) {
      acc += answer[i];
      this.streamInto(bubble, acc);
      if (i % 3 === 0) trace.bumpTokens(3);
      /* 逐字太快会失去可读性，按字符量自适应延时 */
      if (i % 2 === 0) await wait(8);
    }
    trace.finishGenerate(performance.now() - t0);
    this.renderMarkdown(bubble, acc);

    /* 命中时给出结构化卡片：开放时段 / 相关地点 / 实时状态 */
    if (r.pass) {
      this._localCards(bubble, r);
      this.addSources(bubble, r.top.slice(0, 3).map(t => ({ id: t.id, q: t.q, src: t.src, score: t.score })));
    } else {
      const note = el("div", "gateNote");
      note.innerHTML = r.outOfScope
        ? '🚫 该问题属于「' + esc(r.oosLabel || "") + '」，不在校园导览助教的服务范围内。'
        : '🔒 置信度 ' + r.confidence.toFixed(3) + ' 低于闸门阈值 ' + r.threshold.toFixed(2) +
        '，判定为知识库未收录' +
        (r.uncoveredTerms && r.uncoveredTerms.length
          ? '（未覆盖词：' + esc(r.uncoveredTerms.join("、")) + '）' : '') +
        '，因此不编造答案，并已生成知识盲区工单。';
      bubble.appendChild(note);
      this._raiseTicket(question, r);
    }

    /* 落库（本地模式也写入后端，看板才有数据） */
    let qaId = null;
    try {
      const res = await api("/api/log", {
        method: "POST",
        body: JSON.stringify({
          session: this.ctx.session, role: this.role, question, answer,
          intent: r.intent, strategy: "BM25+向量+图谱（浏览器端本地执行）",
          topScore: r.topScore, confidence: r.confidence, hit: r.pass,
          sources: r.pass ? r.top.slice(0, 3).map(t => ({ id: t.id, q: t.q, src: t.src })) : [],
          latencyFirst: r.pass ? Math.round(performance.now() - t0) : null,
          latencyTotal: Math.round(performance.now() - t0),
          degraded: true,
        }),
      });
      qaId = res && res.id;
    } catch (e) { /* 直接双击打开 index.html 时无后端，忽略 */ }

    trace.stepVerify({
      latencyTotal: performance.now() - t0, latencyFirst: null,
      sources: r.pass ? r.top : [], qaId, rounds: 0,
    });

    this.history.push({ role: "assistant", content: answer });
    this._trim();
    this.ctx.avatar.setEmotion(em === "negative" ? "negative" : "happy");
    this.ctx.setStatus("idle", em === "negative" ? "我在，慢慢说" : "还有什么想问我的？");
    this.speech.speak(answer);
    this.ctx.afterAnswer && this.ctx.afterAnswer({ question, answer, sources: r.top, local: true });
  }

  /** 把检索到的知识条目组装成有人味的口语化回答（不调用模型也能自然） */
  _composeLocal(r, em) {
    const name = this.bot.name;
    const top = r.top[0];
    const prefix = em === "negative" ? "先别急，" : "";
    const lead = r.intent && r.intent !== "通用咨询"
      ? "关于「" + top.q + "」，我帮你查到了：\n\n"
      : "我帮你查到这些：\n\n";
    let body = top.a;
    if (r.top.length > 1) {
      const others = r.top.slice(1, 3).filter(t => t.id !== top.id);
      if (others.length) {
        body += "\n\n相关条目你也许用得上：" + others.map(t => "「" + t.q + "」").join("、") + "，需要的话直接问我。";
      }
    }
    const tail = r.coverage != null
      ? "\n\n（本条由本地知识库直接命中，相关度 " + (top.score != null ? top.score.toFixed(2) : "—") +
      "，置信度 " + r.confidence.toFixed(2) + "）"
      : "";
    return prefix + lead + body + tail;
  }

  _fallbackAnswer(r, em) {
    const name = this.bot.name;
    if (r.outOfScope) {
      return "这个问题属于「" + (r.oosLabel || "校园范围之外") + "」，不在我的服务范围内，我不方便随意作答。" +
        "校园导览、报到流程、图书馆与自习、宿舍生活、奖助资助、办事流程这些我都很熟，换个方向问我吧。";
    }
    const hints = (r.top || []).slice(0, 2).map(t => "「" + t.q + "」").join(" 或 ");
    return "抱歉，我在知识库里没有找到能支撑这个问题的资料，所以不敢随便给你一个答案——" +
      "编造校园信息（时间、电话、制度）反而可能误导你。\n\n" +
      "建议你：① 直接咨询辅导员或对应职能部门；② 到学校官网（hebic.cn）与迎新网（zhyx.hebic.cn）核对；" +
      "③ 也可以先问问相关知识，比如 " + (hints || "「咨询电话」") + "。\n\n" +
      "你的这个问题我已经记下来，会作为「知识盲区」提交给运营方补充进知识库。";
  }

  /** 知识命中时补充结构化卡片，让信息更好读 */
  _localCards(bubble, r) {
    const top = r.top[0];
    const rag = window.RAG;
    /* 时间表类：从知识库的 card 字段触发 */
    if (top.card === "schedule") {
      const places = rag.placesPayload ? rag.placesPayload().places : [];
      const study = places.filter(p => (p.tags || []).indexOf("自习") >= 0 || p.category === "自习室" || p.category === "图书馆")
        .slice(0, 5);
      if (study.length) {
        this.addCard(bubble, {
          type: "schedule", title: "自习 / 借阅开放时间",
          rows: study.map(p => {
            const today = (p.hours || []).map(h => h.open + "—" + h.close).join(" / ");
            return [p.name, today || "以现场公告为准", rag.isOpenNow(p)];
          }),
          note: "标识为绿色表示此刻正在开放（按当前时间实时计算）。",
        });
      }
    }
    /* 场所类：命中条目关联了地点实体时，给出可点击的地点卡片 */
    const places = rag.placesPayload ? rag.placesPayload().places : [];
    const related = places.filter(p => (p.tags || []).some(t => r.normalized.indexOf(t.toLowerCase()) >= 0)).slice(0, 6);
    if (related.length) {
      this.addCard(bubble, {
        type: "places", title: "相关地点（点击可在校园地图上定位）",
        items: related.map(p => {
          const open = rag.isOpenNow(p);
          const today = (p.hours || []).map(h => h.open + "—" + h.close).join(" / ");
          return { id: p.id, name: p.name, open, today };
        }),
      });
    }
    /* 问"在哪/怎么走"时直接给路线 */
    if (/在哪|怎么走|远不远|路线|到.*怎么/.test(r.normalized)) {
      const target = rag.findPlace(r.normalized) || related[0];
      if (target) {
        const from = rag.findPlace("校门口");
        const route = rag.shortestPath(from ? from.id : target.id, target.id);
        this.addCard(bubble, {
          type: "route", title: "步行路线",
          from: from ? from.name : "校门口", to: target.name,
          distance: route.distance || 0,
          minutes: Math.max(1, Math.round((route.distance || 0) / 75)),
          path: route.nodes.map(n => n.name),
        });
        if (this.ctx.focusPlace) this.ctx.focusPlace(target.id, from ? from.id : null);
      }
    }
  }

  _raiseTicket(question, r) {
    api("/api/ticket", {
      method: "POST",
      body: JSON.stringify({ question, intent: r.intent }),
    }).catch(() => { /* 离线忽略 */ });
  }

  /* ── 情绪识别：与检索同级的轻量规则（用于数字人表情与语气） ── */
  _emotion(text) {
    const s = String(text || "");
    if (/(难过|伤心|焦虑|压力|想家|睡不着|崩溃|难受|孤独|害怕|郁闷|不开心|抑郁|烦死|累死|哭)/.test(s)) return "negative";
    if (/(谢谢|太好了|不错|喜欢|开心|棒|给力|满意)/.test(s)) return "positive";
    return "neutral";
  }

  _buildMessages(question, preSources, preTrace) {
    const name = this.bot.name;
    const sys = [
      "你是" + name + "，河北传媒学院的校园 AI 导览助教，也可以正常闲聊、答疑与提供通用建议。",
      "工作要求：",
      "1. 涉及河北传媒学院的具体信息（报到、地址、图书馆与自习、宿舍、食堂、奖助、办事流程、校园服务等）时，必须以工具检索或已提供的资料为依据，不要凭记忆作答。",
      "2. 资料是唯一事实来源。资料里没有出现的学校具体事实（时间、电话、费用、制度、人员）不得编造；资料不足时明确说明未收录，并建议核实学校最新通知或联系对应部门。",
      "3. 通用知识、闲聊、学习与写作类问题直接回答，无需检索。",
      "4. 用户问方位、路线、地图时调用 navigate_to；问场所此刻是否开放、现在能去哪时调用 query_live_status；需要跨实体推理时调用 traverse_knowledge_graph；需要办事材料与步骤时调用 plan_form_fill。",
      "5. 知识库确实没有收录时，调用 create_ticket 建立知识盲区工单；涉及隐私、学籍异动、投诉或用户要求找人工时，调用 handoff_to_human。",
      "6. 回答有条理、口语自然，善用小标题与列表；不要暴露内部实现细节（如分数、字段名）。",
    ].join("\n");

    const msgs = [{ role: "system", content: sys }];

    /* 极速模式：把本地预检索结果作为系统资料注入，并在提示里交代
       "闸门已判定未收录"的情况，让模型据此诚实拒答而不是自行发挥。 */
    if (preSources && preSources.length) {
      const ctxLines = preSources.map((s, i) =>
        "【知识" + (i + 1) + "｜来源：" + (s.src || "校内资料") + "】" + (s.snippet || ""));
      msgs.push({
        role: "system",
        content: "已通过校园知识库检索到以下资料（置信度 " +
          (preTrace && preTrace.confidence != null ? preTrace.confidence.toFixed(2) : "—") +
          "，已通过可信度闸门）。请只依据这些资料回答本校相关问题，资料未覆盖的事实不要编造：\n\n" +
          ctxLines.join("\n\n"),
      });
    } else if (preTrace && preTrace.confidence != null && !preTrace.pass) {
      const why = preTrace.outOfScope
        ? "该问题被判定为「" + (preTrace.oosLabel || "校园范围之外") + "」，不在你的服务范围内"
        : "校园知识库中没有收录能支撑该问题的资料（未覆盖词：" + ((preTrace.uncoveredTerms || []).join("、") || "无") + "）";
      msgs.push({
        role: "system",
        content: "系统已先做过一次校园知识库检索：" + why + "。" +
          "因此不要编造任何本校的具体事实（地址、时间、电话、费用、制度）；" +
          "可以礼貌说明未收录并给出求助渠道，若问题本身属于通用知识则正常回答。",
      });
    }

    return msgs.concat(this.history.slice(-11));
  }

  _trim() {
    if (this.history.length > 14) this.history = this.history.slice(-14);
  }

  /** 把工具返回的结构化数据交给外部（地图/图谱联动） */
  addAnswerCards(bubble, toolCalls) {
    (toolCalls || []).forEach(t => {
      const tr = t.trace;
      if (!tr) return;
      if (tr.kind === "status" && tr.list && tr.list.length) {
        this.addCard(bubble, {
          type: "schedule", title: "实时场所状态（" + (tr.weekday || "") + " " + (tr.at || "") + "）",
          rows: tr.list.slice(0, 8).map(p => [p.name, p.today || "今日不开放", p.open]),
          note: "该结果由场所开放时段与当前时间实时计算得出。",
        });
      }
      if (tr.kind === "navigate" && tr.to) {
        const rag = window.RAG;
        const from = rag.findPlace(tr.from), to = rag.findPlace(tr.to);
        if (from && to) {
          const route = rag.shortestPath(from.id, to.id);
          this.addCard(bubble, {
            type: "route", title: "步行导航",
            from: tr.from, to: tr.to, distance: tr.distance || route.distance,
            minutes: tr.minutes, path: route.nodes.map(n => n.name),
          });
        }
      }
      if (tr.kind === "form" && tr.found) {
        this.addCard(bubble, {
          type: "form", name: tr.name, department: tr.department, location: tr.location,
          duration: tr.duration, materials: tr.materials, steps: tr.steps,
        });
      }
    });
  }
}

/* ============================================================
 * 语音输入输出
 *
 * 输入：Web Speech API 的 SpeechRecognition（Chrome/Edge 支持最好）。
 * 输出：speechSynthesis。浏览器 TTS 不提供音频流，所以口型由
 *       avatar 模块用"文本驱动 + 语速包络"近似，而不是伪造成音频分析。
 * ============================================================ */
class SpeechIO {
  constructor(chat) {
    this.chat = chat;
    this.ctx = chat.ctx;
    this.rec = null;
    this.recOn = false;
    this.finalText = "";
    this._init();
  }

  _init() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = this.chat.btnVoice;
    if (!SR) {
      if (btn) { btn.style.opacity = ".4"; btn.title = "当前浏览器不支持语音识别（推荐 Chrome / Edge）"; }
      return;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.finalText += t;
        else interim += t;
      }
      this.chat.input.value = (this.finalText + interim).trim();
      this.chat.setTip("正在识别…松开麦克风即可发送");
    };
    rec.onerror = (e) => {
      const map = { "not-allowed": "麦克风权限被拒绝", "no-speech": "没有听到声音", "audio-capture": "未检测到麦克风" };
      this.chat.setTip(map[e.error] || ("语音识别出错：" + e.error));
      this._ui(false);
    };
    rec.onend = () => this._ui(false);
    this.rec = rec;
  }

  start() {
    if (!this.rec || this.recOn) return;
    this.finalText = "";
    try {
      this.rec.start();
      this.recOn = true;
      this._ui(true);
      this.ctx.avatar.setListening(true);
      this.ctx.setStatus("listening", "正在聆听…");
      this.chat.setTip("正在聆听，说完松开按钮");
    } catch (e) {
      this.chat.setTip("无法启动语音识别：" + e.message);
    }
  }

  stopAndSend() {
    if (this.recOn) { try { this.rec.stop(); } catch (e) { /* 忽略 */ } }
    this._ui(false);
    this.ctx.avatar.setListening(false);
    /* 等识别结果回填后再发送 */
    setTimeout(() => {
      const t = this.chat.input.value.trim();
      if (t) { this.chat.input.value = ""; this.chat.send(t); }
      else this.chat.setTip("没有识别到内容，请重试或直接打字");
    }, 420);
  }

  stop() {
    if (this.recOn) { try { this.rec.stop(); } catch (e) { /* 忽略 */ } }
    this._ui(false);
    this.ctx.avatar.setListening(false);
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ } }
    this.ctx.avatar.stopSpeaking();
  }

  _ui(on) {
    this.recOn = on;
    const btn = this.chat.btnVoice;
    if (btn) btn.classList.toggle("rec", on);
    this.ctx.avatar.setListening(on);
  }

  /** 播报回答，同时驱动数字人口型与声波频谱 */
  speak(text) {
    const cfg = this.ctx.config;
    if (!cfg.tts || !text) { this.chat.setTip(""); return; }
    if (!window.speechSynthesis) return;
    const clean = String(text)
      .replace(/[*#`>|]/g, " ")
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 420);
    if (!clean.trim()) return;

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    const voice = this._pickVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "zh-CN"; }
    u.rate = 1.04;
    u.pitch = this.ctx.getRole() === "male" ? 1.06 : 1.12;
    u.onstart = () => {
      this.ctx.avatar.startSpeaking(clean);
      this.ctx.setStatus("speaking", "播报中…");
    };
    u.onend = () => {
      this.ctx.avatar.stopSpeaking();
      this.ctx.setStatus("idle", "还有什么想问我的？");
    };
    u.onerror = () => {
      this.ctx.avatar.stopSpeaking();
      this.ctx.setStatus("idle", "播报失败，可继续文字交流");
    };
    window.speechSynthesis.speak(u);
    this.chat.setTip("播报中，可随时继续提问");
  }

  _pickVoice() {
    const cfg = this.ctx.config;
    const voices = window.speechSynthesis.getVoices() || [];
    const zh = voices.filter(v => /zh|Chinese|中文/i.test(v.lang + v.name));
    const isMale = this.ctx.getRole() === "male";
    const override = isMale ? cfg.voiceMale : cfg.voiceFemale;
    if (override) {
      const hit = voices.find(v => v.name === override);
      if (hit) return hit;
    }
    /* 按角色择优：男声偏好云希/云健一类清亮音色，女声偏好晓晓/晓伊 */
    const score = (v) => {
      const n = v.name;
      if (isMale) {
        if (/yunxi|yunjian|kangkang|yiyang/i.test(n)) return 6;
        if (/yunyang|yunye/i.test(n)) return 4;
        if (/male|男/i.test(n)) return 3;
        if (/female|女|xiaoyi|xiaoxiao|yaoyao/i.test(n)) return -4;
        return 1;
      }
      if (/xiaoxiao|xiaoyi|xiaomo|yaoyao|yunxia/i.test(n)) return 6;
      if (/huihui|xiaohan/i.test(n)) return 5;
      if (/female|女/i.test(n)) return 3;
      if (/male|男|yunxi|yunjian/i.test(n)) return -4;
      return 1;
    };
    return zh.slice().sort((a, b) => score(b) - score(a))[0] || voices[0] || null;
  }

  finish() {
    this.chat.setTip("");
  }
}

export { BOT_META };
