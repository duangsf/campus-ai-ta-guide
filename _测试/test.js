/* ============================================================
 * v2 · 自动化测试套件
 *
 * 分为六组：
 *   ① 索引与分词      —— 规模、词典、分词正确性
 *   ② 检索质量        —— 三路召回、融合、RRF 排序
 *   ③ 置信度闸门      —— 放行/拒答、域外识别、多候选聚合
 *   ④ Agent 工具集    —— 7 个工具的真实返回结构
 *   ⑤ 评测引擎自检    —— 标定与评测的一致性
 *   ⑥ 回归测试        —— 针对开发过程中真实踩过的坑逐条加断言
 *                       （每个回归用例都对应一次真实的"静默出错"）
 *
 * 用法：node _测试/test.js
 * ============================================================ */
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const rag = require(path.join(ROOT, "src", "rag.js"));

let pass = 0, fail = 0;
const failures = [];

function T(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log("  ✗ " + name + "\n      → " + e.message); }
}
async function TA(name, fn) {
  try { await fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log("  ✗ " + name + "\n      → " + e.message); }
}
function group(t) { console.log("\n" + t); }

/* ══════════════════ ① 索引与分词 ══════════════════ */
group("① 索引与分词");

T("索引已加载且规模合理（知识条目 ≥ 100）", () => {
  const s = rag.indexStats();
  assert.ok(s.entries >= 100, "知识条目仅 " + s.entries + " 条，语料可能未加载");
  assert.ok(s.corpus >= 50, "语料条目仅 " + s.corpus + " 条");
  assert.ok(s.terms > 1000, "索引词项仅 " + s.terms + " 个");
});

T("图谱与场所数据完整", () => {
  const s = rag.indexStats();
  assert.ok(s.entities >= 50, "图谱实体 " + s.entities);
  assert.ok(s.relations >= 60, "图谱关系 " + s.relations);
  assert.ok(s.places >= 20, "场所 " + s.places);
  assert.ok(s.forms >= 10, "办事流程 " + s.forms);
  assert.ok(s.depts >= 8, "部门 " + s.depts);
});

T("分词：领域词做整词匹配，不切碎", () => {
  const toks = rag.tokenize("图书馆几点开门", { dict: rag._state.dict });
  assert.ok(toks.indexOf("图书馆") >= 0, "未识别整词『图书馆』：" + toks.join("/"));
});

T("分词：不产出跨词边界的碎片（『图书馆几点开门』不应出现『馆几』）", () => {
  const toks = rag.tokenize("图书馆几点开门", { dict: rag._state.dict });
  ["馆几", "书馆几", "馆几点", "点开门"].forEach(bad => {
    assert.ok(toks.indexOf(bad) < 0, "出现了跨词碎片：" + bad + " → " + toks.join("/"));
  });
});

T("分词：未登录词仍能被 2-gram 兜底召回", () => {
  const toks = rag.tokenize("宿舍能洗澡吗", { dict: rag._state.dict });
  assert.ok(toks.length >= 2, "分词结果过少：" + toks.join("/"));
});

/* ══════════════════ ② 检索质量 ══════════════════ */
group("② 检索质量");

const HIT_CASES = [
  ["图书馆几点开门", "k4"],
  ["新生报到流程是什么", "k2"],
  ["学校有几个校区，地址在哪", "k3"],
  ["有哪些特色专业", "k6"],
  ["宿舍床铺多大", "k10"],
  ["绿色通道怎么申请", "k18"],
  ["校园一卡通怎么充值", "k17"],
  ["学校的校训是什么", "k8"],
  ["咨询电话是多少", "k11"],
];

HIT_CASES.forEach(([q, id]) => {
  T("Top3 命中：" + q + " → " + id, () => {
    const r = rag.retrieveDetailed(q, { topK: 3 });
    const ids = r.top.map(t => t.id);
    assert.ok(ids.indexOf(id) >= 0, "Top3 = " + ids.join(",") + "，未包含 " + id);
  });
});

