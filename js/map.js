/* ============================================================
 * v2 前端 · 交互式 2.5D 校园地图
 *
 * ── 本次美化要点 ──
 *  1. 建筑有"厚度"：每栋楼用「投影 + 主体渐变 + 顶部亮边 + 左侧受光带 + 底部压边」
 *     五层叠出立体感，不再是一堆平面圆角矩形
 *  2. 校园绿化：草坪地块 + 双层树冠的树木符号，让留白区域不再空
 *  3. 道路分层：路肩描边 + 路面 + 中心虚线，层次接近真实导览图
 *  4. 入口标识：多层建筑正面加门厅色块；校门单独画成牌坊造型（立柱 + 横梁 + 门匾）
 *  5. 中心广场：圆形铺装 + 同心圆纹理 + 绿岛 + 旗杆，给画面一个视觉焦点
 *  6. 实时状态叠加：已关闭建筑降透明度 + 冷色罩，开放建筑正常显示
 *
 * 坐标体系与 data/places.json 一致：0~1000 逻辑坐标，y 轴向下。
 * ============================================================ */

import { $, esc, clamp, toast } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
  return n;
}

/* 各分类配色：[主体上色, 主体下色, 顶部亮边, 投影]
   色调依据学校官方图集实拍：兴安校区以橙红／铁锈红陶板 + 灰白为主，
   早期版本用的米黄奶油色与实景不符，已整体校正。 */
const PALETTE = {
  "图书馆":     ["#e8cfae", "#c9a87e", "#f7e6cd", "rgba(24,34,48,.40)"],
  "自习室":     ["#ecdcbe", "#cfb894", "#f9efdc", "rgba(24,34,48,.34)"],
  "教学楼":     ["#e3c9a6", "#c2a077", "#f4e2c7", "rgba(24,34,48,.38)"],
  "学院楼":     ["#dfab7d", "#bd8557", "#f2c9a4", "rgba(24,34,48,.40)"],
  "行政":       ["#e9dcc4", "#cbb894", "#f8f0e0", "rgba(24,34,48,.40)"],
  "住宿":       ["#d99a72", "#b5734c", "#eeb894", "rgba(24,34,48,.42)"],
  "餐饮":       ["#e5cfA6", "#c6ac7d", "#f5e8cb", "rgba(24,34,48,.36)"],
  "生活服务":   ["#ddd0b6", "#bfae8d", "#f1e7d4", "rgba(24,34,48,.34)"],
  "医疗":       ["#e7e4d8", "#c8c4b3", "#f6f4ec", "rgba(24,34,48,.32)"],
  "艺术实践":   ["#e0906a", "#bc6c46", "#f2b18c", "rgba(24,34,48,.42)"],
  "自习与活动": ["#e0c3a0", "#c1a077", "#f2e0c8", "rgba(24,34,48,.38)"],
  "运动场馆":   ["#c85a4a", "#a34134", "#e07a67", "rgba(24,34,48,.34)"],
  "水域":       ["#3f7fa8", "#2b5f83", "#5fa2c8", "rgba(10,30,50,.30)"],
  "交通":       ["#b9bfc4", "#9aa1a7", "#ccd2d7", "rgba(24,34,48,.26)"],
  "出入口":     ["#e8c341", "#c99e1f", "#f7dd7a", "rgba(24,34,48,.34)"],
  "公共空间":   ["#c8bfa8", "#a89e83", "#dcd4c0", "rgba(24,34,48,.24)"],
};
const DEFAULT_PAL = ["#ddc7a6", "#bda684", "#eeddc4", "rgba(24,34,48,.36)"];

export class CampusMap {
  constructor(ctx) {
    this.ctx = ctx;
    this.svg = $("campusMap");
    this.side = $("mapSide");
    this.meta = $("mapMeta");
    this.rag = window.RAG;

    this.cam = { x: 0, y: 0, w: 1000, h: 1000 };
    this.DEFAULT = { x: 0, y: 0, w: 1000, h: 1000 };
    this.drag = null;
    this.anim = null;
    this.routeEls = [];
    this.live = true;

    this._buildScene();
    this._bind();
    this._applyCam();
    this.renderStatus();
    if (this.meta) this.meta.textContent = "拖拽平移 · 滚轮缩放 · 点击楼宇查看详情";
  }

  _key(cat) { return String(cat).replace(/[^\w\u4e00-\u9fa5]/g, ""); }

