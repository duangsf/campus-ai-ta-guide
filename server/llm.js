/* ============================================================
 * v2 · 云端大模型流式代理（SSE）
 *
 * 与 v1（server.js 里 stream:false 的一次性转发）的核心区别：
 *  1. 真流式：向模型请求 stream:true，逐 token 边收边推给浏览器（SSE），
 *     首字延迟从秒级降到百毫秒级；
 *  2. 流式 tool_calls 聚合：把 OpenAI 兼容接口按增量下发的 tool_calls
 *     （index + 分片 arguments）正确拼装成完整调用，支持多工具并发；
 *  3. **有界重试 + 安全重试点**：只对"网络抖动 / 429 / 5xx"这类瞬时故障重试，
 *     且一旦已经开始向浏览器推送 delta 就绝不再重试 —— 否则前端会收到
 *     重复的正文片段，出现文字重影（流式场景下最典型的坑）。
 *
 * SSE 事件协议（server → client）：
 *   event: meta         { model, base, attempt? }
 *   event: retry        { attempt, max, reason, waitMs }   让重试在界面上可见
 *   event: delta        { text }                           逐字增量
 *   event: tool_calls   { calls:[{id,name,arguments}] }     一轮工具调用结束
 *   event: usage        { prompt_tokens, completion_tokens }
 *   event: done         { content, toolCalls, finish }
 *   event: error        { code, status, message }
 * ============================================================ */
"use strict";

const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DEFAULT_MODEL = "DeepSeek-V4-Flash";

/* 只有瞬时故障才重试：网络层错误、限流、上游 5xx。
   401/403/404 属于配置错误，重试没有意义，应直接把原因告诉用户。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const MAX_ATTEMPTS = 3;

function base() { return process.env.DS_BASE_URL || DEFAULT_BASE; }

/**
 * 发起一次流式对话补全（含安全重试）。
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]
 * @param {(evt:string, data:object)=>void} opts.emit
 * @returns {Promise<{content:string, toolCalls:Array, usage:object, finish:string, error?:object}>}
 */
async function streamChat(opts) {
  const { messages, tools, temperature, emit } = opts;
  let lastError = null;

  /** 决定是否重试：指数退避 + 抖动，并把重试动作告诉前端（链路里可见） */
  async function maybeRetry(att, err, hasEmitted) {
    if (att >= MAX_ATTEMPTS) return false;
    if (hasEmitted) {
      emit("error", {
        code: "UPSTREAM_AFTER_DELTA",
        status: err.status,
        message: err.message + "（已开始输出，不再重试以避免内容重复）",
      });
      return false;
    }
    if (err.status && !RETRYABLE_STATUS.has(err.status)) return false;
    const waitMs = Math.min(4000, 400 * Math.pow(2, att - 1)) + Math.floor(Math.random() * 250);
    emit("retry", { attempt: att, max: MAX_ATTEMPTS, reason: err.message, waitMs });
    await sleep(waitMs);
    return true;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    /* 安全重试点：本轮是否已经把正文推给浏览器。
       只要推过 delta，用户就已经看到部分回答，此时宁可报错也不能重来。 */
    let emitted = false;
    const safeEmit = (evt, data) => {
      if (evt === "delta") emitted = true;
      emit(evt, data);
    };

    const body = {
      model: opts.model || DEFAULT_MODEL,
      messages,
      temperature: temperature == null ? 0.5 : temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = "auto"; }

    let res;
    try {
      res = await fetch(base() + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs || 110000),
      });
    } catch (e) {
      lastError = { status: 0, message: "无法连接模型服务：" + (e.message || e) };
      if (!(await maybeRetry(attempt, lastError, emitted))) break;
      continue;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      lastError = { status: res.status, message: cleanUpstreamError(res.status, raw) };
      if (!(await maybeRetry(attempt, lastError, emitted))) break;
      continue;
    }
    if (!res.body) {
      lastError = { status: 502, message: "上游未返回流式响应体" };
      if (!(await maybeRetry(attempt, lastError, emitted))) break;
      continue;
    }

    emit("meta", attempt > 1
      ? { model: body.model, base: base(), attempt }
      : { model: body.model, base: base() });

    const parsed = await readStream(res.body, safeEmit);
    if (parsed.streamError) {
      lastError = { status: 0, message: parsed.streamError };
      /* 注意：流中断时通常已经推过 delta，maybeRetry 会自动拒绝重试，
         并把"已开始输出不再重试"的原因发回前端。 */
      if (!(await maybeRetry(attempt, lastError, emitted))) {
        return parsed;
      }
      continue;
    }
    return parsed;
  }

  return { error: lastError || { status: 0, message: "模型服务不可用" } };
}

/** 解析 SSE 流，聚合成完整回答与 tool_calls */
async function readStream(stream, emit) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  let finish = "";
  let usage = null;
  const callMap = new Map();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json;
          try { json = JSON.parse(payload); } catch (e) { continue; }
          if (json.usage) usage = json.usage;
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const delta = choice.delta || {};
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            emit("delta", { text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index == null ? 0 : tc.index;
              const slot = callMap.get(idx) || { id: "", name: "", arguments: "" };
              if (tc.id) slot.id = tc.id;
              if (tc.function) {
                if (tc.function.name) slot.name += tc.function.name;
                if (tc.function.arguments) slot.arguments += tc.function.arguments;
              }
              callMap.set(idx, slot);
            }
          }
        }
      }
    }
  } catch (e) {
    /* 流中途断开：保留已收到的内容，并标记错误供上层判断能否重试 */
    return {
      content, toolCalls: collect(callMap), usage,
      finish: finish || "interrupted",
      streamError: "流式响应中断：" + (e.message || e),
    };
  }

  const toolCalls = collect(callMap);
  if (usage) emit("usage", usage);
  if (toolCalls.length) emit("tool_calls", { calls: toolCalls });
  emit("done", { content, toolCalls, finish: finish || "stop" });
  return { content, toolCalls, usage, finish };
}

function collect(callMap) {
  return [...callMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter(c => c.name);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanUpstreamError(status, raw) {
  let detail = "";
  try {
    const j = JSON.parse(raw);
    detail = (j.error && (j.error.message || j.error.code)) || j.message || "";
  } catch (e) { detail = String(raw || "").slice(0, 200); }
  const hint = status === 401 ? "（API Key 无效或已过期）"
    : status === 403 ? "（无权限访问该模型）"
      : status === 404 ? "（模型名或接口地址不正确）"
        : status === 429 ? "（请求过于频繁或额度不足，建议降低频率）"
          : status >= 500 ? "（上游服务异常）" : "";
  return "模型服务返回 HTTP " + status + hint + (detail ? "：" + detail : "");
}

module.exports = { streamChat, base, DEFAULT_MODEL, MAX_ATTEMPTS };
