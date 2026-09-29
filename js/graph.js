/* ============================================================
 * v2 前端 · 校园知识图谱可视化
 *
 * 为什么值得单独做一屏：
 *   1. 它是"多跳检索"的数据底座 —— 图谱召回路线就沿着这些边扩散，
 *      把图画出来，评委才能理解"多跳"到底跳了什么；
 *   2. 答辩时可以对着一张关系网络讲"实体链接 → 关系扩散 → 关联条目召回"，
 *      比讲一段文字直观得多。
 *
 * 布局：自研力导向（斥力 + 弹簧 + 向心），不引入 d3 等额外依赖，
 *       保证离线可用、包体最小。节点按类型着色，边按关系类型区分线型。
 * ============================================================ */

import { $, el, esc, clamp } from "./util.js";

const TYPE_COLOR = {
  "学校": "#38bdf8", "校区": "#22d3ee", "建筑": "#a78bfa", "场所": "#818cf8",
  "设施": "#60a5fa", "部门": "#fbbf24", "组织": "#fb923c", "系统": "#34d399", "业务": "#f472b6",
};
const REL_STYLE = {
  "包含": { color: "rgba(167,139,250,.42)", dash: [] },
  "位于": { color: "rgba(56,189,248,.34)", dash: [5, 5] },
  "负责": { color: "rgba(251,191,36,.38)", dash: [2, 4] },
  "邻近": { color: "rgba(52,211,153,.34)", dash: [8, 6] },
  "提供": { color: "rgba(96,165,250,.34)", dash: [] },
  "开放于": { color: "rgba(34,211,238,.32)", dash: [3, 4] },
  "联系": { color: "rgba(244,114,182,.34)", dash: [2, 3] },
  "隶属": { color: "rgba(251,146,60,.34)", dash: [6, 4] },
  "办理": { color: "rgba(148,163,184,.32)", dash: [1, 4] },
};

export class GraphView {
  constructor(ctx) {
    this.ctx = ctx;
    this.canvas = $("graphCanvas");
    this.host = $("graphHost");
    this.side = $("graphSide");
    this.meta = $("graphMeta");
    this.rag = window.RAG;

    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.hover = null;
    this.selected = null;
    this.drag = null;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.built = false;
    this.rafId = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const btn = $("graphReset");
    if (btn) btn.onclick = () => this.layout(true);
  }

  build() {
    if (this.built) return;
    const g = this.rag.graphPayload ? this.rag.graphPayload() : null;
    if (!g || !g.entities) {
      if (this.meta) this.meta.textContent = "图谱数据未加载";
      return;
    }
    const places = this.rag.placesPayload ? this.rag.placesPayload().places : [];
    const placeIds = new Set(places.map(p => p.id));

    /* 只展示与"场所有关"或度数较高的实体，避免全图 60+ 节点挤成一团；
       同时保证每个实体至少有一条边，孤立点不参与布局。 */
    const degree = new Map();
    (g.relations || []).forEach(r => {
      degree.set(r.from, (degree.get(r.from) || 0) + 1);
      degree.set(r.to, (degree.get(r.to) || 0) + 1);
    });

    const ids = new Set();
    (g.relations || []).forEach(r => {
      const keep = (id) => placeIds.has(id) || (degree.get(id) || 0) >= 3;
      if (keep(r.from) && keep(r.to)) { ids.add(r.from); ids.add(r.to); }
    });

    const W = this.host.clientWidth || 900;
    const H = this.host.clientHeight || 620;
    g.entities.filter(e => ids.has(e.id)).forEach((e, i) => {
      const a = (i / Math.max(1, ids.size)) * Math.PI * 2;
      const rad = Math.min(W, H) * 0.34;
      const node = {
        id: e.id, name: e.name, type: e.type,
        x: W / 2 + Math.cos(a) * rad + (Math.random() - .5) * 30,
        y: H / 2 + Math.sin(a) * rad + (Math.random() - .5) * 30,
        vx: 0, vy: 0,
        r: clamp(6 + (degree.get(e.id) || 1) * 1.5, 7, 20),
        deg: degree.get(e.id) || 0,
      };
      this.nodes.push(node);
      this.byId.set(node.id, node);
    });

    (g.relations || []).forEach(r => {
      const a = this.byId.get(r.from), b = this.byId.get(r.to);
      if (!a || !b) return;
      this.edges.push({ a, b, rel: r.rel, w: r.w == null ? .6 : r.w });
    });

    this.meta.textContent = this.nodes.length + " 个实体 · " + this.edges.length + " 条关系 · 按类型着色";
    this._bind();
    this.layout(false);
    this._loop();
    this.built = true;
    this._renderSide(null);
  }

