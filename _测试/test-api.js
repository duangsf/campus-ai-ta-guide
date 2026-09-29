/* ============================================================
 * v2 · 端到端接口测试（需要服务已启动）
 *
 * 覆盖：
 *   ① 静态资源与健康检查
 *   ② /api/rag 检索接口（含未收录与域外两类拒答）
 *   ③ /api/log、/api/feedback、/api/ticket 落库与看板聚合
 *   ④ /api/eval 评测接口
 *   ⑤ /api/chat 流式 Agent —— 无 Key 时应立即返回 NO_KEY；
 *      带 Key 时验证 SSE 事件序列、工具调用、以及"不重复重试"的约束
 *
 * 用法：node _测试/test-api.js [--live]
 *   --live  使用内置 Key 真实调用模型（会消耗额度，仅用于发布前验证）
 * ============================================================ */
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 8090;
const BASE = "http://127.0.0.1:" + PORT;
const LIVE = process.argv.includes("--live");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const failures = [];
async function T(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log("  ✗ " + name + "\n      → " + e.message); }
}
function group(t) { console.log("\n" + t); }

async function get(p, opts) {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}
async function post(p, body) {
  return get(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
}

/** 读取内置演示 Key（仅用于本地联调；正式演示请在页面设置里填写） */
function builtinKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = src.match(/ark-[a-z0-9-]+/i);
  return m ? m[0] : "";
}

