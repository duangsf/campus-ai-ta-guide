/* ============================================================
 * v2 前端 · 运营数据看板
 *
 * 与 v1 的关键区别：这里的数据**全部来自服务端 sqlite**，不是浏览器 localStorage。
 *   v1 的看板换台电脑、清一次缓存就归零，答辩现场经常出现"会话数 0、提问数 0"的尴尬；
 *   v2 把每次问答落库到 data/v2.db，看板反映的是真实使用痕迹。
 *
 * 看板包含 8 个视角：
 *   ① 核心 KPI（提问量/会话数/命中率/兜底率/首字延迟/满意度）
 *   ② 高频问题 Top10
 *   ③ 意图分布环形图
 *   ④ 24 小时时段热力
 *   ⑤ 知识盲区排行榜（未收录问题，可直接指导知识库补全 → 形成运营闭环）
 *   ⑥ 检索命中分数分布
 *   ⑦ 端到端延迟分布
 *   ⑧ 数据落库状态与存储模式（sqlite / 内存降级）
 * ============================================================ */

import { $, el, esc, api, countUp, toast, fmtMs } from "./util.js";

export class Dashboard {
  constructor(ctx) {
    this.ctx = ctx;
    this.grid = $("dashGrid");
    this.meta = $("dashMeta");
    this.charts = [];
    this.built = false;
    this.loading = false;

    const r = $("dashRefresh");
    if (r) r.onclick = () => this.load(true);
    const reset = $("dashReset");
    if (reset) reset.onclick = () => this._reset();
  }

  async _reset() {
    if (!window.confirm("确定清空服务端问答日志？此操作不可撤销，仅建议在正式演示前重置演示数据。")) return;
    try {
      await api("/api/reset", { method: "POST", body: "{}" });
      toast("数据已清空", "ok");
      this.load(true);
    } catch (e) {
      toast("清空失败：" + e.message, "err");
    }
  }

  async load(force) {
    if (!this.grid || this.loading) return;
    if (this.built && !force) return;
    this.loading = true;
    try {
      const d = await api("/api/analytics");
      this._render(d);
      this.built = true;
    } catch (e) {
      this.grid.innerHTML = '<div class="tile" style="grid-column:1/-1"><div class="emptyNote">' +
        '未能读取运营数据：' + esc(e.message) + '<br>' +
        '看板需要后端支持，请通过 <code>node server/server.js</code> 启动后访问本页（直接双击打开 index.html 时为纯前端离线模式）。</div></div>';
    } finally {
      this.loading = false;
    }
  }