  layout(reheat) {
    this.nodes.forEach(n => {
      const W = this.host.clientWidth || 900, H = this.host.clientHeight || 620;
      if (reheat) {
        const a = Math.random() * Math.PI * 2;
        const rad = Math.min(W, H) * (0.12 + Math.random() * 0.3);
        n.x = W / 2 + Math.cos(a) * rad;
        n.y = H / 2 + Math.sin(a) * rad;
      }
      n.vx = (Math.random() - .5) * 6;
      n.vy = (Math.random() - .5) * 6;
    });
    this.energy = 1;
  }

  /* ══════════════ 力导向模拟 ══════════════ */
  _simulate() {
    const W = this.host.clientWidth || 900, H = this.host.clientHeight || 620;
    const N = this.nodes.length;
    if (!N) return;
    /* 能量衰减：布局稳定后停止计算，避免持续占用 CPU（大屏常开场景很重要） */
    if (this.energy <= 0.02) return;
    this.energy *= 0.985;

    const k = this.energy;
    /* 斥力：所有节点两两排斥（N≈60，O(N²) 完全可接受） */
    for (let i = 0; i < N; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = this.nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (Math.random() - .5); dy = (Math.random() - .5); d2 = 1; }
        const d = Math.sqrt(d2);
        const f = (2600 * k) / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    /* 弹簧：有关系的节点互相吸引，权重越高越紧 */
    this.edges.forEach(e => {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = 96 + (1 - e.w) * 60;
      const f = ((d - rest) * 0.012 * (0.5 + e.w) * k);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.a.vx += fx; e.a.vy += fy;
      e.b.vx -= fx; e.b.vy -= fy;
    });
    /* 向心 + 阻尼 + 边界 */
    this.nodes.forEach(n => {
      n.vx += (W / 2 - n.x) * 0.0016 * k;
      n.vy += (H / 2 - n.y) * 0.0016 * k;
      n.vx *= 0.86; n.vy *= 0.86;
      n.x += n.vx * 0.5;
      n.y += n.vy * 0.5;
      n.x = clamp(n.x, 40, W - 40);
      n.y = clamp(n.y, 32, H - 32);
    });
  }

  /* ══════════════ 渲染 ══════════════ */
  _loop() {
    const step = () => {
      this.rafId = requestAnimationFrame(step);
      this._simulate();
      this._draw();
    };
    step();
  }

