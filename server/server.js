/* ============================================================
 * v2 旗舰版 · 服务端入口
 *
 * 职责：
 *   1. 静态资源托管（/assets/* 映射到本项目自带的 assets/ 目录，全部自包含）
 *   2. POST /api/chat   —— Agent 循环 + SSE 流式输出（核心）
 *   3. POST /api/rag    —— 纯本地检索（离线模式 & RAG 链路可视化用）
 *   4. GET  /api/analytics | POST /api/log | POST /api/feedback | POST /api/ticket
 *   5. GET  /api/kb | POST /api/kb | DELETE /api/kb —— 知识库后台增删改查闭环
 *   6. GET  /api/health —— 存储模式、索引规模、模型配置自检
 *
 * 零第三方依赖：仅使用 Node 内置模块 + node:sqlite。
 * ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const db = require("./db");
const llm = require("./llm");
const rag = require("../src/rag");

const PORT = process.env.PORT || 8090;
const V2_ROOT = path.join(__dirname, "..");
/* 数字人立绘等静态资源放在本项目自带的 assets/ 下（原先指向工作区的 01_形象图，
   使代码目录无法独立搬移）。 */
const IMG_DIR = path.join(V2_ROOT, "assets");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

db.init();

/* ================= 静态资源 ================= */
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
}

/* 源码类一律禁缓存：否则改完代码刷新页面，浏览器仍用旧的 js/css，会让人误以为"没修复"。
   只有体积大且极少变动的图片/字体才允许短暂缓存。
   注意 path.extname("three.module.min.js") === ".js"，所以 vendor 库同样走禁缓存，这是刻意选择：
   演示前改完代码刷新即生效，比省一次 670KB 下载重要。 */
const CACHEABLE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2"]);

function cacheControlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CACHEABLE_EXT.has(ext) ? "public, max-age=300" : "no-cache, no-store, must-revalidate";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, "Not Found: " + path.basename(filePath)); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControlFor(filePath),
    });
    res.end(data);
  });
}

function serveStatic(res, urlPath) {
  /* /assets/* → assets/（数字人立绘等，随代码目录一起分发） */
  if (urlPath.startsWith("/assets/")) {
    const rel = decodeURIComponent(urlPath.slice("/assets/".length));
    const target = path.join(IMG_DIR, rel);
    if (!target.startsWith(IMG_DIR)) { send(res, 403, "Forbidden"); return; }
    serveFile(res, target);
    return;
  }
  /* /src/* 与 /data/* 显式映射到代码目录内部。
     这样前端可以统一用根路径引用（/src/rag.js），不必写 "../src/rag.js" ——
     相对路径的"以 HTML 目录解析"语义容易让静态检查与实际行为不一致，
     显式映射后 ref 与真实文件路径一一对应，改动时不易出错。 */
  const rel = urlPath === "/" || urlPath === ""
    ? "index.html"
    : decodeURIComponent(urlPath.replace(/^\//, ""));
  const target = path.join(V2_ROOT, rel);
  if (!target.startsWith(V2_ROOT)) { send(res, 403, "Forbidden"); return; }
  serveFile(res, target);
}

/* ================= 请求体读取 ================= */
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > limit) { req.destroy(); reject(new Error("payload too large")); } });
    req.on("end", () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); }
    catch (e) { closed = true; }
  };
  const end = () => { if (!closed) { closed = true; try { res.end(); } catch (e) { } } };
  res.on("close", () => { closed = true; });
  return { send, end, isClosed: () => closed };
}

/* 回灌给模型的工具结果体积上限。
   工具返回体里同时带着"给模型看的 payload"和"给界面看的 trace/detail/sources"，
   如果原样回灌，一次检索就能把几十 KB 的中间过程塞进对话上下文，
   模型会被大量无关结构干扰，表现为反复调用同一个工具、迟迟不给答案。
   因此这里做一次裁剪 + 硬上限：这是"模型请求反复重试"的根因之一。 */
const TOOL_RESULT_MAX_CHARS = 3000;

function forModel(outcome, maxChars) {
  const limit = maxChars || TOOL_RESULT_MAX_CHARS;
  let text;
  if (outcome && outcome.error && outcome.payload === undefined) {
    text = JSON.stringify({ error: String(outcome.error) });
  } else {
    text = JSON.stringify(outcome && outcome.payload !== undefined ? outcome.payload : outcome);
  }
  if (text.length <= limit) return text;
  /* 超限时保留结构完整性：返回一个仍可被判读的截断对象 */
  return text.slice(0, limit) + '…","__truncated":true}';
}

/* ================= /api/chat · Agent 循环 ================= */
/* 一轮对话最多允许的工具轮数，防止模型陷入无限调用（成本与稳定性护栏） */
const MAX_TOOL_ROUNDS = 3;
const MAX_WALL_MS = 120000;