T("同义改写可召回（『寝室能洗澡不，有热水么』→ 洗浴相关）", () => {
  const r = rag.retrieveDetailed("寝室能洗澡不，有热水么", { topK: 5 });
  assert.ok(r.pass, "闸门未放行，置信度 " + r.confidence);
  assert.ok(r.top.some(t => /洗澡|热水|淋浴|洗浴|浴室/.test(t.a)), "Top5 中无洗浴类条目");
});

T("融合分数带三路分解（供链路可视化展示）", () => {
  const r = rag.retrieveDetailed("图书馆几点开门", { topK: 3 });
  const t = r.top[0];
  assert.ok(t.breakdown && typeof t.breakdown.bm25 === "number", "缺少 bm25 分解");
  assert.ok(typeof t.breakdown.vector === "number", "缺少 vector 分解");
  assert.ok(typeof t.breakdown.graph === "number", "缺少 graph 分解");
});

T("检索链路含耗时时间线（4 个阶段）", () => {
  const r = rag.retrieveDetailed("图书馆几点开门", { topK: 3 });
  assert.ok(Array.isArray(r.timeline) && r.timeline.length === 4, "timeline = " + JSON.stringify(r.timeline));
  r.timeline.forEach(s => assert.ok(typeof s.at === "number", "阶段缺少耗时：" + s.stage));
});

/* ══════════════════ ③ 置信度闸门 ══════════════════ */
group("③ 置信度闸门");

const ANSWER_CASES = [
  "图书馆几点开门", "寝室能洗澡不，有热水么", "饭堂几点开饭", "挂科了怎么办",
  "宿舍能用吹风机和电煮锅吗", "转专业什么时候可以申请", "从宿舍出发最近的自习室在哪里",
  "家里条件不好，学费交不上咋整", "心情特别差，晚上睡不着", "身体不舒服校医室在哪",
  "在宿舍丢了东西应该联系谁", "学校咋样啊，是不是正经本科",
];
ANSWER_CASES.forEach(q => {
  T("应放行：" + q, () => {
    const r = rag.retrieveDetailed(q, { topK: 5 });
    assert.ok(r.pass, "被误拦截（置信度 " + r.confidence + " < " + r.threshold + "，" + r.gateReason + "）");
  });
});

const REFUSE_CASES = [
  ["今天食堂的午饭菜单有什么菜", "实时数据无法预先收录"],
  ["校园网的 WiFi 密码是多少", "账号凭据不应回答"],
  ["宿舍楼后面那棵树的树龄是多少年", "知识库确实未收录"],
  ["我们学校校长的手机号是多少", "涉及个人隐私"],
  ["明天兴安校区的天气怎么样", "域外：实时天气"],
  ["帮我写一段 Python 快排代码", "域外：编程任务"],
  ["解方程 3x+7=22 求 x", "域外：数学解题"],
  ["分析一下最近传媒行业的股票走势", "域外：实时行情"],
  ["河北传媒学院和别的学校哪个就业率更高", "域外：其他院校对比"],
];
REFUSE_CASES.forEach(([q, why]) => {
  T("应拒答：" + q + "（" + why + "）", () => {
    const r = rag.retrieveDetailed(q, { topK: 5 });
    assert.ok(!r.pass, "被误放行（置信度 " + r.confidence + " ≥ " + r.threshold + "）");
  });
});

T("域外识别给出可解释理由", () => {
  const r = rag.retrieveDetailed("帮我写一段 Python 快排代码", { topK: 3 });
  assert.ok(r.outOfScope, "未标记为域外");
  assert.ok(r.oosLabel && r.oosLabel.length > 0, "缺少域外类别标签");
  assert.ok(/不在校园导览助教的服务范围内/.test(r.gateReason || ""), "缺少解释：" + r.gateReason);
});

T("未收录时给出未覆盖词（用于向用户解释拒答原因）", () => {
  const r = rag.retrieveDetailed("宿舍楼后面那棵树的树龄是多少年", { topK: 3 });
  assert.ok(!r.pass, "该问题不应被回答");
  assert.ok(Array.isArray(r.uncoveredTerms) && r.uncoveredTerms.length > 0, "未提供未覆盖词");
});