  _draw() {
    const c = this.canvas, ctx = this.gctx;
    if (!ctx) return;
    const W = this.host.clientWidth, H = this.host.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    /* 边 */
    this.edges.forEach(e => {
      const style = REL_STYLE[e.rel] || { color: "rgba(148,163,184,.3)", dash: [] };
      const active = this.selected && (e.a.id === this.selected || e.b.id === this.selected);
      ctx.strokeStyle = active ? "rgba(56,189,248,.85)" : style.color;
      ctx.lineWidth = active ? 2.2 : (0.7 + e.w * 1.3);
      ctx.setLineDash(style.dash);
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
      /* 只在选中节点的边上标注关系名，避免文字过密 */
      if (active && this.zoom > 0.75) {
        const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
        ctx.setLineDash([]);
        ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = "rgba(186,230,253,.9)";
        ctx.textAlign = "center";
        ctx.fillText(e.rel, mx, my - 3);
      }
    });
    ctx.setLineDash([]);

    /* 节点 */
    this.nodes.forEach(n => {
      const color = TYPE_COLOR[n.type] || "#94a3b8";
      const isSel = n.id === this.selected;
      const isHover = n.id === this.hover;
      /* 光晕 */
      if (isSel || isHover) {
        const g = ctx.createRadialGradient(n.x, n.y, n.r * .5, n.x, n.y, n.r * 3.4);
        g.addColorStop(0, color + "88");
        g.addColorStop(1, "transparent");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? "#ffffff" : color;
      ctx.fill();
      ctx.strokeStyle = "rgba(6,14,26,.9)";
      ctx.lineWidth = 1.6;
      ctx.stroke();

      /* 标签：缩得太小就只显示高亮与选中节点，防止糊成一团 */
      if (this.zoom > 0.6 || isSel || isHover) {
        ctx.font = (isSel ? "600 " : "") + Math.max(10, 11 / this.zoom) + "px " + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = isSel ? "#ffffff" : "rgba(199,220,243,.88)";
        ctx.textAlign = "center";
        ctx.fillText(n.name, n.x, n.y + n.r + 13 / this.zoom);
      }
    });
    ctx.restore();
  }

  /* ══════════════ 交互 ══════════════ */
  _bind() {
    const c = this.canvas;
    this.gctx = c.getContext("2d");
    const resize = () => {
      const W = this.host.clientWidth, H = this.host.clientHeight;
      c.width = Math.round(W * this.dpr);
      c.height = Math.round(H * this.dpr);
      c.style.width = W + "px";
      c.style.height = H + "px";
    };
    resize();
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(this.host);

    const pick = (clientX, clientY) => {
      const r = c.getBoundingClientRect();
      const x = (clientX - r.left - this.pan.x) / this.zoom;
      const y = (clientY - r.top - this.pan.y) / this.zoom;
      let best = null, bd = Infinity;
      this.nodes.forEach(n => {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 8 && d < bd) { bd = d; best = n; }
      });
      return best;
    };

    c.addEventListener("mousedown", (e) => {
      const n = pick(e.clientX, e.clientY);
      if (n) { this.drag = { node: n, x: e.clientX, y: e.clientY }; this.energy = Math.max(this.energy, 0.35); }
      else this.drag = { pan: true, x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y };
      c.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (this.drag && this.drag.node) {
        const r = c.getBoundingClientRect();
        this.drag.node.x = (e.clientX - r.left - this.pan.x) / this.zoom;
        this.drag.node.y = (e.clientY - r.top - this.pan.y) / this.zoom;
        this.energy = Math.max(this.energy, 0.5);
        return;
      }
      if (this.drag && this.drag.pan) {
        this.pan.x = this.drag.px + (e.clientX - this.drag.x);
        this.pan.y = this.drag.py + (e.clientY - this.drag.y);
        return;
      }
      const n = pick(e.clientX, e.clientY);
      const id = n ? n.id : null;
      if (id !== this.hover) {
        this.hover = id;
        c.style.cursor = n ? "pointer" : "grab";
      }
    });

    window.addEventListener("mouseup", () => {
      if (this.drag && this.drag.node) this.drag = null;
      else this.drag = null;
      c.style.cursor = "grab";
    });

    c.addEventListener("click", (e) => {
      const n = pick(e.clientX, e.clientY);
      if (!n) { this.selected = null; this._renderSide(null); return; }
      this.selected = n.id;
      this._renderSide(n);
    });

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 0.92 : 1.09), 0.35, 3);
    }, { passive: false });
  }

  /** 选中实体的详情：关联知识条目 + 一跳邻居 + 联系方式 */
  _renderSide(node) {
    if (!this.side) return;
    if (!node) {
      this.side.innerHTML =
        '<div class="side-empty">点击图中任意实体，查看它关联的知识条目与一跳关系。<br><br>' +
        '<b style="color:var(--text-dim)">节点颜色</b><br>' +
        Object.keys(TYPE_COLOR).map(t =>
          '<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 6px 0 0">' +
          '<i style="width:9px;height:9px;border-radius:50%;background:' + TYPE_COLOR[t] + ';display:inline-block"></i>' + t + '</span>'
        ).join("") +
        '<br><br><b style="color:var(--text-dim)">边虚线</b>表示关系类型（位于 / 负责 / 邻近 / 提供 …）。</div>';
      return;
    }
    const entities = (this.rag.graphPayload().entities || []);
    const ent = entities.find(e => e.id === node.id) || {};
    const neighbors = this.edges
      .filter(e => e.a.id === node.id || e.b.id === node.id)
      .map(e => ({ rel: e.rel, other: e.a.id === node.id ? e.b : e.a }));

    const entries = (this.rag.entries ? this.rag.entries() : [])
      .filter(e2 => (e2.entities || []).indexOf(node.id) >= 0).slice(0, 5);

    const depts = (this.rag.placesPayload ? this.rag.placesPayload().deptTable : []) || [];
    const dept = depts.find(d => d.id === node.id);
    const place = (this.rag.placesPayload ? this.rag.placesPayload().places : []).find(p => p.id === node.id);

    this.side.innerHTML =
      '<h4 style="font-size:13.5px;color:#eaf3ff">' + esc(node.name) +
      '<span class="badgeMini">' + esc(node.type) + '</span></h4>' +
      '<div class="kvMini" style="grid-template-columns:auto auto;gap:4px 8px">' +
      '<dt>实体 ID</dt><dd style="font-family:var(--mono)">' + esc(node.id) + '</dd>' +
      '<dt>连接度</dt><dd>' + node.deg + ' 条关系</dd>' +
      (place ? '<dt>当前状态</dt><dd>' + (this.rag.isOpenNow(place) ? "● 开放中" : "○ 已关闭") + '</dd>' : '') +
      (dept && dept.phone ? '<dt>联系电话</dt><dd>' + esc(dept.phone) + '</dd>' : '') +
      (dept && dept.hours ? '<dt>办公时间</dt><dd>' + esc(dept.hours) + '</dd>' : '') +
      '</div>' +
      (ent.alias && ent.alias.length
        ? '<div class="sec"><b>同义词（用于实体链接）</b><div class="chips">' +
        ent.alias.map(a => '<span class="chip">' + esc(a) + '</span>').join("") + '</div></div>' : '') +
      (dept && dept.scope
        ? '<div class="sec"><b>职责范围</b><div class="chips">' +
        dept.scope.map(s => '<span class="chip">' + esc(s) + '</span>').join("") + '</div></div>' : '') +
      (neighbors.length
        ? '<div class="sec"><b>一跳关系（' + neighbors.length + '）</b>' +
        neighbors.slice(0, 12).map(n =>
          '<div class="kv" style="cursor:pointer" data-goto="' + esc(n.other.id) + '">' +
          '<span>' + esc(n.rel) + '</span><span>' + esc(n.other.name) + '</span></div>').join("") +
        '</div>' : '') +
      (entries.length
        ? '<div class="sec"><b>关联知识条目（' + entries.length + '）</b>' +
        entries.map(e2 => '<div class="kv"><span style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          esc(e2.q) + '</span><span>' + esc(e2.cat) + '</span></div>').join('') + '</div>'
        : '<div class="sec"><div class="side-empty">该实体暂无直接关联的知识条目，但它仍参与多跳召回（通过关系扩散影响相邻实体）。</div></div>');

    /* 点击一跳邻居可以跳转过去，形成"沿着关系走"的浏览体验 */
    this.side.querySelectorAll("[data-goto]").forEach(row => {
      row.onclick = () => {
        const id = row.getAttribute("data-goto");
        const n2 = this.nodes.find(x => x.id === id);
        if (!n2) return;
        /* 把目标节点带到视野中心 */
        this.pan.x = this.host.clientWidth / 2 - n2.x * this.zoom;
        this.pan.y = this.host.clientHeight / 2 - n2.y * this.zoom;
        this.selected = id;
        this._renderSide(n2);
      };
    });
  }

  show() {
    this.build();
    if (this.host) {
      const W = this.host.clientWidth, H = this.host.clientHeight;
      this.canvas.width = Math.round(W * this.dpr);
      this.canvas.height = Math.round(H * this.dpr);
    }
  }
}