  _render(d) {
    this.charts.forEach(c => { try { c.dispose(); } catch (e) { /* 忽略 */ } });
    this.charts = [];
    this.grid.innerHTML = "";
    const t = d.totals || {};

    if (this.meta) {
      this.meta.textContent = "存储：" + (d.storage === "sqlite" ? "node:sqlite（持久化）" : "内存（降级，重启即失）") +
        " · 数据来自真实问答日志";
    }

    /* ① KPI */
    const kpi = el("div", "tile wide");
    kpi.innerHTML = '<h3>📌 核心指标</h3><div class="sub">全部来自服务端问答日志，非前端模拟数据</div>' +
      '<div class="kpiRow">' +
      this._kpi("stQuestions", t.questions, "累计提问") +
      this._kpi("stSessions", t.sessions, "会话数") +
      this._kpi("stHitRate", t.hitRate, "知识库命中率", "%", t.hitRate >= 70 ? "green" : "amber") +
      this._kpi("stFallback", t.questions ? (100 - t.hitRate).toFixed(1) : 0, "兜底拒答率", "%") +
      this._kpi("stFirst", t.avgAnswer, "答案首字延迟", "ms", "green") +
      this._kpi("stFirst2", t.avgFirst, "首次响应延迟", "ms") +
      this._kpi("stTotal", t.avgTotal, "平均总耗时", "ms") +
      this._kpi("stCare", t.care, "情绪安抚次数") +
      this._kpi("stSat", t.satisfy == null ? "—" : t.satisfy, "用户满意度", t.satisfy == null ? "" : "%", "green") +
      '</div>';
    this.grid.appendChild(kpi);

    /* ② 高频问题 */
    const topTile = el("div", "tile");
    topTile.innerHTML = '<h3>🔥 高频问题 Top10</h3><div class="sub">反映学生最关心什么，可据此调整知识库优先级</div>';
    const topBox = el("div");
    if (!d.top || !d.top.length) {
      topBox.innerHTML = '<div class="emptyNote">暂无数据。去对话页问几个问题，这里就会有内容了。</div>';
    } else {
      const max = d.top[0].n || 1;
      d.top.forEach((row, i) => {
        const line = el("div", "listRow");
        line.innerHTML = '<span class="idx">' + (i + 1) + '</span>' +
          '<span class="txt" title="' + esc(row.q) + '">' + esc(row.q) + '</span>' +
          '<span class="bar" style="width:' + Math.max(6, Math.round(row.n / max * 70)) + 'px"></span>' +
          '<span class="n">' + row.n + '</span>';
        topBox.appendChild(line);
      });
    }
    topTile.appendChild(topBox);
    this.grid.appendChild(topTile);

    /* ③ 意图分布 */
    this.grid.appendChild(this._chartTile("🧭 意图分布", "检索前置的意图分类结果，用于判断服务覆盖面", "intentChart", (dom) => {
      const data = (d.intent || []).filter(x => x.value > 0);
      if (!data.length) { dom.innerHTML = '<div class="emptyNote">暂无意图数据</div>'; return null; }
      const ec = this._echarts(dom);
      ec.setOption({
        tooltip: { trigger: "item", backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 } },
        series: [{
          type: "pie", radius: ["46%", "72%"], center: ["50%", "52%"],
          itemStyle: { borderColor: "#0b1426", borderWidth: 2 },
          label: { color: "#8ba0bd", fontSize: 11, formatter: "{b}\n{c}" },
          labelLine: { lineStyle: { color: "rgba(120,165,220,.3)" } },
          data: data.map((x, i) => ({
            name: x.name, value: x.value,
            itemStyle: { color: ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#60a5fa", "#22d3ee", "#fb923c", "#818cf8", "#f472b6"][i % 10] },
          })),
        }],
      });
      return ec;
    }));

    /* ④ 时段热力 */
    this.grid.appendChild(this._chartTile("🕐 24 小时访问分布", "识别咨询高峰时段，用于安排人工值守与终端部署", "hourChart", (dom) => {
      const hours = new Array(24).fill(0);
      (d.hours || []).forEach(h => { if (h.h >= 0 && h.h < 24) hours[h.h] = h.n; });
      if (!hours.some(v => v > 0)) { dom.innerHTML = '<div class="emptyNote">暂无时段数据</div>'; return null; }
      const ec = this._echarts(dom);
      ec.setOption({
        grid: { left: 34, right: 14, top: 18, bottom: 26 },
        tooltip: { trigger: "axis", backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 }, formatter: p => p[0].axisValue + ":00 · " + p[0].value + " 次" },
        xAxis: { type: "category", data: hours.map((_, i) => i), axisLine: { lineStyle: { color: "rgba(120,165,220,.25)" } }, axisLabel: { color: "#5e7291", fontSize: 10, interval: 2 } },
        yAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(120,165,220,.1)" } }, axisLabel: { color: "#5e7291", fontSize: 10 } },
        series: [{
          type: "bar", data: hours, barWidth: "62%",
          itemStyle: {
            borderRadius: [3, 3, 0, 0],
            color: {
              type: "linear", x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: "#38bdf8" }, { offset: 1, color: "rgba(167,139,250,.35)" }],
            },
          },
        }],
      });
      return ec;
    }));

    /* ⑤ 知识盲区 */
    const gapTile = el("div", "tile wide");
    gapTile.innerHTML = '<h3>🧩 知识盲区排行榜</h3><div class="sub">闸门判定为"未收录"的问题按出现次数排序 —— 这就是知识库的补全清单，形成运营闭环</div>';
    const gapBox = el("div");
    if (!d.tickets || !d.tickets.length) {
      gapBox.innerHTML = '<div class="emptyNote">暂无未收录问题。可以试着问一个知识库里没有的问题（例如「食堂三楼川菜窗口的招牌菜是什么」），它会被记到这里。</div>';
    } else {
      d.tickets.forEach((row, i) => {
        const line = el("div", "listRow");
        line.innerHTML = '<span class="idx">' + (i + 1) + '</span>' +
          '<span class="txt" title="' + esc(row.q) + '">' + esc(row.q) + '</span>' +
          '<span class="chip" style="font-size:10.5px">' + esc(row.intent || "未分类") + '</span>' +
          '<span class="n">×' + row.n + '</span>';
        gapBox.appendChild(line);
      });
      const tip = el("div", "emptyNote");
      tip.style.marginTop = "8px";
      tip.textContent = "运营方补充这些条目后，同类问题即可直接命中 —— 系统具备「越用越准」的闭环能力。";
      gapBox.appendChild(tip);
    }
    gapTile.appendChild(gapBox);
    this.grid.appendChild(gapTile);

    /* ⑥ 检索分数分布 */
    this.grid.appendChild(this._chartTile("📈 检索命中分数分布", "三路融合后的 Top1 分数分布，用于判断阈值是否合理", "scoreChart", (dom) => {
      const data = d.scoreDist || [];
      if (!data.some(x => x.value > 0)) { dom.innerHTML = '<div class="emptyNote">暂无分数数据</div>'; return null; }
      const ec = this._echarts(dom);
      ec.setOption({
        grid: { left: 40, right: 16, top: 18, bottom: 26 },
        tooltip: { trigger: "axis", backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 } },
        xAxis: { type: "category", data: data.map(x => x.name), axisLine: { lineStyle: { color: "rgba(120,165,220,.25)" } }, axisLabel: { color: "#5e7291", fontSize: 10 } },
        yAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(120,165,220,.1)" } }, axisLabel: { color: "#5e7291", fontSize: 10 } },
        series: [{
          type: "bar", data: data.map(x => x.value), barWidth: "56%",
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: (p) => ["#fb7185", "#fb923c", "#fbbf24", "#38bdf8", "#34d399"][p.dataIndex] || "#38bdf8",
          },
        }],
      });
      return ec;
    }));

    /* ⑦ 延迟分布 */
    this.grid.appendChild(this._chartTile("⚡ 端到端延迟分布", "首字到完整回答的耗时分布，评估交互流畅度", "latChart", (dom) => {
      const data = d.latencyDist || [];
      if (!data.some(x => x.value > 0)) { dom.innerHTML = '<div class="emptyNote">暂无延迟数据（本地离线模式的逐字回放不计入真实模型延迟）</div>'; return null; }
      const ec = this._echarts(dom);
      ec.setOption({
        grid: { left: 52, right: 16, top: 18, bottom: 26 },
        tooltip: { trigger: "axis", backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 } },
        xAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(120,165,220,.1)" } }, axisLabel: { color: "#5e7291", fontSize: 10 } },
        yAxis: { type: "category", data: data.map(x => x.name), axisLine: { lineStyle: { color: "rgba(120,165,220,.25)" } }, axisLabel: { color: "#5e7291", fontSize: 10 } },
        series: [{
          type: "bar", data: data.map(x => x.value), barWidth: "52%",
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "rgba(52,211,153,.5)" }, { offset: 1, color: "#34d399" }] },
          },
        }],
      });
      return ec;
    }));

    /* ⑧ 系统状态 */
    const sysTile = el("div", "tile");
    sysTile.innerHTML = '<h3>🛡️ 系统与数据状态</h3><div class="sub">能现场自证运行状态，是"可落地"而非"PPT 作品"的证据</div>';
    const idx = (window.RAG && window.RAG.indexStats) ? window.RAG.indexStats() : {};
    const rows = [
      ["数据存储", d.storage === "sqlite" ? "node:sqlite（持久化到 data/v2.db）" : "内存（Node 版本不支持 node:sqlite）"],
      ["知识条目", (idx.entries || 0) + " 条（基础 " + (idx.base || 0) + " + 语料 " + (idx.corpus || 0) + " + 后台 " + (idx.extra || 0) + "）"],
      ["索引词项", (idx.terms || 0) + " 个"],
      ["图谱规模", (idx.entities || 0) + " 实体 / " + (idx.relations || 0) + " 关系"],
      ["场所与流程", (idx.places || 0) + " 个场所 · " + (idx.forms || 0) + " 项办事流程 · " + (idx.depts || 0) + " 个部门"],
      ["降级次数", (t.degraded || 0) + " 次（本地知识库兜底）"],
      ["延迟口径", "答案首字 " + (t.avgAnswer || 0) + "ms（用户感知） · 首次响应 " + (t.avgFirst || 0) + "ms（含工具调用决策）"],
      ["平均总耗时", (t.avgTotal || 0) + " ms（检索 + 工具调用 + 生成）"],
      ["反馈样本", (t.feedbacks || 0) + " 条"],
    ];
    const kvBox = el("div");
    rows.forEach(([k, v]) => {
      const line = el("div", "kv");
      line.style.cssText = "display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line);font-size:12.5px";
      line.innerHTML = '<span style="color:var(--text-mute)">' + esc(k) + '</span><span style="text-align:right">' + esc(v) + '</span>';
      kvBox.appendChild(line);
    });
    sysTile.appendChild(kvBox);
    this.grid.appendChild(sysTile);

    /* 数字滚动动画 */
    ["stQuestions", "stSessions", "stCare"].forEach(id => {
      const n = $(id);
      if (n && n.tagName === "DIV") countUp(n, parseFloat(n.dataset.target || n.textContent) || 0);
    });
  }

  _kpi(id, value, label, unit, color) {
    const v = value == null ? "—" : value;
    return '<div class="kpi"><div class="num ' + (color || "") + '" id="' + id + '" data-target="' +
      (typeof v === "number" ? v : 0) + '">' + esc(v) + '</div>' +
      '<div class="lbl">' + esc(label) + (unit ? "（" + unit + "）" : "") + '</div></div>';
  }

  _chartTile(title, sub, id, draw) {
    const tile = el("div", "tile");
    tile.innerHTML = '<h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + '</div>';
    const dom = el("div", "chart");
    dom.id = id;
    tile.appendChild(dom);
    this.grid.appendChild(tile);
    /* 等 DOM 进入布局后再初始化 ECharts，否则容器宽高为 0 导致图表不显示 */
    setTimeout(() => {
      const ec = draw(dom);
      if (ec) this.charts.push(ec);
    }, 40);
    return tile;
  }

  /** 懒加载 ECharts：只有打开看板时才下载，避免首屏被 1MB 库拖慢 */
  _echarts(dom) {
    if (!window.echarts) {
      dom.innerHTML = '<div class="emptyNote">图表库未加载（vendor/echarts.min.js 缺失）</div>';
      return null;
    }
    const ec = window.echarts.init(dom, null, { renderer: "canvas" });
    return ec;
  }

  show() {
    this.load(false);
    /* 视图切换后容器尺寸变了，需要让图表重新计算 */
    setTimeout(() => this.charts.forEach(c => { try { c.resize(); } catch (e) { /* 忽略 */ } }), 120);
  }
}