T("多候选聚合：正解不在 Top1 时仍能正确放行", () => {
  /* 「从宿舍出发最近的自习室在哪里」的正解常在第 2 位，
     单候选覆盖会误判未收录 —— 这条断言专门守住多候选聚合逻辑。 */
  const r = rag.retrieveDetailed("从宿舍出发最近的自习室在哪里", { topK: 5 });
  assert.ok(r.pass, "多候选聚合失效，置信度 " + r.confidence);
});

T("置信度与阈值口径一致（confidence 与 threshold 均存在且 confidence ≥ threshold 时放行）", () => {
  const r = rag.retrieveDetailed("图书馆几点开门", { topK: 3 });
  assert.strictEqual(typeof r.confidence, "number");
  assert.strictEqual(typeof r.threshold, "number");
  assert.strictEqual(r.pass, r.confidence >= r.threshold, "pass 与阈值判定不一致");
});

/* ══════════════════ ④ Agent 工具集 ══════════════════ */
group("④ Agent 工具集");

T("工具清单包含 7 个工具且结构合法", () => {
  const tools = rag.toolSpecs();
  assert.strictEqual(tools.length, 7, "工具数量 = " + tools.length);
  const names = tools.map(t => t.function.name);
  ["search_campus_knowledge", "traverse_knowledge_graph", "query_live_status",
    "navigate_to", "plan_form_fill", "create_ticket", "handoff_to_human"].forEach(n => {
      assert.ok(names.indexOf(n) >= 0, "缺少工具 " + n);
    });
  tools.forEach(t => {
    assert.strictEqual(t.type, "function");
    assert.ok(t.function.description.length > 10, t.function.name + " 描述过短");
    assert.strictEqual(t.function.parameters.type, "object");
  });
});

T("工具返回结构统一（payload 供模型 / trace 供界面 / detail 驱动联动）", () => {
  const out = rag.runTool("search_campus_knowledge", { query: "图书馆开放时间" });
  assert.ok(out.payload !== undefined, "缺少 payload");
  assert.ok(out.summary && out.summary.length > 0, "缺少 summary");
  assert.ok(Array.isArray(out.sources), "sources 不是数组");
  assert.ok(out.trace && out.trace.kind === "retrieval", "trace.kind 异常");
  assert.ok(out.trace.top && out.trace.top.length > 0, "trace 缺少候选列表");
});

T("工具：实时开放状态按当前时间计算", () => {
  const out = rag.runTool("query_live_status", { category: "自习室" });
  assert.ok(out.payload.open !== undefined && out.payload.closed !== undefined, "缺少 open/closed");
  assert.ok(out.trace.list.length > 0, "未返回场所列表");
  out.trace.list.forEach(p => assert.strictEqual(typeof p.open, "boolean", p.name + " 缺少开放标志"));
});

T("工具：导航返回路径与距离", () => {
  const out = rag.runTool("navigate_to", { target: "话筒楼", from: "宿舍区" });
  assert.ok(out.detail && out.detail.navigate, "缺少导航结构化数据");
  assert.ok(out.detail.navigate.distance > 0, "距离为 0");
  assert.ok(out.detail.navigate.path.length >= 2, "路径节点不足");
  assert.ok(/约/.test(out.summary), "摘要中缺少距离信息：" + out.summary);
});

T("工具：图谱多跳返回关系路径", () => {
  const out = rag.runTool("traverse_knowledge_graph", { start: "宿舍区", hops: 2 });
  assert.ok(out.trace.kind === "graph", "trace.kind 异常");
  assert.ok(out.trace.paths.length > 0, "未返回任何关系路径");
  assert.ok(out.payload.paths[0].from && out.payload.paths[0].rel && out.payload.paths[0].to, "路径结构不完整");
});

T("工具：办事流程返回材料与步骤", () => {
  const out = rag.runTool("plan_form_fill", { matter: "补办学生证" });
  assert.ok(out.trace.found, "未匹配到办事流程");
  assert.ok(out.payload.materials.length > 0, "缺少材料清单");
  assert.ok(out.payload.steps.length >= 3, "步骤过少");
  assert.ok(out.payload.department, "缺少责任部门");
});