async function handleChat(req, res) {
  let payload;
  try { payload = await readBody(req); }
  catch (e) { send(res, 400, JSON.stringify({ error: e.message }), MIME[".json"]); return; }

  const out = sse(res);
  const started = Date.now();
  const session = payload.session || "anon";
  const apiKey = payload.apiKey || process.env.DEEPSEEK_API_KEY || "";
  const question = lastUserText(payload.messages || []);

  if (!apiKey) {
    out.send("error", { code: "NO_KEY", message: "未配置 API Key：请在「设置」中填写，或使用本地知识库模式。" });
    out.end();
    return;
  }

  const messages = (payload.messages || []).slice();
  /* 极速模式下前端已注入预检索结果，服务端不下发工具，避免又走一轮工具调用 */
  const toolsDisabled = payload.toolsHint === "none";
  const tools = toolsDisabled ? [] : rag.toolSpecs();
  const usedTools = [];            // 已调用过的工具名，回灌给模型避免重复调用
  let rounds = 0;
  let firstTokenAt = null;      // 第一次任何输出（可能只是工具调用决策）
  let firstAnswerAt = null;     // 最终答案的第一个字 —— 用户真正感知的等待
  const allSources = [];
  let finalText = "";
  let lastTrace = null;

  try {
    while (rounds <= MAX_TOOL_ROUNDS) {
      if (Date.now() - started > MAX_WALL_MS) {
        out.send("error", { code: "TIMEOUT", message: "总耗时超过 " + Math.round(MAX_WALL_MS / 1000) + " 秒，已中止。" });
        break;
      }
      const isLastRound = rounds >= MAX_TOOL_ROUNDS;
      /* 本轮第一个 delta 的时间戳。注意不能直接把它当成"答案首字"：
         模型可能先说一句"我查一下资料"再发起工具调用，那是过程说明而非答案。
         真正的答案轮要等本轮结束、确认没有 tool_calls 才能判定，
         所以这里先记录时间戳，循环尾部再回溯认定。 */
      let roundTokenAt = null;

      const emit = (evt, data) => {
        if (evt === "delta") {
          if (firstTokenAt == null) { firstTokenAt = Date.now(); out.send("first_token", { at: firstTokenAt - started }); }
          if (roundTokenAt == null) roundTokenAt = Date.now();
          out.send("delta", data);
        } else out.send(evt, data);
      };

      /* 最后一轮不再下发工具，并追加"禁止再调用工具"的硬约束，
         避免模型在拿到资料后仍反复要求检索而空转。 */
      const roundMessages = isLastRound ? messages.concat([{
        role: "user",
        content: "（系统提示：资料已足够，请立即基于以上工具返回的资料直接作答，不要再请求调用任何工具。）",
      }]) : messages;
      const hint = usedTools.length && !isLastRound
        ? "（系统提示：本轮你已经调用过 " + usedTools.join("、") +
        "，请直接基于已有结果回答；仅当确实缺少关键信息时才再次调用工具，且不要用相同参数重复调用。）"
        : null;
      if (hint) roundMessages.push({ role: "user", content: hint });

      const result = await llm.streamChat({
        apiKey, model: payload.model, messages: roundMessages,
        tools: (isLastRound || toolsDisabled) ? undefined : tools,
        temperature: rounds === 0 ? payload.temperature : 0.2,
        emit,
      });

      if (result.error) {
        out.send("error", { code: "UPSTREAM", status: result.error.status, message: result.error.message });
        db.logQA({
          session, role: payload.role, question, answer: "", intent: null, strategy: payload.strategy,
          topScore: payload.topScore, confidence: payload.confidence, hit: false, sources: [],
          latencyFirst: firstTokenAt ? firstTokenAt - started : null, latencyTotal: Date.now() - started,
          degraded: false, error: result.error.message,
        });
        break;
      }

      if (result.toolCalls && result.toolCalls.length && !isLastRound) {
        rounds++;
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of result.toolCalls) {
          let args = {};
          try { args = JSON.parse(call.arguments || "{}"); } catch (e) { args = {}; }
          const t0 = Date.now();
          let outcome;
          try { outcome = rag.runTool(call.name, args); }
          catch (e) { outcome = { error: e.message }; }
          const resultSources = outcome && outcome.sources ? outcome.sources : [];
          resultSources.forEach(s => { if (!allSources.some(x => x.id === s.id)) allSources.push(s); });
          if (outcome && outcome.trace) lastTrace = outcome.trace;
          if (usedTools.indexOf(call.name) < 0) usedTools.push(call.name);
          out.send("tool", {
            name: call.name, args, ms: Date.now() - t0,
            ok: !(outcome && outcome.error),
            summary: outcome && outcome.summary ? outcome.summary : null,
            /* 界面需要结构化数据做地图/看板联动；trace 已裁剪为摘要（top 列表 + 分数） */
            sources: resultSources.map(s => ({ id: s.id, q: s.q, src: s.src, score: s.score })),
            trace: outcome && outcome.trace ? outcome.trace : null,
            detail: outcome && outcome.detail ? outcome.detail : null,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: forModel(outcome) });
        }
        continue;   // 带着工具结果再问一次模型
      }

      /* 本轮结束且没有 tool_calls → 这一轮就是"回答轮"。
         回溯认定答案首字时间：这是用户真正看到答案内容的时刻，
         与"首次响应"（可能只是模型在说明要去查资料）区分开。 */
      if (roundTokenAt != null && firstAnswerAt == null) {
        firstAnswerAt = roundTokenAt;
        out.send("first_answer", { at: firstAnswerAt - started });
      }
      finalText = result.content || "";
      if (!finalText && result.toolCalls && result.toolCalls.length) {
        out.send("error", {
          code: "TOOL_LOOP",
          message: "模型在工具调用上限内仍未给出回答，已中止以免持续消耗额度。请重试或换一种问法。",
        });
      }
      break;
    }
  } catch (e) {
    out.send("error", { code: "EXCEPTION", message: e.message || String(e) });
  }

  const latencyTotal = Date.now() - started;
  const hit = allSources.length > 0;
  const qaId = db.logQA({
    session, role: payload.role, question, answer: finalText,
    intent: lastTrace && lastTrace.intent ? lastTrace.intent : ((payload.meta && payload.meta.intent) || null),
    strategy: lastTrace && lastTrace.strategy ? lastTrace.strategy : payload.strategy,
    topScore: lastTrace && lastTrace.topScore != null ? lastTrace.topScore : payload.topScore,
    confidence: lastTrace && lastTrace.confidence != null ? lastTrace.confidence : payload.confidence,
    hit, sources: allSources.map(s => ({ id: s.id, q: s.q, src: s.src })),
    latencyFirst: firstTokenAt ? firstTokenAt - started : null,
    latencyAnswer: firstAnswerAt ? firstAnswerAt - started : null,
    latencyTotal,
    degraded: false, error: null,
  });
  if (!hit && question) db.upsertTicket({ question, intent: lastTrace && lastTrace.intent });

  out.send("final", {
    qaId, rounds,
    latencyFirst: firstTokenAt ? firstTokenAt - started : null,
    latencyAnswer: firstAnswerAt ? firstAnswerAt - started : null,
    latencyTotal, sources: allSources.map(s => ({ id: s.id, q: s.q, src: s.src, score: s.score })),
    trace: lastTrace,
  });
  out.end();
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return String(messages[i].content || "");
  }
  return "";
}