  /* ══════════════ 渐变与滤镜 ══════════════ */
  _buildDefs(defs) {
    const ground = svg("radialGradient", { id: "mpGround", cx: "50%", cy: "40%", r: "78%" });
    ground.appendChild(svg("stop", { offset: "0%", "stop-color": "#1b2f45" }));
    ground.appendChild(svg("stop", { offset: "62%", "stop-color": "#132438" }));
    ground.appendChild(svg("stop", { offset: "100%", "stop-color": "#0b1725" }));
    defs.appendChild(ground);

    const lawn = svg("linearGradient", { id: "mpLawn", x1: "0", y1: "0", x2: "0", y2: "1" });
    lawn.appendChild(svg("stop", { offset: "0%", "stop-color": "#27412f" }));
    lawn.appendChild(svg("stop", { offset: "100%", "stop-color": "#1c3124" }));
    defs.appendChild(lawn);

    const pave = svg("linearGradient", { id: "mpPave", x1: "0", y1: "0", x2: "0", y2: "1" });
    pave.appendChild(svg("stop", { offset: "0%", "stop-color": "#4a545c" }));
    pave.appendChild(svg("stop", { offset: "100%", "stop-color": "#39424a" }));
    defs.appendChild(pave);

    /* 每个分类一套建筑渐变（受光面 → 背光面） */
    Object.keys(PALETTE).forEach(k => {
      const p = PALETTE[k];
      const g = svg("linearGradient", { id: "mpB_" + this._key(k), x1: "0", y1: "0", x2: "0", y2: "1" });
      g.appendChild(svg("stop", { offset: "0%", "stop-color": p[0] }));
      g.appendChild(svg("stop", { offset: "100%", "stop-color": p[1] }));
      defs.appendChild(g);
    });
    const gd = svg("linearGradient", { id: "mpB_def", x1: "0", y1: "0", x2: "0", y2: "1" });
    gd.appendChild(svg("stop", { offset: "0%", "stop-color": DEFAULT_PAL[0] }));
    gd.appendChild(svg("stop", { offset: "100%", "stop-color": DEFAULT_PAL[1] }));
    defs.appendChild(gd);

    const route = svg("linearGradient", { id: "mpRoute", x1: "0", y1: "0", x2: "1", y2: "1" });
    route.appendChild(svg("stop", { offset: "0%", "stop-color": "#38bdf8" }));
    route.appendChild(svg("stop", { offset: "100%", "stop-color": "#a78bfa" }));
    defs.appendChild(route);

    /* 金色大门专用渐变：上亮下深，模拟金属曲面的受光变化 */
    const gold = svg("linearGradient", { id: "mpGateGold", x1: "0", y1: "0", x2: "0.6", y2: "1" });
    gold.appendChild(svg("stop", { offset: "0%", "stop-color": "#f5d76e" }));
    gold.appendChild(svg("stop", { offset: "45%", "stop-color": "#e0b93c" }));
    gold.appendChild(svg("stop", { offset: "100%", "stop-color": "#b8891c" }));
    defs.appendChild(gold);

    /* 水面：从浅到深，边缘略亮，像有倒影 */
    const water = svg("linearGradient", { id: "mpWater", x1: "0", y1: "0", x2: "0.3", y2: "1" });
    water.appendChild(svg("stop", { offset: "0%", "stop-color": "#5fa2c8" }));
    water.appendChild(svg("stop", { offset: "55%", "stop-color": "#3f7fa8" }));
    water.appendChild(svg("stop", { offset: "100%", "stop-color": "#2b5f83" }));
    defs.appendChild(water);

    const glow = svg("filter", { id: "mpGlow", x: "-60%", y: "-60%", width: "220%", height: "220%" });
    glow.appendChild(svg("feGaussianBlur", { stdDeviation: "5", result: "b" }));
    const merge = svg("feMerge");
    merge.appendChild(svg("feMergeNode", { in: "b" }));
    merge.appendChild(svg("feMergeNode", { in: "SourceGraphic" }));
    glow.appendChild(merge);
    defs.appendChild(glow);

    /* 投影柔化：让建筑阴影看起来是漫射的而不是硬边 */
    const soft = svg("filter", { id: "mpSoft", x: "-40%", y: "-40%", width: "180%", height: "180%" });
    soft.appendChild(svg("feGaussianBlur", { stdDeviation: "3" }));
    defs.appendChild(soft);
  }

  /* ══════════════ 场景 ══════════════ */
  _buildScene() {
    this.svg.innerHTML = "";
    const defs = svg("defs");
    this.svg.appendChild(defs);
    this._buildDefs(defs);

    this.gGround = svg("g");
    this.gZones = svg("g");
    this.gRoads = svg("g");
    this.gRoute = svg("g");
    this.gBuildings = svg("g");
    this.gLabels = svg("g");
    [this.gGround, this.gZones, this.gRoads, this.gRoute, this.gBuildings, this.gLabels]
      .forEach(g => this.svg.appendChild(g));

    this.gGround.appendChild(svg("rect", { class: "ground", x: 0, y: 0, width: 1000, height: 1000 }));

    /* 细网格：给底图一点技术感，但压得很淡，不抢主体 */
    for (let i = 40; i < 1000; i += 40) {
      this.gGround.appendChild(svg("line", { class: "grid-line", x1: i, y1: 0, x2: i, y2: 1000 }));
      this.gGround.appendChild(svg("line", { class: "grid-line", x1: 0, y1: i, x2: 1000, y2: i }));
    }

    this.places = (this.rag.placesPayload ? this.rag.placesPayload().places : []) || [];
    this._buildLandscape();
    this._buildZones();
    this._buildRoads();
    this._buildPlaza();
    this._buildBuildings();
  }

  /* ══════════════ 绿化：草坪地块 + 树木 ══════════════ */
  _buildLandscape() {
    const LAWNS = [
      { x: 64, y: 200, w: 240, h: 90 },     // 艺术实践区之间
      { x: 404, y: 108, w: 250, h: 92 },    // 影视楼与演播厅东侧
      { x: 62, y: 510, w: 200, h: 88 },     // 宿舍西侧
      { x: 278, y: 596, w: 150, h: 74 },    // 宿舍与广场之间
      { x: 660, y: 190, w: 150, h: 92 },    // 水系西岸
      { x: 440, y: 366, w: 150, h: 82 },    // 图书馆前绿地
      { x: 808, y: 560, w: 118, h: 120 },   // 田径场与停车场之间
      { x: 300, y: 236, w: 190, h: 100 },   // 学院楼与活动中心之间
    ];
    LAWNS.forEach(r => {
      this.gGround.appendChild(svg("rect", {
        x: r.x, y: r.y, width: r.w, height: r.h, rx: 16,
        fill: "url(#mpLawn)", opacity: ".85",
      }));
      this.gGround.appendChild(svg("rect", {
        x: r.x, y: r.y, width: r.w, height: r.h, rx: 16,
        fill: "none", stroke: "rgba(120,190,140,.16)", "stroke-width": "1.5",
      }));
    });

    /* 树木：确定性伪随机，保证每次刷新位置一致 */
    let seed = 20260226;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const zones = LAWNS.concat([
      { x: 486, y: 176, w: 150, h: 96 },    // 北侧
      { x: 118, y: 630, w: 150, h: 90 },    // 食堂周边
    ]);
    zones.forEach(z => {
      const n = Math.max(3, Math.round(z.w * z.h / 6200));
      for (let i = 0; i < n; i++) {
        const x = z.x + 12 + rnd() * (z.w - 24);
        const y = z.y + 12 + rnd() * (z.h - 24);
        const s = 0.75 + rnd() * 0.6;
        const tree = svg("g", {
          class: "mp-tree",
          transform: "translate(" + x.toFixed(1) + "," + y.toFixed(1) + ") scale(" + s.toFixed(2) + ")",
        });
        /* 阴影 + 树干 + 三层树冠，这个层次就足够看出是树 */
        tree.appendChild(svg("ellipse", { cx: "1.5", cy: "5.5", rx: "5", ry: "2.4", fill: "rgba(0,0,0,.28)", filter: "url(#mpSoft)" }));
        tree.appendChild(svg("rect", { x: "-1", y: "-1", width: "2", height: "5", rx: ".8", fill: "#4a3a28" }));
        tree.appendChild(svg("circle", { cx: "0", cy: "-4", r: "5.4", fill: "#2f6b40" }));
        tree.appendChild(svg("circle", { cx: "-2.2", cy: "-6", r: "3.6", fill: "#3d7f4d" }));
        tree.appendChild(svg("circle", { cx: "2.4", cy: "-5.4", r: "3.2", fill: "#357045" }));
        this.gGround.appendChild(tree);
      }
    });
  }