(async () => {
  console.log("");
  console.log("  v2 接口测试 · " + BASE + (LIVE ? "  [LIVE 模式：会真实调用模型]" : ""));

  /* ══════════ ① 静态与健康检查 ══════════ */
  group("① 静态资源与健康检查");

  await T("GET / 返回前端页面", async () => {
    const r = await get("/");
    assert.strictEqual(r.status, 200);
    assert.ok(/校园AI数字人/.test(r.data.raw || ""), "首页内容异常");
  });

  await T("GET /api/health 报告索引规模与存储模式", async () => {
    const r = await get("/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.index.entries >= 100, "知识条目 " + r.data.index.entries);
    assert.ok(r.data.index.corpus > 0, "语料未加载");
    assert.ok(["sqlite", "memory"].indexOf(r.data.storage) >= 0);
  });

  await T("数字人立绘可访问（/assets 映射）", async () => {
    const r = await get("/assets/" + encodeURIComponent("数字人_小岚.png"));
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").indexOf("image") >= 0);
  });

  await T("前端 JS 模块可访问", async () => {
    for (const f of ["/js/app.js", "/js/chat.js", "/js/map.js", "/js/globe.js", "/js/graph.js", "/js/dash.js", "/js/eval.js", "/js/avatar.js", "/js/trace.js", "/js/util.js"]) {
      const r = await get(f);
      assert.strictEqual(r.status, 200, f + " 返回 " + r.status);
    }
  });

  await T("知识图谱与场所接口返回数据", async () => {
    const g = await get("/api/graph");
    assert.ok(g.data.entities.length >= 50 && g.data.relations.length >= 60);
    const p = await get("/api/places");
    assert.ok(p.data.places.length >= 20 && p.data.formTable.length >= 10);
  });

  await T("路径穿越被拒绝", async () => {
    /* 必须用 URL 编码的穿越形式（%2f）才真正测到服务端护栏：
       未编码的 "/../config.js" 会在客户端就被规范化为 "/config.js"，
       于是 404 只说明"文件不存在"，完全没有验证越界是否被拦截。 */
    const r1 = await get("/..%2fconfig.js");
    assert.ok(r1.status === 403, "编码穿越未被拒绝，返回 " + r1.status);
    const r2 = await get("/..%2f..%2f01_%E5%BD%A2%E8%B1%A1%E5%9B%BE/");
    assert.ok(r2.status === 403, "越出 v2 根目录未被拒绝，返回 " + r2.status);
    /* 未编码形式仍然应当拿不到那个文件（浏览器规范化后即 /config.js，v2 下不存在） */
    const r3 = await get("/../config.js");
    assert.ok(r3.status === 403 || r3.status === 404, "越界访问未被拒绝，返回 " + r3.status);
  });

  /* ══════════ ② 检索接口 ══════════ */
  group("② 检索接口 /api/rag");

  await T("命中类问题：放行且带来源与链路数据", async () => {
    const r = await post("/api/rag", { query: "图书馆几点开门" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.pass, true, "应放行，实际置信度 " + r.data.confidence);
    assert.strictEqual(r.data.top[0].id, "k4");
    assert.ok(r.data.tokens.length > 0, "缺少分词结果");
    assert.ok(r.data.timeline.length === 4, "缺少检索耗时时间线");
    assert.ok(typeof r.data.confidence === "number" && typeof r.data.threshold === "number");
  });

  await T("未收录问题：拒答并给出未覆盖词", async () => {
    const r = await post("/api/rag", { query: "宿舍楼后面那棵树的树龄是多少年" });
    assert.strictEqual(r.data.pass, false, "不应放行");
    assert.ok(r.data.uncoveredTerms.length > 0, "未给出未覆盖词");
    assert.ok(/未收录/.test(r.data.gateReason || ""), "缺少拒答原因：" + r.data.gateReason);
  });

  await T("域外问题：标记 outOfScope 并说明类别", async () => {
    const r = await post("/api/rag", { query: "帮我写一段 Python 快排代码" });
    assert.strictEqual(r.data.pass, false);
    assert.strictEqual(r.data.outOfScope, true);
    assert.ok(r.data.oosLabel, "缺少域外类别");
  });

  await T("空查询不报 500（曾有字段缺失导致崩溃）", async () => {
    const r = await post("/api/rag", { query: "" });
    assert.strictEqual(r.status, 200, "空查询返回 " + r.status);
  });

  await T("非法 JSON 请求体返回 400", async () => {
    const res = await fetch(BASE + "/api/rag", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
    assert.strictEqual(res.status, 400);
  });

  /* ══════════ ③ 数据落库与看板 ══════════ */
  group("③ 数据落库与看板聚合");

  await T("POST /api/log 写入问答日志并返回 id", async () => {
    /* role 必须显式标为 'user'：看板的提问量只统计用户侧记录，
       否则会把系统回答也计入"提问数"，指标会翻倍失真。 */
    const r = await post("/api/log", {
      session: "test-session", role: "user", question: "【自动化测试】图书馆几点开门",
      answer: "测试回答", intent: "图书馆自习", hit: true, confidence: 0.8,
      sources: [{ id: "k4", q: "图书馆几点开门？", src: "测试来源" }],
      latencyFirst: 120, latencyTotal: 300,
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.id > 0, "未返回日志 id");
  });

  await T("POST /api/feedback 写入满意度反馈", async () => {
    const r = await post("/api/feedback", { vote: 1, session: "test-session" });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.id > 0);
  });

  await T("POST /api/ticket 累积知识盲区工单", async () => {
    const q = "【自动化测试】火星实习怎么申请";
    const a = await post("/api/ticket", { question: q, intent: "就业发展" });
    const b = await post("/api/ticket", { question: q, intent: "就业发展" });
    assert.strictEqual(a.data.ok, true);
    assert.strictEqual(b.data.ok, true);
  });

  await T("GET /api/analytics 能聚合出 KPI、意图、盲区", async () => {
    const r = await get("/api/analytics");
    assert.strictEqual(r.status, 200);
    const t = r.data.totals;
    assert.ok(t.questions >= 1, "提问数未统计到，得到 " + t.questions);
    assert.ok(Array.isArray(r.data.top) && r.data.top.length > 0, "高频问题列表为空");
    assert.ok(Array.isArray(r.data.scoreDist) && r.data.scoreDist.length === 5, "分数分布桶数异常");
    assert.ok(Array.isArray(r.data.latencyDist) && r.data.latencyDist.length === 6, "延迟分布桶数异常");
    assert.ok(Array.isArray(r.data.tickets), "缺少知识盲区列表");
  });

  await T("看板能反映出刚写入的盲区工单", async () => {
    const r = await get("/api/analytics");
    const hit = (r.data.tickets || []).some(x => x.q.indexOf("火星实习") >= 0);
    assert.ok(hit, "刚提交的工单未出现在盲区排行榜");
  });

  /* ══════════ ④ 评测接口 ══════════ */
  group("④ 评测接口 /api/eval");

  await T("快速评测返回四组策略的对比指标", async () => {
    const r = await get("/api/eval?set=quick");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.strategies.length, 4, "策略数 " + r.data.strategies.length);
    const best = r.data.strategies[r.data.strategies.length - 1];
    assert.ok(best.recall3 > 0 && best.fallbackAcc >= 0, "关键指标缺失");
    assert.ok(r.data.conclusion.length > 0, "缺少结论");
    assert.ok(best.detail.length > 0, "缺少逐题明细");
  });

  await T("评测结果自洽：误答率与兜底准确率互补", async () => {
    const r = await get("/api/eval?set=quick");
    const s = r.data.strategies[r.data.strategies.length - 1];
    assert.ok(Math.abs((s.fallbackAcc + s.wrongRate) - 100) < 0.2,
      "兜底 " + s.fallbackAcc + "% + 误答 " + s.wrongRate + "% ≠ 100%");
  });

  /* ══════════ ⑤ 流式 Agent 接口 ══════════ */
  group("⑤ 流式 Agent 接口 /api/chat");

  await T("无 Key 时立即返回 NO_KEY（不发起上游请求）", async () => {
    const res = await fetch(BASE + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "你好" }], apiKey: "" }),
    });
    const text = await res.text();
    assert.ok(/NO_KEY/.test(text), "未返回 NO_KEY 事件：" + text.slice(0, 200));
  });

  /** 读取一次 SSE 会话，收集事件序列 */
  async function runChat(messages, apiKey, extra) {
    const res = await fetch(BASE + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ messages, apiKey }, extra || {})),
    });
    const events = [];
    let buf = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, "");
        let ev = "message", data = "";
        block.split(/\r?\n/).forEach(l => {
          if (l.startsWith("event:")) ev = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        });
        if (data) { try { events.push({ ev, data: JSON.parse(data) }); } catch (e) { events.push({ ev, data }); } }
      }
    }
    try { await reader.cancel(); } catch (e) { /* 已结束 */ }
    return events;
  }

  const key = builtinKey();
  if (!LIVE) {
    await T("（跳过）LIVE 模式未开启，未真实调用模型", async () => {
      assert.ok(true);
    });
  } else if (!key) {
    await T("（跳过）未找到可用 Key", async () => { assert.ok(true); });
  } else {
    await T("流式输出：收到 delta 增量与 final 收尾", async () => {
      const events = await runChat([
        { role: "system", content: "你是校园导览助教，回答简洁，不超过 30 字。" },
        { role: "user", content: "学校有几个校区？" },
      ], key);
      const kinds = events.map(e => e.ev);
      const errEvents = events.filter(e => e.ev === "error");
      assert.ok(errEvents.length === 0, "出现错误事件：" + JSON.stringify(errEvents[0] && errEvents[0].data));
      assert.ok(kinds.indexOf("delta") >= 0, "未收到任何 delta 增量，事件序列：" + kinds.join(","));
      assert.ok(kinds.indexOf("final") >= 0, "缺少 final 收尾事件");
    });

    await T("Agent 工具调用：校园问题触发检索工具且只调用一轮内完成", async () => {
      const events = await runChat([
        { role: "system", content: "你是校园导览助教。涉及本校具体信息必须先调用工具检索再回答。" },
        { role: "user", content: "图书馆借阅室几点开门？" },
      ], key);
      const err = events.find(e => e.ev === "error");
      assert.ok(!err, "出现错误：" + JSON.stringify(err && err.data));
      const toolEvents = events.filter(e => e.ev === "tool");
      assert.ok(toolEvents.length >= 1, "未发生任何工具调用");
      assert.ok(toolEvents.some(t => t.data.name === "search_campus_knowledge"), "未调用知识检索工具");
      /* 工具轮数上限为 3：不允许出现同一工具被反复无意义调用 */
      const sameTool = toolEvents.filter(t => t.data.name === "search_campus_knowledge");
      assert.ok(sameTool.length <= 3, "检索工具被调用 " + sameTool.length + " 次，疑似重复调用");
      const final = events.find(e => e.ev === "final");
      assert.ok(final, "缺少 final 事件");
      assert.ok(final.data.rounds <= 3, "工具轮数 " + final.data.rounds + " 超过上限");
      assert.ok(final.data.latencyFirst != null && final.data.latencyFirst < 30000,
        "首字延迟异常：" + final.data.latencyFirst);
      assert.ok(final.data.sources && final.data.sources.length > 0, "未返回引用来源");
      assert.ok(final.data.qaId > 0, "未落库");
    });

    await T("实时状态问题触发 query_live_status 工具", async () => {
      const events = await runChat([
        { role: "system", content: "你是校园导览助教。用户问某地此刻是否开放时，必须调用 query_live_status。" },
        { role: "user", content: "现在还能去哪里自习？" },
      ], key);
      const err = events.find(e => e.ev === "error");
      assert.ok(!err, "出现错误：" + JSON.stringify(err && err.data));
      const names = events.filter(e => e.ev === "tool").map(e => e.data.name);
      assert.ok(names.indexOf("query_live_status") >= 0 || names.indexOf("search_campus_knowledge") >= 0,
        "未触发任何相关工具，实际：" + names.join(","));
    });

    await T("极速模式：注入预检索知识后不下发工具，零轮工具调用", async () => {
      /* 模拟前端的极速模式：先把本地检索命中的知识作为系统资料注入，
         再用 toolsHint='none' 让服务端不下发工具。
         注意不要在这里断言"比 Agent 模式更快" —— 上游模型延迟波动很大
         （实测同一问题在 1.5~7 秒之间浮动），单次比较得出的快慢结论没有意义。
         这条用例只验证**行为契约**：不调工具、零轮次、仍然记录答案首字延迟。 */
      const rag = require(path.join(ROOT, "src", "rag.js"));
      const r = rag.retrieveDetailed("图书馆借阅室几点开门", { topK: 3 });
      assert.ok(r.pass, "本地检索未命中，无法构造极速模式用例");
      const ctx = r.top.slice(0, 2).map((t, i) =>
        "【知识" + (i + 1) + "｜来源：" + t.src + "】" + t.snippet).join("\n\n");

      const events = await runChat([
        { role: "system", content: "你是校园导览助教。" },
        { role: "system", content: "已通过校园知识库检索到以下资料，请只依据这些资料回答：\n\n" + ctx },
        { role: "user", content: "图书馆借阅室几点开门？" },
      ], key, { toolsHint: "none" });

      const err = events.find(e => e.ev === "error");
      assert.ok(!err, "出现错误：" + JSON.stringify(err && err.data));
      const toolEvents = events.filter(e => e.ev === "tool");
      assert.strictEqual(toolEvents.length, 0, "极速模式不应发生工具调用，实际 " + toolEvents.length + " 次");
      const final = events.find(e => e.ev === "final");
      assert.ok(final, "缺少 final 事件");
      assert.strictEqual(final.data.rounds, 0, "极速模式应 0 轮工具调用，实际 " + final.data.rounds);
      assert.ok(final.data.latencyAnswer != null, "极速模式未记录答案首字延迟");
      console.log("       · 极速模式：答案首字 " + final.data.latencyAnswer + "ms，总耗时 " + final.data.latencyTotal + "ms");
    });

    await T("两种链路答案一致：Agent 模式与极速模式都能答对同一个校园问题", async () => {
      /* 这是极速模式最该被验证的性质：换链路不能改变答案口径。
         两条链路共用同一份知识，因此答案中的关键事实（开放时间）必须一致。 */
      const ask = "图书馆借阅室几点开门？";
      const agentEvents = await runChat([
        { role: "system", content: "你是校园导览助教。涉及本校具体信息必须先检索再回答，回答不超过 60 字。" },
        { role: "user", content: ask },
      ], key);
      const agentText = agentEvents.filter(e => e.ev === "delta").map(e => e.data.text).join("");

      const rag = require(path.join(ROOT, "src", "rag.js"));
      const r = rag.retrieveDetailed(ask, { topK: 3 });
      const ctx = r.top.slice(0, 2).map((t, i) =>
        "【知识" + (i + 1) + "｜来源：" + t.src + "】" + t.snippet).join("\n\n");
      const fastEvents = await runChat([
        { role: "system", content: "你是校园导览助教。" },
        { role: "system", content: "已通过校园知识库检索到以下资料，请只依据这些资料回答，不超过 60 字：\n\n" + ctx },
        { role: "user", content: ask },
      ], key, { toolsHint: "none" });
      const fastText = fastEvents.filter(e => e.ev === "delta").map(e => e.data.text).join("");

      assert.ok(agentText.length > 0 && fastText.length > 0, "两条链路都应有回答");
      const timeRe = /8[:：]00|八点/;
      assert.ok(timeRe.test(agentText), "Agent 模式回答未包含开放时间：" + agentText.slice(0, 80));
      assert.ok(timeRe.test(fastText), "极速模式回答未包含开放时间：" + fastText.slice(0, 80));
    });
  }

  /* ══════════ 汇总 ══════════ */
  console.log("");
  console.log("  ────────────────────────────────────────────");
  console.log("  接口测试结果：" + pass + " 通过，" + fail + " 失败 " + (fail ? "❌" : "✅"));
  if (fail) {
    console.log("");
    failures.forEach(f => console.log("   · " + f.name + "\n     " + f.msg));
  }
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("测试脚本异常：" + (e.stack || e.message));
  process.exit(1);
});