/* ================= /api/rag · 纯本地检索 ================= */
function handleRag(res, payload) {
  const started = Date.now();
  const q = String(payload.query || "");
  const result = rag.retrieveDetailed(q);
  send(res, 200, JSON.stringify({
    query: q, ...result, ms: Date.now() - started,
    elapsed: Date.now() - started,
  }), MIME[".json"]);
}

/* ================= /api/eval · 评测集消融 ================= */
function handleEval(payload) {
  const { runEvaluation, DATASET } = require("../src/eval");
  const which = payload && payload.set === "quick" ? "quick" : "full";
  return runEvaluation(which);
}

/* ================= /api/kb · 知识库后台 ================= */
function handleKbList(res) {
  const extra = db.listKbExtra();
  send(res, 200, JSON.stringify({
    total: rag.entries().length,
    base: rag.entries().filter(e => !e.extra).length,
    extra,
    categories: rag.categoryStats(),
    index: rag.indexStats(),
  }), MIME[".json"]);
}

/* ================= /api/health ================= */
function handleHealth(res) {
  send(res, 200, JSON.stringify({
    ok: true, version: "v2", storage: db.backend(),
    model: process.env.MODEL || llm.DEFAULT_MODEL,
    base: llm.base(),
    hasEnvKey: !!process.env.DEEPSEEK_API_KEY,
    index: rag.indexStats(),
    uptime: Math.round(process.uptime()),
  }), MIME[".json"]);
}