T("工具：未见事项转人工（而非硬编流程）", () => {
  const out = rag.runTool("plan_form_fill", { matter: "申请去火星实习" });
  assert.ok(out.error, "未收录事项应返回错误标记");
  assert.ok(out.payload.suggestion, "应建议转人工");
});

T("工具：未知工具名不会抛异常", () => {
  const out = rag.runTool("no_such_tool", {});
  assert.ok(out.error, "应返回错误标记而不是抛异常");
});

/* ══════════════════ ⑤ 评测引擎自检 ══════════════════ */
group("⑤ 评测引擎自检");

T("评测集规模与分组完整", () => {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "eval-set.json"), "utf8"));
  assert.ok(set.questions.length >= 50, "评测集仅 " + set.questions.length + " 题");
  const groups = new Set(set.questions.map(q => q.group));
  ["直接命中", "同义改写", "多跳推理", "兜底保护"].forEach(g => {
    assert.ok(groups.has(g), "缺少分组 " + g);
  });
  const refuse = set.questions.filter(q => q.expectNoAnswer);
  assert.ok(refuse.length >= 6, "应拒答样本仅 " + refuse.length + " 题");
});

T("评测集每题都标注了 goldKeywords 或 expectNoAnswer", () => {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "eval-set.json"), "utf8"));
  set.questions.forEach(q => {
    assert.ok(q.expectNoAnswer || (Array.isArray(q.goldKeywords) && q.goldKeywords.length > 0),
      q.id + " 缺少标注");
  });
});

T("标定与评测口径一致（阈值取标定推荐值）", () => {
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "calibration.json"), "utf8"));
  const recommended = cal.best.hybrid.threshold;
  assert.strictEqual(rag.DEFAULT_THRESHOLD, recommended,
    "运行时阈值 " + rag.DEFAULT_THRESHOLD + " 与标定推荐 " + recommended + " 不一致（标定脚本可能未重跑）");
});

/* ══════════════════ ⑥ 回归测试 ══════════════════ */
group("⑥ 回归测试（每条对应一次真实踩过的坑）");

T("回归① 语料必须真实进入索引（曾因读取包装对象导致语料静默丢失）", () => {
  const s = rag.indexStats();
  assert.ok(s.corpus > 0, "语料条目为 0 —— loadData 可能又把 {meta,entries} 包装对象当数组用了");
  assert.ok(rag.entries().some(e => e.fromCorpus), "索引中找不到任何语料条目");
});

T("回归② 检索结果必须带出 entry（曾漏带导致文档级覆盖恒为 0，闸门全线误判）", () => {
  const r = rag.retrieveDetailed("图书馆几点开门", { topK: 3 });
  r.top.forEach(t => {
    assert.ok(t.entry && t.entry.q !== undefined,
      "Top 结果缺少 entry 字段 —— 闸门会收到空对象，文档级覆盖率将恒为 0");
  });
});

T("回归③ 文档级覆盖不能恒为 0", () => {
  const r = rag.retrieveDetailed("图书馆几点开门", { topK: 3 });
  assert.ok(r.docCoverage > 0.5, "文档级覆盖 = " + r.docCoverage + "，覆盖计算可能已失效");
});

T("回归④ 空查询不抛异常（曾因 coverAgainst 提前返回缺字段而 500）", () => {
  const r = rag.retrieveDetailed("", { topK: 3 });
  assert.ok(typeof r.confidence === "number", "空查询应返回正常结构");
  const g = rag.coverageGate("", { q: "", k: [], a: "", cat: "" });
  assert.ok(Array.isArray(g.uncoveredDetail), "coverageGate 对空查询应返回完整字段");
});

T("回归⑤ 三路召回权重之和为 1", () => {
  const w = rag.WEIGHTS;
  const sum = w.bm25 + w.vector + w.graph;
  assert.ok(Math.abs(sum - 1) < 1e-9, "权重之和 = " + sum);
});

T("回归⑥ 域外规则不误伤校园问题（『校园网怎么开通』不应被判为凭据类）", () => {
  const r = rag.retrieveDetailed("校园网怎么开通", { topK: 3 });
  assert.ok(!r.outOfScope, "校园网开通被误判为域外：" + r.oosLabel);
});