  /* ══════════════ 功能分区标签 ══════════════ */
  _buildZones() {
    [
      { t: "教学与自习区", x: 690, y: 400 },
      { t: "艺术实践区", x: 410, y: 80 },
      { t: "生活服务区", x: 250, y: 758 },
      { t: "宿舍区", x: 200, y: 462 },
      { t: "运动区", x: 882, y: 612 },
    ].forEach(z => {
      const t = svg("text", { class: "zone-label", x: z.x, y: z.y });
      t.textContent = z.t;
      this.gZones.appendChild(t);
    });
  }

  /* ══════════════ 道路：显式路网（主干道 + 支路） ══════════════
     早期版本直接按 places 的 edges 两两连线，几十条斜线乱穿校园，
     看起来像蜘蛛网而不是路网。这里改为显式声明两级道路：
       主干道 —— 串联大门、广场、食堂、图书馆、活动中心、田径场等主要节点，形成环线
       支路   —— 从主干道节点接到单体建筑
     折点直接取各场所中心，按合理顺序串联以避免斜穿建筑。 */
  _buildRoads() {
    const byId = new Map(this.places.map(p => [p.id, p]));

    const MAIN = [
      ["place_gate", "place_plaza", "place_canteen"],
      ["place_canteen", "place_admin_office"],
      ["place_admin_office", "place_dorm", "place_activity_center"],
      ["place_activity_center", "lake_fountain", "library_huatonglou"],
      ["library_huatonglou", "building_a", "place_print"],
      ["place_print", "place_sports", "place_clinic"],
      ["place_clinic", "place_express", "place_market", "place_plaza"],
      ["place_activity_center", "building_journalism", "building_film"],
      ["building_film", "place_rehearsal", "building_music_hall"],
      ["place_print", "lake_campus"],
      ["place_studio", "building_b"],
      ["building_b", "lake_campus"],
    ];
    const BRANCH = [
      ["place_dorm", "place_bathhouse"],
      ["library_huatonglou", "place_study_a113"],
      ["place_activity_center", "place_study_center"],
      ["place_plaza", "place_parking"],
    ];

    const draw = (ids, kind) => {
      const pts = ids.map(id => byId.get(id)).filter(Boolean);
      if (pts.length < 2) return;
      const d = pts.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" ");
      if (kind === "main") {
        this.gRoads.appendChild(svg("path", { class: "road-shoulder", d }));
        this.gRoads.appendChild(svg("path", { class: "road", d }));
        this.gRoads.appendChild(svg("path", { class: "road-center", d }));
      } else {
        this.gRoads.appendChild(svg("path", { class: "road-branch-shoulder", d }));
        this.gRoads.appendChild(svg("path", { class: "road-branch", d }));
      }
    };
    MAIN.forEach(ids => draw(ids, "main"));
    BRANCH.forEach(ids => draw(ids, "branch"));
  }

  /* ══════════════ 中心广场（视觉焦点） ══════════════ */
  _buildPlaza() {
    const g = svg("g", { class: "mp-plaza" });
    g.appendChild(svg("circle", { cx: 411, cy: 795, r: 50, fill: "url(#mpPave)", opacity: ".9" }));
    g.appendChild(svg("circle", { cx: 411, cy: 795, r: 50, fill: "none", stroke: "rgba(180,210,240,.18)", "stroke-width": "2" }));
    g.appendChild(svg("circle", { cx: 411, cy: 795, r: 34, fill: "none", stroke: "rgba(180,210,240,.12)", "stroke-width": "1.5" }));
    g.appendChild(svg("circle", { cx: 411, cy: 795, r: 20, fill: "url(#mpLawn)", stroke: "rgba(120,190,140,.22)", "stroke-width": "1.5" }));
    /* 旗杆与旗帜 */
    g.appendChild(svg("rect", { x: 409, y: 742, width: 4, height: 44, rx: 2, fill: "#c9d3dc" }));
    g.appendChild(svg("rect", { x: 413, y: 742, width: 22, height: 14, fill: "#c8332f", opacity: ".92" }));
    this.gGround.appendChild(g);
  }

  /* ══════════════ 建筑 ══════════════ */
  _buildBuildings() {
    this.bldgNodes = new Map();
    this.places.forEach(p => {
      const pal = PALETTE[p.category] || DEFAULT_PAL;
      const gradId = PALETTE[p.category] ? "mpB_" + this._key(p.category) : "mpB_def";
      const r = p.rect || { x: p.x - 45, y: p.y - 35, w: 90, h: 70 };

      /* 按 shape 分派到专用画法：跑道 / 水域 / 喷泉 / 校门 / 地坪 */
      if (p.category === "出入口") { this._drawGate(p, r, pal); return; }
      if (p.shape === "track") { this._drawTrack(p, r); return; }
      if (p.shape === "lake") { this._drawLake(p, r); return; }
      if (p.shape === "fountain") { this._drawFountain(p, r); return; }
      if (p.category === "公共空间" || p.category === "交通") { this._drawPad(p, r); return; }

      const g = svg("g", { class: "mp-bldg", "data-id": p.id });

      /* ① 投影：向右下偏移并模糊，制造"楼是立起来的"错觉 */
      g.appendChild(svg("rect", {
        x: r.x + 5, y: r.y + 7, width: r.w, height: r.h, rx: 7,
        fill: pal[3], filter: "url(#mpSoft)",
      }));
      /* ② 主体（受光 → 背光渐变） */
      const body = svg("rect", {
        class: "bldg", x: r.x, y: r.y, width: r.w, height: r.h, rx: 7,
        fill: "url(#" + gradId + ")", "data-id": p.id,
      });
      const title = svg("title");
      title.textContent = p.name + "（" + p.category + "）";
      body.appendChild(title);
      body.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
      g.appendChild(body);
      /* ③ 顶部亮边：模拟受光的屋顶边缘 */
      g.appendChild(svg("rect", {
        x: r.x + 1.5, y: r.y + 1.5, width: r.w - 3, height: Math.min(7, r.h * .16), rx: 5,
        fill: pal[2], opacity: ".55",
      }));
      /* ④ 左侧受光带：立方体感 */
      g.appendChild(svg("rect", {
        x: r.x + 1.5, y: r.y + 1.5, width: Math.min(5, r.w * .07), height: r.h - 3, rx: 4,
        fill: "#ffffff", opacity: ".10",
      }));
      /* ⑤ 底部压边：与地面接触处加深，避免"飘" */
      g.appendChild(svg("rect", {
        x: r.x, y: r.y + r.h - 4, width: r.w, height: 4, rx: 2,
        fill: "rgba(0,0,0,.28)",
      }));
      /* ⑥ 立面窗格：按楼体尺寸铺一层细格，远看像玻璃幕墙/窗带 */
      const cols = Math.max(2, Math.round(r.w / 26));
      const rows = Math.max(2, Math.round(r.h / 26));
      const gapX = r.w / cols, gapY = r.h / rows;
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          g.appendChild(svg("rect", {
            x: r.x + cx * gapX + gapX * .18, y: r.y + cy * gapY + gapY * .22,
            width: gapX * .64, height: gapY * .40, rx: 1.4,
            fill: "rgba(255,255,255,.16)",
          }));
        }
      }
      /* ⑦ 门厅：多层建筑的正面入口色块 */
      if (r.h > 40 && r.w > 40) {
        g.appendChild(svg("rect", {
          x: p.x - Math.min(13, r.w * .16), y: r.y + r.h - 9,
          width: Math.min(26, r.w * .32), height: 9, rx: 3,
          fill: "rgba(56,189,248,.38)", stroke: "rgba(56,189,248,.5)", "stroke-width": ".8",
        }));
      }
      this.gBuildings.appendChild(g);

      const label = svg("text", { class: "bldg-label", x: p.x, y: r.y + r.h + 20 });
      label.textContent = p.name.length > 9 ? p.name.slice(0, 9) : p.name;
      this.gLabels.appendChild(label);

      this.bldgNodes.set(p.id, { g, body, label, place: p });
    });
  }

  /* ── 田径场：红色环形跑道 + 中央绿色足球场 + 西侧看台 ── */
  _drawTrack(p, r) {
    const g = svg("g", { class: "mp-bldg", "data-id": p.id });
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    /* 跑道外圈：400m 标准场地是圆角矩形，用大圆角实现 */
    const trackOuter = { x: r.x, y: r.y, w: r.w, h: r.h, rx: Math.min(r.w, r.h) * .42 };
    g.appendChild(svg("rect", {
      x: trackOuter.x + 4, y: trackOuter.y + 6, width: trackOuter.w, height: trackOuter.h,
      rx: trackOuter.rx, fill: "rgba(24,34,48,.34)", filter: "url(#mpSoft)",
    }));
    g.appendChild(svg("rect", {
      class: "bldg", x: trackOuter.x, y: trackOuter.y, width: trackOuter.w, height: trackOuter.h,
      rx: trackOuter.rx, fill: "#b4483a", stroke: "rgba(255,190,170,.30)", "stroke-width": "1.6",
      "data-id": p.id,
    }));
    /* 跑道分道线：两条内缩的白线 */
    [0.86, 0.74].forEach(k => {
      g.appendChild(svg("rect", {
        x: cx - r.w * k / 2, y: cy - r.h * k / 2, width: r.w * k, height: r.h * k,
        rx: Math.min(r.w, r.h) * k * .42, fill: "none",
        stroke: "rgba(255,255,255,.32)", "stroke-width": "1",
      }));
    });
    /* 中央足球场 */
    g.appendChild(svg("rect", {
      x: cx - r.w * .29, y: cy - r.h * .29, width: r.w * .58, height: r.h * .58, rx: 3,
      fill: "#3d7a45", stroke: "rgba(255,255,255,.42)", "stroke-width": "1.2",
    }));
    /* 中圈与中线、禁区 */
    g.appendChild(svg("circle", { cx: cx, cy: cy, r: r.w * .09, fill: "none", stroke: "rgba(255,255,255,.40)", "stroke-width": "1" }));
    g.appendChild(svg("line", { x1: cx, y1: cy - r.h * .29, x2: cx, y2: cy + r.h * .29, stroke: "rgba(255,255,255,.40)", "stroke-width": "1" }));
    [-1, 1].forEach(sgn => {
      g.appendChild(svg("rect", {
        x: cx - r.w * .13, y: cy + sgn * r.h * .29 - (sgn > 0 ? 0 : r.h * .10),
        width: r.w * .26, height: r.h * .10,
        fill: "none", stroke: "rgba(255,255,255,.38)", "stroke-width": "1",
      }));
    });
    /* 西侧看台：红白座椅分段，朝向操场 */
    const standW = Math.min(16, r.w * .11);
    g.appendChild(svg("rect", {
      x: r.x - standW - 2, y: r.y + r.h * .18, width: standW, height: r.h * .64, rx: 3,
      fill: "#8f3a2e", stroke: "rgba(255,200,180,.32)", "stroke-width": "1",
    }));
    for (let i = 1; i < 5; i++) {
      g.appendChild(svg("line", {
        x1: r.x - standW - 2, y1: r.y + r.h * .18 + i * r.h * .64 / 5,
        x2: r.x - 2, y2: r.y + r.h * .18 + i * r.h * .64 / 5,
        stroke: "rgba(255,235,225,.30)", "stroke-width": "1",
      }));
    }
    const title = svg("title");
    title.textContent = p.name + "（环形跑道 + 足球场 + 看台）";
    g.appendChild(title);
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
    this.gBuildings.appendChild(g);

    const label = svg("text", { class: "bldg-label", x: cx, y: r.y + r.h + 20 });
    label.textContent = "田径场";
    this.gLabels.appendChild(label);
    this.bldgNodes.set(p.id, { g, body: g, label, place: p });
  }

  /* ── 水域：不规则湖面 + 蜿蜒曲桥 ── */
  _drawLake(p, r) {
    const g = svg("g", { class: "mp-bldg", "data-id": p.id });
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    /* 用一组重叠椭圆拼出不规则水面，比矩形自然 */
    const blobs = [
      [cx - r.w * .22, cy - r.h * .18, r.w * .34, r.h * .30],
      [cx + r.w * .16, cy - r.h * .10, r.w * .30, r.h * .28],
      [cx - r.w * .06, cy + r.h * .20, r.w * .36, r.h * .26],
      [cx + r.w * .30, cy + r.h * .26, r.w * .22, r.h * .20],
    ];
    g.appendChild(svg("ellipse", {
      cx: cx + 3, cy: cy + 5, rx: r.w * .46, ry: r.h * .44,
      fill: "rgba(10,26,44,.40)", filter: "url(#mpSoft)",
    }));
    blobs.forEach(b => {
      g.appendChild(svg("ellipse", { cx: b[0], cy: b[1], rx: b[2], ry: b[3], fill: "url(#mpWater)" }));
    });
    /* 水岸亮边 */
    blobs.forEach(b => {
      g.appendChild(svg("ellipse", {
        cx: b[0], cy: b[1], rx: b[2], ry: b[3], fill: "none",
        stroke: "rgba(150,210,240,.22)", "stroke-width": "1.4",
      }));
    });
    /* 曲桥：一条蜿蜒的浅色木栈道，对应夜景航拍里那串发光曲线 */
    const bx0 = cx - r.w * .42, by0 = cy + r.h * .30;
    const bx1 = cx + r.w * .42, by1 = cy - r.h * .26;
    const d = "M" + bx0 + " " + by0 +
      " C" + (bx0 + r.w * .18) + " " + (by0 - r.h * .34) +
      " " + (bx0 + r.w * .40) + " " + (by0 + r.h * .12) +
      " " + (cx) + " " + (cy - r.h * .04) +
      " C" + (cx + r.w * .18) + " " + (cy - r.h * .20) +
      " " + (cx + r.w * .26) + " " + (by1 + r.h * .18) +
      " " + bx1 + " " + by1;
    g.appendChild(svg("path", { d, fill: "none", stroke: "rgba(8,18,30,.55)", "stroke-width": "7", "stroke-linecap": "round" }));
    g.appendChild(svg("path", { d, fill: "none", stroke: "#d9c9a8", "stroke-width": "4.2", "stroke-linecap": "round" }));
    g.appendChild(svg("path", { d, fill: "none", stroke: "rgba(255,240,210,.45)", "stroke-width": "1.2", "stroke-linecap": "round", "stroke-dasharray": "4 6" }));
    /* 水面反光纹理 */
    for (let i = 0; i < 5; i++) {
      const ry = cy - r.h * .2 + i * r.h * .12;
      g.appendChild(svg("line", {
        x1: cx - r.w * .3 + i * 5, y1: ry, x2: cx + r.w * .12, y2: ry,
        stroke: "rgba(180,225,255,.16)", "stroke-width": "1.2", "stroke-linecap": "round",
      }));
    }
    const title = svg("title");
    title.textContent = p.name;
    g.appendChild(title);
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
    this.gBuildings.appendChild(g);

    const label = svg("text", { class: "bldg-label", x: cx, y: r.y + r.h + 20 });
    label.textContent = "校园水系";
    this.gLabels.appendChild(label);
    this.bldgNodes.set(p.id, { g, body: g, label, place: p });
  }

  /* ── 喷泉广场：方形水池 + 中央橙色环形雕塑 ── */
  _drawFountain(p, r) {
    const g = svg("g", { class: "mp-bldg", "data-id": p.id });
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    /* 铺装广场 */
    g.appendChild(svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, fill: "url(#mpPave)", opacity: ".9" }));
    g.appendChild(svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 10, fill: "none", stroke: "rgba(180,210,240,.16)", "stroke-width": "1.4" }));
    /* 水池 */
    const pw = r.w * .62, ph = r.h * .46;
    g.appendChild(svg("rect", {
      x: cx - pw / 2 + 3, y: cy - ph / 2 + 4, width: pw, height: ph, rx: 6,
      fill: "rgba(10,26,44,.40)", filter: "url(#mpSoft)",
    }));
    g.appendChild(svg("rect", {
      x: cx - pw / 2, y: cy - ph / 2, width: pw, height: ph, rx: 6,
      fill: "url(#mpWater)", stroke: "rgba(160,215,245,.34)", "stroke-width": "1.4",
    }));
    /* 中央橙色环形雕塑（校园地标） */
    const ringR = Math.min(pw, ph) * .30;
    g.appendChild(svg("circle", {
      cx: cx + 2, cy: cy + 3, r: ringR, fill: "none",
      stroke: "rgba(10,26,44,.45)", "stroke-width": "7", filter: "url(#mpSoft)",
    }));
    g.appendChild(svg("circle", {
      cx: cx, cy: cy, r: ringR, fill: "none",
      stroke: "#e8621f", "stroke-width": "6",
    }));
    g.appendChild(svg("circle", {
      cx: cx, cy: cy, r: ringR, fill: "none",
      stroke: "#ffa15c", "stroke-width": "2", opacity: ".85",
    }));
    /* 水花：环形周围的放射细线 */
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      g.appendChild(svg("line", {
        x1: cx + Math.cos(a) * ringR * .35, y1: cy + Math.sin(a) * ringR * .35,
        x2: cx + Math.cos(a) * ringR * .92, y2: cy + Math.sin(a) * ringR * .92,
        stroke: "rgba(200,235,255,.42)", "stroke-width": "1",
      }));
    }
    const title = svg("title");
    title.textContent = p.name;
    g.appendChild(title);
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
    this.gBuildings.appendChild(g);

    const label = svg("text", { class: "bldg-label", x: cx, y: r.y + r.h + 20 });
    label.textContent = "喷泉广场";
    this.gLabels.appendChild(label);
    this.bldgNodes.set(p.id, { g, body: g, label, place: p });
  }

  /**
   * 金色大门：学校形象地标，造型是横向的巨大金色曲面拱门
   * （左侧低矮着地、向右扬起成尖角，门下有道路穿过）。
   * 这是最具辨识度的建筑符号，值得单独绘制而不是套用通用方形门。
   */
  _drawGate(p, r, pal) {
    const g = svg("g", { class: "mp-bldg", "data-id": p.id });
    const cx = p.x, y = p.y;
    const W = 132, H = 58;                  // 大门整体尺度（逻辑坐标）
    const left = cx - W / 2, top = y - H;

    /* 地面投影 */
    g.appendChild(svg("rect", {
      x: left + 6, y: y - 6, width: W, height: 20, rx: 6,
      fill: "rgba(24,34,48,.34)", filter: "url(#mpSoft)",
    }));

    /* 金色曲面板：外轮廓用一条上扬的曲线，模拟拱门"飞起来"的造型 */
    const d =
      "M" + left + " " + (y - 6) +
      " L" + (left + W * 0.04) + " " + top +
      " L" + (left + W * 0.78) + " " + top +
      " C" + (left + W * 0.92) + " " + top + " " + (left + W * 1.0) + " " + (top + 10) + " " + (left + W) + " " + (y - 30) +
      " L" + (left + W * 0.62) + " " + (y - 22) +
      " C" + (left + W * 0.34) + " " + (y - 18) + " " + (left + W * 0.16) + " " + (y - 12) + " " + left + " " + (y - 6) +
      " Z";
    g.appendChild(svg("path", {
      class: "bldg", d, fill: "url(#mpGateGold)",
      stroke: "rgba(255,236,180,.55)", "stroke-width": "1.6", "data-id": p.id,
    }));
    /* 顶部受光高光 */
    g.appendChild(svg("path", {
      d: "M" + (left + W * 0.04) + " " + top + " L" + (left + W * 0.78) + " " + top +
        " L" + (left + W * 0.76) + " " + (top + 5) + " L" + (left + W * 0.05) + " " + (top + 5) + " Z",
      fill: "#ffe9a6", opacity: ".75",
    }));
    /* 下方拱洞：让门看起来是"穿过"的 */
    g.appendChild(svg("path", {
      d: "M" + (left + W * 0.20) + " " + (y - 8) +
        " L" + (left + W * 0.24) + " " + (y - 26) +
        " C" + (left + W * 0.42) + " " + (y - 32) + " " + (left + W * 0.50) + " " + (y - 26) + " " + (left + W * 0.56) + " " + (y - 8) + " Z",
      fill: "rgba(12,22,36,.55)",
    }));
    /* 校名标牌（门外右侧的白色牌） */
    g.appendChild(svg("rect", {
      x: cx + W * 0.30, y: y - 16, width: 52, height: 13, rx: 2,
      fill: "rgba(250,252,255,.92)", stroke: "rgba(150,175,200,.6)", "stroke-width": ".8",
    }));
    const plate = svg("text", {
      x: cx + W * 0.30 + 26, y: y - 6.5, "text-anchor": "middle",
      fill: "#1d3550", "font-size": "8.4", "font-weight": "700",
    });
    plate.textContent = "河北传媒学院";
    g.appendChild(plate);
    /* 栅栏与保安亭 */
    for (let i = -3; i <= 3; i++) {
      g.appendChild(svg("line", {
        x1: cx + i * 12, y1: y - 14, x2: cx + i * 12, y2: y + 4,
        stroke: "rgba(210,222,234,.42)", "stroke-width": "1.2",
      }));
    }

    const title = svg("title");
    title.textContent = p.name + "（学校形象地标）";
    g.appendChild(title);
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
    this.gBuildings.appendChild(g);

    const label = svg("text", { class: "bldg-label", x: cx, y: y + 30 });
    label.textContent = "金色大门";
    this.gLabels.appendChild(label);
    this.bldgNodes.set(p.id, { g, body: g, label, place: p });
  }

  /** 广场 / 停车场：铺装 + 相应纹理 */
  _drawPad(p, r) {
    const g = svg("g", { class: "mp-bldg", "data-id": p.id });
    g.appendChild(svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: "url(#mpPave)", opacity: ".85" }));
    g.appendChild(svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: "none", stroke: "rgba(180,210,240,.14)", "stroke-width": "1.4" }));
    if (p.category === "公共空间") {
      g.appendChild(svg("circle", { cx: p.x, cy: p.y, r: Math.min(r.w, r.h) * .34, fill: "none", stroke: "rgba(180,210,240,.16)", "stroke-width": "1.2" }));
      g.appendChild(svg("circle", { cx: p.x, cy: p.y, r: Math.min(r.w, r.h) * .18, fill: "none", stroke: "rgba(180,210,240,.12)", "stroke-width": "1" }));
    } else {
      for (let i = 1; i < 4; i++) {
        const x = r.x + i * r.w / 4;
        g.appendChild(svg("line", {
          x1: x, y1: r.y + 6, x2: x, y2: r.y + r.h - 6,
          stroke: "rgba(220,230,240,.20)", "stroke-width": "1",
        }));
      }
    }
    g.addEventListener("click", (e) => { e.stopPropagation(); this.select(p.id, true); });
    this.gBuildings.appendChild(g);
    const label = svg("text", { class: "bldg-label", x: p.x, y: r.y + r.h + 20 });
    label.textContent = p.name;
    this.gLabels.appendChild(label);
    this.bldgNodes.set(p.id, { g, body: g, label, place: p });
  }

  /* ══════════════ 相机 ══════════════ */
  _applyCam() {
    const c = this.cam;
    this.svg.setAttribute("viewBox", c.x + " " + c.y + " " + c.w + " " + c.h);
  }

  _screenToSvg(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: this.cam.x + (clientX - r.left) / r.width * this.cam.w,
      y: this.cam.y + (clientY - r.top) / r.height * this.cam.h,
    };
  }

  flyTo(target, ms) {
    const dur = ms || 620;
    const from = Object.assign({}, this.cam);
    const to = { x: target.x - target.w * .5, y: target.y - target.h * .5, w: target.w, h: target.h };
    if (this.anim) cancelAnimationFrame(this.anim);
    const t0 = performance.now();
    const step = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      this.cam.x = from.x + (to.x - from.x) * e;
      this.cam.y = from.y + (to.y - from.y) * e;
      this.cam.w = from.w + (to.w - from.w) * e;
      this.cam.h = from.h + (to.h - from.h) * e;
      this._applyCam();
      this.anim = p < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  focusPlace(placeId, animate) {
    const p = this.places.find(x => x.id === placeId);
    if (!p) return;
    const r = p.rect || { x: p.x - 60, y: p.y - 50, w: 120, h: 100 };
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const size = Math.max(r.w, r.h) * 4.2 + 200;
    this.flyTo({ x: cx, y: cy, w: size, h: size }, animate === false ? 1 : 640);
    this.select(placeId, false);
    this._pulseAt(p.x, p.y);
  }

  _pulseAt(x, y) {
    this.gRoute.querySelectorAll(".pulse").forEach(n => n.remove());
    const c = svg("circle", { class: "pulse", cx: x, cy: y, r: 8 });
    this.gRoute.appendChild(c);
    setTimeout(() => c.remove(), 3200);
  }

  /* ══════════════ 路线导航 ══════════════ */
  showRoute(fromId, toId) {
    this.clearRoute();
    const rag = this.rag;
    const from = typeof fromId === "string" ? rag.findPlace(fromId) : fromId;
    const to = typeof toId === "string" ? rag.findPlace(toId) : toId;
    if (!from || !to) { toast("未找到起终点，无法生成路线", "err"); return null; }

    const route = rag.shortestPath(from.id, to.id);
    const nodes = route.nodes.length ? route.nodes : [from, to];
    const d = nodes.map((n, i) => (i === 0 ? "M" : "L") + n.x + " " + n.y).join(" ");

    this.gRoute.appendChild(svg("path", { class: "route-halo", d }));
    this.gRoute.appendChild(svg("path", { class: "route", d }));
    this.gRoute.appendChild(svg("circle", { class: "pin", cx: from.x, cy: from.y, r: 9 }));
    this.gRoute.appendChild(svg("circle", { class: "pin end", cx: to.x, cy: to.y, r: 11 }));
    this.routeEls = Array.from(this.gRoute.children);
    this._pulseAt(to.x, to.y);

    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const minX = Math.min(...xs) - 130, maxX = Math.max(...xs) + 130;
    const minY = Math.min(...ys) - 130, maxY = Math.max(...ys) + 130;
    const size = Math.max(Math.max(maxX - minX, 340), Math.max(maxY - minY, 340));
    this.flyTo({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: size, h: size });

    this.highlight(to.id);
    this._renderRoutePanel(from, to, route.distance || 0, nodes);
    return {
      from, to, distance: route.distance || 0,
      minutes: Math.max(1, Math.round((route.distance || 0) / 75)), nodes,
    };
  }

  _renderRoutePanel(from, to, meters, nodes) {
    if (!this.side) return;
    const open = this.rag.isOpenNow(to);
    const today = (to.hours || []).map(h => h.open + "—" + h.close).join(" / ") || "今日不开放";
    this.side.innerHTML =
      '<h4>🧭 ' + esc(from.name) + ' → ' + esc(to.name) + '</h4>' +
      '<div class="kv"><span>步行距离</span><span>' + meters + ' 米</span></div>' +
      '<div class="kv"><span>预计用时</span><span>' + Math.max(1, Math.round(meters / 75)) + ' 分钟</span></div>' +
      '<div class="kv"><span>途经节点</span><span>' + nodes.length + ' 个</span></div>' +
      '<div class="sec"><b>路径</b><div class="chips">' +
      nodes.map((n, i) => '<span class="chip' + (i === 0 || i === nodes.length - 1 ? " ok" : "") + '">' + esc(n.name) + '</span>').join("") +
      '</div></div>' +
      '<div class="sec"><b>终点实时状态</b><div class="chips">' +
      '<span class="chip ' + (open ? "ok" : "no") + '">' + (open ? "● 正在开放" : "○ 当前关闭") + '</span>' +
      '<span class="chip">' + esc(today) + '</span></div></div>' +
      '<div class="sec"><b>说明</b><div class="side-empty">' + esc(to.note || "—") + '</div></div>' +
      '<div class="sec"><button type="button" class="ghost sm" id="clearRouteBtn">清除路线</button></div>';
    const btn = $("clearRouteBtn");
    if (btn) btn.onclick = () => { this.clearRoute(); this.renderStatus(); };
  }

  clearRoute() {
    this.routeEls.forEach(n => n.remove());
    this.routeEls = [];
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; }
  }

  /* ══════════════ 选中与高亮 ══════════════ */
  highlight(placeId) {
    this.bldgNodes.forEach((rec, id) => {
      const on = id === placeId;
      rec.g.classList.toggle("hot", on);
      rec.label.classList.toggle("hot", on);
    });
  }

  select(placeId, fly) {
    const p = this.places.find(x => x.id === placeId);
    if (!p) return;
    this.highlight(placeId);
    if (fly) this.focusPlace(placeId, true);
    this._renderPlacePanel(p);
  }

  _renderPlacePanel(p) {
    if (!this.side) return;
    const rag = this.rag;
    const open = rag.isOpenNow(p);
    const day = new Date().getDay();
    const rows = (p.hours || []).map(h => {
      const days = h.days || [0, 1, 2, 3, 4, 5, 6];
      const label = days.length === 7 ? "每天" : "周" + days.map(d => "日一二三四五六"[d]).join("、");
      const isToday = days.indexOf(day) >= 0;
      return '<div class="kv"><span>' + label + (isToday ? "（今天）" : "") + '</span><span class="' +
        (isToday ? (open ? "open" : "closed") : "") + '">' + h.open + ' — ' + h.close + '</span></div>';
    }).join("") || '<div class="kv"><span>开放时间</span><span>全天</span></div>';

    const entries = rag.entries ? rag.entries() : [];
    const related = entries.filter(e => (e.entities || []).indexOf(p.entity || p.id) >= 0).slice(0, 4);

    this.side.innerHTML =
      '<h4>' + esc(p.name) + '<span class="badgeMini">' + esc(p.category) + '</span></h4>' +
      '<div class="kv"><span>当前状态</span><span class="' + (open ? "open" : "closed") + '">' +
      (open ? "● 正在开放" : "○ 已关闭") + '</span></div>' +
      rows +
      (p.note ? '<div class="sec"><b>说明</b><div class="side-empty">' + esc(p.note) + '</div></div>' : '') +
      (related.length ? '<div class="sec"><b>关联知识条目</b><div class="chips">' +
        related.map(e => '<span class="chip" title="' + esc(String(e.a).slice(0, 80)) + '">' + esc(e.q) + '</span>').join("") +
        '</div></div>' : '') +
      '<div class="sec" style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button type="button" class="ghost sm" id="navFromGate">从校门口导航到此</button>' +
      '<button type="button" class="ghost sm" id="navFromDorm">从宿舍导航到此</button>' +
      '</div>';

    const g1 = $("navFromGate"), g2 = $("navFromDorm");
    if (g1) g1.onclick = () => this.showRoute("place_gate", p.id);
    if (g2) g2.onclick = () => this.showRoute("place_dorm", p.id);
  }

  /* ══════════════ 实时状态叠加 ══════════════ */
  renderStatus() {
    if (!this.live) {
      this.bldgNodes.forEach(rec => rec.g.classList.remove("closed"));
      return;
    }
    let openCount = 0;
    this.places.forEach(p => {
      const rec = this.bldgNodes.get(p.id);
      if (!rec) return;
      const open = this.rag.isOpenNow(p);
      if (open) openCount++;
      rec.g.classList.toggle("closed", !open);
    });
    if (this.meta) {
      const d = new Date();
      this.meta.textContent = "当前时间 " + String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0") + " · " + openCount + "/" + this.places.length +
        " 处开放（暗色 = 已关闭）";
    }
  }

  /* ══════════════ 交互 ══════════════ */
  _bind() {
    const s = this.svg;

    s.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      s.classList.add("dragging");
      this.drag = { x: e.clientX, y: e.clientY, cam: Object.assign({}, this.cam) };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      const r = s.getBoundingClientRect();
      this.cam.x = this.drag.cam.x - (e.clientX - this.drag.x) / r.width * this.drag.cam.w;
      this.cam.y = this.drag.cam.y - (e.clientY - this.drag.y) / r.height * this.drag.cam.h;
      this._applyCam();
    });
    window.addEventListener("mouseup", () => {
      if (this.drag) s.classList.remove("dragging");
      this.drag = null;
    });

    s.addEventListener("wheel", (e) => {
      e.preventDefault();
      const before = this._screenToSvg(e.clientX, e.clientY);
      const k = e.deltaY > 0 ? 1.12 : 0.89;
      const nw = clamp(this.cam.w * k, 220, 2200);
      const nh = clamp(this.cam.h * k, 220, 2200);
      this.cam.x = before.x - (before.x - this.cam.x) * (nw / this.cam.w);
      this.cam.y = before.y - (before.y - this.cam.y) * (nh / this.cam.h);
      this.cam.w = nw;
      this.cam.h = nh;
      this._applyCam();
    }, { passive: false });

    const reset = $("mapReset");
    if (reset) reset.onclick = () => {
      this.clearRoute();
      this.flyTo({ x: 500, y: 500, w: 1000, h: 1000 });
      this.highlight(null);
      if (this.side) this.side.innerHTML =
        '<div class="side-empty">点击地图上的楼宇查看详情，或直接问「从宿舍到图书馆怎么走」让我演示一路导航。</div>';
    };

    const live = $("mapLive");
    if (live) live.onchange = () => { this.live = live.checked; this.renderStatus(); };
  }
}