/* ================= 路由 ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (req.method === "POST" && p === "/api/chat") { await handleChat(req, res); return; }

    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); }
      catch (e) { send(res, 400, JSON.stringify({ error: e.message }), MIME[".json"]); return; }

      if (p === "/api/rag") { handleRag(res, body); return; }
      if (p === "/api/log") {
        const id = db.logQA(body);
        if (body.ticket && body.question) db.upsertTicket({ question: body.question, intent: body.intent });
        send(res, 200, JSON.stringify({ ok: true, id }), MIME[".json"]); return;
      }
      if (p === "/api/feedback") { send(res, 200, JSON.stringify({ ok: true, id: db.logFeedback(body) }), MIME[".json"]); return; }
      if (p === "/api/ticket") { send(res, 200, JSON.stringify({ ok: true, id: db.upsertTicket(body) }), MIME[".json"]); return; }
      if (p === "/api/kb/save") { send(res, 200, JSON.stringify({ ok: true, id: db.saveKbEntry(body), index: rag.reload() }), MIME[".json"]); return; }
      if (p === "/api/kb/delete") { db.deleteKbEntry(body.id); send(res, 200, JSON.stringify({ ok: true, index: rag.reload() }), MIME[".json"]); return; }
      if (p === "/api/reset") { db.reset(); send(res, 200, JSON.stringify({ ok: true }), MIME[".json"]); return; }
      if (p === "/api/eval") { send(res, 200, JSON.stringify(handleEval(body)), MIME[".json"]); return; }
      send(res, 404, JSON.stringify({ error: "unknown endpoint: " + p }), MIME[".json"]); return;
    }

    if (req.method === "GET") {
      if (p === "/api/analytics") { send(res, 200, JSON.stringify(db.analytics()), MIME[".json"]); return; }
      if (p === "/api/health") { handleHealth(res); return; }
      if (p === "/api/kb") { handleKbList(res); return; }
      if (p === "/api/eval") { send(res, 200, JSON.stringify(handleEval({ set: url.searchParams.get("set") || "full" })), MIME[".json"]); return; }
      if (p === "/api/graph") { send(res, 200, JSON.stringify(rag.graphPayload()), MIME[".json"]); return; }
      if (p === "/api/places") { send(res, 200, JSON.stringify(rag.placesPayload()), MIME[".json"]); return; }
      serveStatic(res, p); return;
    }

    send(res, 405, "Method Not Allowed");
  } catch (e) {
    console.error("[server] " + (e && e.stack ? e.stack : e));
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: e.message }), MIME[".json"]);
    else { try { res.end(); } catch (x) { } }
  }
});

/**
 * 端口冲突处理。
 *
 * Node 默认行为是把 EADDRINUSE 抛成未捕获异常，终端只打印一大段调用栈，
 * 对不熟悉 Node 的人（以及路演现场的紧张时刻）非常不友好 —— 看不出"该怎么解决"。
 * 这里显式拦截并给出可操作的指引（换端口 / 找出占用进程），然后干净退出。
 */
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error("");
    console.error("  ✗ 端口 " + PORT + " 已被占用，无法启动。");
    console.error("  ─────────────────────────────────────────");
    console.error("  三种解决方式，任选其一：");
    console.error("");
    console.error("  ① 换一个端口启动（最快）：");
    console.error("       PowerShell:  $env:PORT=\"8091\"; node .\\server\\server.js");
    console.error("       CMD:         set PORT=8091 && node .\\server\\server.js");
    console.error("     然后访问 http://localhost:8091");
    console.error("");
    console.error("  ② 先查是谁占用了端口：");
    console.error("       netstat -ano | findstr :" + PORT);
    console.error("       tasklist | findstr <上面查到的 PID>");
    console.error("     确认是旧的 node 服务后结束它：");
    console.error("       taskkill /PID <PID> /F");
    console.error("");
    console.error("  ③ 如果确实有一个服务已在运行，直接打开浏览器访问即可：");
    console.error("       http://localhost:" + PORT);
    console.error("");
    console.error("  提示：换端口不影响任何功能（数据均存放在项目目录内），也可用 $env:PORT 指定其他端口。");
    console.error("");
    process.exit(1);
  }
  console.error("");
  console.error("  ✗ 服务启动失败：" + (err && err.message ? err.message : err));
  console.error("");
  process.exit(1);
});

server.listen(PORT, () => {
  const st = rag.indexStats();
  console.log("");
  console.log("  校园AI数字人智慧导览助教 · v2 旗舰版");
  console.log("  ─────────────────────────────────────────");
  console.log("  本机访问    http://localhost:" + PORT);
  console.log("  局域网访问  http://<本机IP>:" + PORT + "   (ipconfig 查看 IP)");
  console.log("  知识条目    " + st.entries + " 条（基础 " + st.base + " + 语料 " + st.corpus + " + 后台 " + st.extra + "）");
  console.log("  图谱实体    " + st.entities + " 个 · 关系 " + st.relations + " 条");
  console.log("  检索引擎    BM25 + 2-gram 语义向量 + 图谱多跳");
  console.log("  存储模式    " + db.backend());
  console.log("  模型        " + (process.env.MODEL || llm.DEFAULT_MODEL) + " @ " + llm.base());
  console.log("  提示        云端模式请在页面右上角「设置」填入 API Key；无 Key 自动走本地知识库。");
  console.log("");
});

process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