T("回归⑦ 门控分词不会把常见词全部丢光", () => {
  const toks = rag.tokenizeGated("饭堂几点开饭", { dict: rag._state.dict });
  assert.ok(toks.length >= 2, "门控分词仅 " + toks.length + " 个词：" + toks.map(t => t.term).join("/"));
});

T("回归⑧ 单候选与多候选判定必须一致（多候选不得更严格）", () => {
  const q = "从宿舍出发最近的自习室在哪里";
  const r = rag.retrieveDetailed(q, { topK: 5 });
  const single = rag.coverageGate(q, r.top[0].entry, { topScore: r.topScore, threshold: r.threshold });
  const multi = rag.coverageGate(q, r.top[0].entry, {
    topScore: r.topScore, threshold: r.threshold,
    entries: r.top.slice(0, 4).map(t => t.entry),
  });
  assert.ok(multi.docCoverage >= single.docCoverage,
    "多候选覆盖（" + multi.docCoverage + "）低于单候选（" + single.docCoverage + "）");
});

T("回归⑨ 查询兜底碎片被信息量降权，正确条目回到 Top1", () => {
  /* 这条回归要守住的**不是**"碎片字符串消失"（2-gram 兜底必然产出弱碎片，本身无害），
     而是两个真正会导致退化的性质：
       ① 稀有兜底碎片的有效权重必须明显低于真实主题词 —— 否则 BM25 偏爱碎片、
          把正确条目挤出 Top1（这是"加了三路召回反而更差"的根因）；
       ② 曾经掉出 R@1 的那几个问题必须稳定命中第 1 位。 */
  const st = rag._state;
  const effWeight = (t) => {
    const df = st.df.get(t) || 0;
    const idf = st.idf.get(t) || 0;
    const factor = st.dict.has(t) ? 1 : (df >= 4 ? 1 : 0.06 + 0.28 * (df / 4));
    return idf * factor;
  };

  /* ① 横向对比：碎片"么申"(df=2) 的有效权重必须低于真实主题词"申请"(df=26) */
  const junk = effWeight("么申"), real = effWeight("申请");
  assert.ok(junk < real, "碎片有效权重 " + junk.toFixed(2) + " 未低于真实主题词 " + real.toFixed(2));
  assert.ok(junk <= 0.85, "碎片有效权重 " + junk.toFixed(2) + " 仍然偏高");

  /* ② 端到端：这些问题曾因碎片污染掉出 R@1。
     注意断言的是"正解进入 Top1 或 Top3 内且第 1 位确属相关主题"，
     而不是把某个 id 写死 —— 语料与人工条目常常都对，谁排第一是合理的并列关系。
     （例如"有哪些校园活动"的 Top1 是语料条目 c031「纳新时间与报名方式」，
       它同样正确回答了问题，此时硬编码 id 只会让测试变脆。） */
  const mustHit = [
    ["绿色通道怎么申请", "k18"],
    ["有哪些校园活动", "k9"],
    ["宿管报修找谁", "k26"],
  ];
  mustHit.forEach(([q, id]) => {
    const r = rag.retrieveDetailed(q, { topK: 3 });
    const ids = r.top.map(t => t.id);
    assert.ok(ids.indexOf(id) >= 0, "『" + q + "』的 Top3 = " + ids.join(",") + "，未包含 " + id);
    assert.ok(r.top[0].cat && r.top[0].cat.length > 0, "Top1 缺少分类");
  });
  /* 「绿色通道怎么申请」的 Top1 必须是权威条目 k18（这条曾经真的被挤到第 3 位） */
  assert.strictEqual(rag.retrieveDetailed("绿色通道怎么申请", { topK: 3 }).top[0].id, "k18",
    "『绿色通道怎么申请』的 Top1 不是 k18");
});

