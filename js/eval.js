/* ============================================================
 * v2 前端 · 检索策略消融评测面板
 *
 * 这一屏是整个作品"最抗追问"的部分。评委常见的质疑是：
 *   "你这个 RAG 和普通关键词匹配有什么本质区别？"
 * 如果只回答"我们用了向量检索"，说服力很弱。
 * 这里的回答是：**同一份代码、同一个评测集、四种策略开关对比的量化结果**，
 * 并且明确给出"闸门带来的可用性代价"，不藏指标。
 *
 * 四组对照（消融实验设计）：
 *   ① v1 原始实现        关键词子串匹配，无闸门 —— 改造前的真实行为
 *   ② v1 检索 + 闸门     检索算法不变，只加闸门 —— 隔离"闸门"的贡献
 *   ③ v2 检索，不开闸门  只换检索算法 —— 隔离"检索"的贡献
 *   ④ v2 完整方案        三路融合 + 三重闸门 —— 最终形态
 *
 * 指标口径（在 src/eval.js 中按混淆矩阵严格定义）：
 *   R@1/R@3/R@5 · MRR · 兜底准确率 · 误答率 · 回答率 · 单次检索耗时
 * ============================================================ */

import { $, el, esc, api, toast, fmtMs } from "./util.js";

export class EvalPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.body = $("evalBody");
    this.meta = $("evalMeta");
    this.running = false;
    this.charts = [];

    const run = $("evalRun");
    if (run) run.onclick = () => this.run("full");
    const quick = $("evalQuick");
    if (quick) quick.onclick = () => this.run("quick");
  }

  async run(set) {
    if (this.running || !this.body) return;
    this.running = true;
    const btnF = $("evalRun"), btnQ = $("evalQuick");
    if (btnF) btnF.disabled = true;
    if (btnQ) btnQ.disabled = true;
    this._loading(set);

    try {
      const r = await api("/api/eval?set=" + encodeURIComponent(set));
      this._render(r);
      toast("评测完成：" + r.strategies[0].total + " 题 · " + r.elapsedMs + " ms", "ok");
    } catch (e) {
      this.body.innerHTML = '<div class="side-empty">评测失败：' + esc(e.message) +
        '<br><br>评测需要后端支持（<code>node server/server.js</code>）。' +
        '如果你正在直接打开 index.html，前端离线模式无法运行全量评测。</div>';
    } finally {
      this.running = false;
      if (btnF) btnF.disabled = false;
      if (btnQ) btnQ.disabled = false;
    }
  }

  _loading(set) {
    const label = set === "quick" ? "快速子集" : "全量评测集";
    this.body.innerHTML =
      '<div style="padding:26px 4px;text-align:center">' +
      '<div style="font-size:14px;color:var(--cyan);margin-bottom:10px">正在运行' + label + '消融评测…</div>' +
      '<div class="emptyNote">对同一批人工标注问题，分别用四种检索策略各跑一遍，<br>' +
      '统计 Recall / MRR / 兜底准确率 / 误答率 / 耗时，并解析每题的命中排名。</div>' +
      '</div>';
  }

  _render(r) {
    this.charts.forEach(c => { try { c.dispose(); } catch (e) { /* 忽略 */ } });
    this.charts = [];
    const S = r.strategies;
    const base = S[0], best = S[S.length - 1];
    const imp = r.improvement || {};

    if (this.meta) {
      this.meta.innerHTML = '评测集 <code>data/eval-set.json</code> · ' + S[0].total +
        ' 题（可答 ' + S[0].answerable + ' / 未收录 ' + S[0].refusals + '） · 知识条目 ' +
        (r.indexStats ? r.indexStats.entries : "—") + ' 条 · 耗时 ' + r.elapsedMs + ' ms';
    }

    let html = "";

    /* ── 主结果表 ── */
    html += '<table class="evalTable"><thead><tr>' +
      '<th>检索策略</th><th>Recall@1</th><th>Recall@3</th><th>MRR</th>' +
      '<th>兜底准确率</th><th>误答率</th><th>可答率</th><th>单次检索</th></tr></thead><tbody>';
    S.forEach((s, i) => {
      const isBest = i === S.length - 1;
      html += '<tr class="' + (isBest ? "best" : "") + '">' +
        '<td>' + esc(s.name) + '<span class="note">' + esc(s.note) + '</span></td>' +
        '<td>' + s.recall1 + '%</td>' +
        '<td class="' + (s.recall3 >= 90 ? "good" : "") + '">' + s.recall3 + '%</td>' +
        '<td>' + s.mrr.toFixed(3) + '</td>' +
        '<td class="' + (s.fallbackAcc >= 99 ? "good" : s.fallbackAcc < 70 ? "bad" : "") + '">' + s.fallbackAcc + '%</td>' +
        '<td class="' + (s.wrongRate <= 1 ? "good" : "bad") + '">' + s.wrongRate + '%</td>' +
        '<td>' + s.answerRate + '%</td>' +
        '<td>' + s.avgMs + ' ms</td>' +
        '</tr>';
    });
    html += '</tbody></table>';

    /* ── 提升摘要 ── */
    html += '<div class="conclusion"><span class="t">📊 消融结论</span>';
    r.conclusion.forEach(c => { html += '· ' + esc(c) + '<br>'; });
    html += '<div style="margin-top:9px;color:var(--text-mute);font-size:12px">' +
      '评测方法：' + esc(r.meta && r.meta.purpose ? "人工标注评测集，标准答案按主题词动态解析（知识库扩充后评测集无需重写）" : "") +
      '</div></div>';

    /* ── 分组细项 ── */
    html += '<div class="evalStats">';
    html += '<div class="tile"><h3>🔬 分组命中情况（最终方案）</h3><div class="sub">定位到底哪一类问题拖了后腿</div><div id="evalGroupChart" class="chart evalChart"></div></div>';
    html += '<div class="tile"><h3>📉 策略逐项对比</h3><div class="sub">同一评测集下的指标横向对比</div><div id="evalBarChart" class="chart evalChart"></div></div>';
    html += '</div>';

    /* ── 逐题明细（可展开） ── */
    html += '<div class="tile" style="margin-top:14px"><h3>📋 逐题明细（最终方案）</h3>' +
      '<div class="sub">能看到每一道题命中了哪条知识、排在第几位 —— 评测过程完全可复核</div>' +
      '<div style="max-height:340px;overflow-y:auto;margin-top:6px">' +
      '<table class="evalTable"><thead><tr><th>问题</th><th>分组</th><th>判定</th><th>命中条目</th><th>排名</th></tr></thead><tbody>';
    best.detail.forEach(d => {
      const ok = d.correct;
      const verdict = d.expectNoAnswer
        ? (d.answered ? '<span class="bad">硬答（应为拒答）</span>' : '<span class="good">正确拒答</span>')
        : (d.rank != null && d.answered ? '<span class="good">命中</span>'
          : d.rank != null ? '<span style="color:var(--amber)">命中但被闸门拦下</span>'
            : '<span class="bad">未命中</span>');
      html += '<tr><td>' + esc(d.q) + '</td><td>' + esc(d.group || "-") + '</td><td>' + verdict + '</td>' +
        '<td style="font-family:var(--mono);font-size:11px">' + esc((d.ids || []).slice(0, 2).join(", ") || "—") + '</td>' +
        '<td>' + (d.rank == null ? "—" : "#" + d.rank) + '</td></tr>';
    });
    html += '</tbody></table></div></div>';

    this.body.innerHTML = html;

    /* 图表延后初始化，等容器完成布局 */
    setTimeout(() => {
      this._groupChart(r);
      this._barChart(r);
    }, 50);
  }

  _groupChart(r) {
    const dom = $("evalGroupChart");
    if (!dom || !window.echarts) return;
    const g = r.strategies[r.strategies.length - 1].groups || {};
    const names = Object.keys(g);
    if (!names.length) { dom.innerHTML = '<div class="emptyNote">无分组数据</div>'; return; }
    const ec = window.echarts.init(dom);
    ec.setOption({
      grid: { left: 40, right: 16, top: 26, bottom: 30 },
      tooltip: { trigger: "axis", backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 } },
      legend: { textStyle: { color: "#8ba0bd", fontSize: 11 }, top: 0 },
      xAxis: { type: "category", data: names, axisLine: { lineStyle: { color: "rgba(120,165,220,.25)" } }, axisLabel: { color: "#5e7291", fontSize: 11 } },
      yAxis: { type: "value", max: 100, splitLine: { lineStyle: { color: "rgba(120,165,220,.1)" } }, axisLabel: { color: "#5e7291", fontSize: 10, formatter: "{value}%" } },
      series: [
        { name: "命中率", type: "bar", data: names.map(n => g[n].acc), barWidth: "32%", itemStyle: { borderRadius: [4, 4, 0, 0], color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "#38bdf8" }, { offset: 1, color: "rgba(56,189,248,.3)" }] } } },
        { name: "拒答率", type: "bar", data: names.map(n => g[n].refused), barWidth: "32%", itemStyle: { borderRadius: [4, 4, 0, 0], color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "#fbbf24" }, { offset: 1, color: "rgba(251,191,36,.25)" }] } } },
      ],
    });
    this.charts.push(ec);
  }

  _barChart(r) {
    const dom = $("evalBarChart");
    if (!dom || !window.echarts) return;
    const S = r.strategies;
    const ec = window.echarts.init(dom);
    ec.setOption({
      grid: { left: 78, right: 26, top: 26, bottom: 26 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: "rgba(12,22,38,.95)", borderColor: "rgba(120,165,220,.3)", textStyle: { color: "#dbe7f5", fontSize: 12 } },
      legend: { textStyle: { color: "#8ba0bd", fontSize: 11 }, top: 0 },
      xAxis: { type: "value", max: 100, splitLine: { lineStyle: { color: "rgba(120,165,220,.1)" } }, axisLabel: { color: "#5e7291", fontSize: 10, formatter: "{value}%" } },
      yAxis: {
        type: "category", axisLine: { lineStyle: { color: "rgba(120,165,220,.25)" } },
        axisLabel: { color: "#5e7291", fontSize: 10, width: 70, overflow: "truncate", formatter: v => v.replace(/^[①②③④]\s*/, "").slice(0, 8) },
        data: S.map(s => s.name),
      },
      series: [
        { name: "Recall@3", type: "bar", data: S.map(s => s.recall3), barWidth: "26%", itemStyle: { borderRadius: [0, 3, 3, 0], color: "#38bdf8" } },
        { name: "兜底准确率", type: "bar", data: S.map(s => s.fallbackAcc), barWidth: "26%", itemStyle: { borderRadius: [0, 3, 3, 0], color: "#34d399" } },
        { name: "误答率", type: "bar", data: S.map(s => s.wrongRate), barWidth: "26%", itemStyle: { borderRadius: [0, 3, 3, 0], color: "#fb7185" } },
      ],
    });
    this.charts.push(ec);
  }

  show() {
    setTimeout(() => this.charts.forEach(c => { try { c.resize(); } catch (e) { /* 忽略 */ } }), 120);
  }
}
