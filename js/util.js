/* ============================================================
 * v2 前端 · 基础工具
 * ============================================================ */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export function fmtMs(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
}

export function fmtPct(v, digits) {
  if (v == null || isNaN(v)) return "—";
  return (+v).toFixed(digits == null ? 1 : digits) + "%";
}

/** 当前时间 HH:MM */
export function hhmm(d) {
  const t = d || new Date();
  return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
}

export function toast(msg, kind) {
  const host = $("toastHost");
  if (!host) return;
  const n = el("div", "toast" + (kind ? " " + kind : ""), msg);
  host.appendChild(n);
  setTimeout(() => {
    n.style.transition = "opacity .3s, transform .3s";
    n.style.opacity = "0";
    n.style.transform = "translateY(8px)";
    setTimeout(() => n.remove(), 320);
  }, kind === "err" ? 4200 : 2400);
}

export function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** 轻量节流（用于拖拽/缩放等高频事件） */
export function rafThrottle(fn) {
  let queued = false;
  return function (...args) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn.apply(this, args); });
  };
}

/** 从 localStorage 读 JSON（容错） */
export function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

export function writeStore(key, value) {
  /* 隐私模式或配额满时 localStorage 会抛异常，静默忽略即可 —— 配置写不进去不影响演示 */
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
}

/** 统一的后端请求封装 */
export async function api(path, opts) {
  const res = await fetch(path, Object.assign({
    headers: { "Content-Type": "application/json" },
  }, opts || {}));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ("HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ============================================================
 * SSE 流式对话客户端
 *
 * 事件协议（与 server/llm.js 保持一致）：
 *   meta / first_token / delta / tool_calls / tool / usage / final / error / done
 *
 * 为什么不直接用 EventSource：
 *   EventSource 只支持 GET，无法携带 messages/tools 这样的请求体。
 *   所以用 fetch + ReadableStream 手工解析 SSE，这也是流式对话的标准做法。
 * ============================================================ */
export async function streamChat(payload, handlers, signal) {
  const h = handlers || {};
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = "HTTP " + res.status;
    try { const j = await res.json(); detail = j.error || j.message || detail; } catch (e) { /* 忽略 */ }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const dispatch = (event, data) => {
    if (h[event]) { try { h[event](data); } catch (e) { console.error("[sse handler]", event, e); } }
    if (h.onAny) { try { h.onAny(event, data); } catch (e) { /* 忽略 */ } }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
      let ev = "message", data = "";
      block.split(/\r?\n/).forEach(line => {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      });
      if (!data) continue;
      let parsed = null;
      try { parsed = JSON.parse(data); } catch (e) { parsed = { raw: data }; }
      dispatch(ev, parsed);
    }
  }
}

/** 数字滚动动画（看板 KPI 用） */
export function countUp(node, target, duration) {
  if (!node) return;
  const from = parseFloat(node.textContent) || 0;
  const to = Number(target) || 0;
  const dur = duration || 520;
  if (from === to) { node.textContent = String(to); return; }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