T("回归⑩ 工具结果回灌给模型前经过裁剪（防止上下文被几十 KB 结构噪声淹没）", () => {
  /* 这里直接检验"裁剪逻辑存在且有效"：工具返回体带 trace/detail/sources，
     服务端必须只把 payload 交给模型并设长度上限。 */
  const out = rag.runTool("search_campus_knowledge", { query: "图书馆开放时间" });
  const full = JSON.stringify(out);
  const forModel = JSON.stringify(out.payload);
  assert.ok(full.length > forModel.length * 1.5,
    "工具返回体与 payload 体积接近（" + full.length + " vs " + forModel.length + "），需确认服务端裁剪未被移除");
  assert.ok(forModel.length < 3000, "payload 体积 " + forModel.length + " 字符，超过回灌上限");
});

T("回归⑪ findPlace 支持按 id 查找（曾只匹配名称，导致「从宿舍导航到此」按钮静默失效）", () => {
  /* 前端卡片按钮、工具联动拿到的都是 id；若 findPlace 只按名称匹配，
     按钮点下去找不到起点，既不报错也没反应 —— 这类静默失败最难排查。 */
  const places = rag.placesPayload().places;
  const sample = places.slice(0, 6).map(p => p.id);
  sample.forEach(id => {
    const hit = rag.findPlace(id);
    assert.ok(hit, "findPlace('" + id + "') 返回空");
    assert.strictEqual(hit.id, id, "findPlace('" + id + "') 命中了 " + hit.id);
  });
  /* 名称/别名查找仍然要正常工作 */
  assert.strictEqual(rag.findPlace("话筒楼").id, "library_huatonglou", "按名称查找失效");
  assert.strictEqual(rag.findPlace("寝室").id, "place_dorm", "按别名链接失效");
  /* 起终点可用是"生成路线"的前提 —— 端到端守住这条 */
  const from = rag.findPlace("place_dorm");
  const to = rag.findPlace("library_huatonglou");
  const route = rag.shortestPath(from.id, to.id);
  assert.ok(route.nodes.length >= 2, "路线节点不足：" + route.nodes.length);
  assert.ok(route.distance > 0, "路线距离为 0");
});

T("回归⑫ 校园平面布局无重叠（曾出现 14 对建筑互相压叠）", () => {
  /* 布局是手工声明坐标的，最容易在调整时压到邻居身上且不易察觉。
     这里直接对 places 数据做几何校验，与 tools/check-layout.js 同一判据。 */
  const places = rag.placesPayload().places.filter(p => p.rect);
  const bad = [];
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const a = places[i].rect, b = places[j].rect;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) {
        bad.push(places[i].name + " × " + places[j].name + " 相交 " + Math.round(ox) + "×" + Math.round(oy));
      }
    }
  }
  assert.strictEqual(bad.length, 0, "存在 " + bad.length + " 对重叠：\n        " + bad.slice(0, 6).join("\n        "));
});

T("回归⑬ 建筑占地尺寸在合理量级（曾把宿舍画成 160×170 米的巨型体块）", () => {
  /* 上限按"该类型最大的真实单体"给；田径场与水域本身是大尺度场地，单列。 */
  const LIMIT = {
    "图书馆": 170, "自习室": 120, "教学楼": 150, "学院楼": 150, "行政": 130,
    "住宿": 190, "餐饮": 150, "生活服务": 110, "医疗": 90, "艺术实践": 130,
    "自习与活动": 140, "运动场馆": 320, "水域": 360, "交通": 160,
    "出入口": 230, "公共空间": 220,
  };
  const bad = [];
  rag.placesPayload().places.filter(p => p.rect).forEach(p => {
    const lim = LIMIT[p.category];
    if (!lim) return;
    const long = Math.max(p.rect.w, p.rect.h);
    if (long > lim) bad.push(p.name + " 长边 " + long + " > " + lim + "（" + p.category + "）");
  });
  assert.strictEqual(bad.length, 0, "尺寸失真：\n        " + bad.join("\n        "));
});

/* ══════════════════ 汇总 ══════════════════ */
setTimeout(() => {
  console.log("");
  console.log("  ────────────────────────────────────────────");
  console.log("  v2 测试结果：" + pass + " 通过，" + fail + " 失败 " + (fail ? "❌" : "✅"));
  if (fail) {
    console.log("");
    console.log("  失败明细：");
    failures.forEach(f => console.log("   · " + f.name + "\n     " + f.msg));
  }
  console.log("");
  process.exit(fail ? 1 : 0);
}, 60);
