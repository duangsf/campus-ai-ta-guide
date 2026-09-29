/* ============================================================
 * v2 前端 · 3D 校园沙盘（Three.js）
 *
 * ── 本次重做解决了三个问题 ──
 *
 * 1. **场景不再偏离画布中心**
 *    旧实现把相机 target 固定在 (0,0,0)，但建筑坐标是 0~1000 的逻辑坐标，
 *    乘 SCALE 后实际围绕世界坐标 (50, 50) 分布 —— 于是整个校园偏在画面一侧。
 *    现在：先建完所有对象，用 Box3 求出真实包围盒，取其中心作为场景原点
 *    （整体偏移 content group），相机 target 归零；再按包围盒跨度自动计算
 *    初始距离与阴影相机范围，保证无论数据怎么变，画面都是居中的。
 *
 * 2. **建筑不再是裸方块**
 *    程序化生成建筑模型，组成要素：
 *      · 楼体：六个面分别贴图，各面窗户列数按实际面宽计算（不会被拉伸变形）
 *      · 窗户：Canvas 程序化生成，白天是玻璃反光色，夜间走 emissiveMap 自发光
 *      · 屋顶：按类型分「坡屋顶（带屋脊、出檐）」与「平屋顶（女儿墙 + 电梯机房 + 空调机组 + 水箱）」
 *      · 入口：正面带门厅、雨棚与台阶
 *      · 校门：独立建模（立柱 + 横梁 + 门匾）
 *      · 体育馆：拱形壳体屋顶
 *    全部贴图运行时用 Canvas 画出来，不加载任何外部图片，保持完全离线。
 *
 * 3. **地面有了层次**
 *    沙盘底座 + 草坪 + 硬质铺装广场（含中心绿岛与旗杆）+ 带中线的道路 + 行道树，
 *    比原来"一块深色底板 + 网格线"更接近真实校园沙盘。
 *
 * 交互：拖拽旋转 / 滚轮缩放 / 点击拾取 / 昼夜切换 / 自动环绕 /
 *      与对话联动（问到某地时相机飞过去并高亮）。
 * ============================================================ */

import { $, clamp, toast, rafThrottle } from "./util.js";

const LEVEL_HEIGHT = 3.4;      // 每层楼高（世界单位）
const SCALE = 0.1;             // 逻辑坐标(0~1000) → 世界坐标

/* 各分类的建筑参数：层数、屋顶形式、墙色、屋顶色、点缀色 */
const CATEGORY = {
  "图书馆":      { floors: 5, roof: "flat",  wall: 0xd9cfc0, roofColor: 0x8a4b3c, accent: 0xc9a227 },
  "自习室":      { floors: 1, roof: "flat",  wall: 0xe8e0d2, roofColor: 0x7d8a94, accent: 0x38bdf8 },
  "教学楼":      { floors: 5, roof: "flat",  wall: 0xdcd6cc, roofColor: 0x8a8378, accent: 0x4a7fb5 },
  "学院楼":      { floors: 5, roof: "gable", wall: 0xd6cfc2, roofColor: 0x8b4a3a, accent: 0x6b8fbf },
  "行政":        { floors: 4, roof: "flat",  wall: 0xe2d9c8, roofColor: 0x9a3b3b, accent: 0xb94a48 },
  "住宿":        { floors: 7, roof: "flat",  wall: 0xd8cfc0, roofColor: 0x8f8577, accent: 0x3f6ea8 },
  "餐饮":        { floors: 2, roof: "flat",  wall: 0xe6dcc8, roofColor: 0x8a6a3f, accent: 0xd08a2c },
  "生活服务":    { floors: 2, roof: "flat",  wall: 0xded4c4, roofColor: 0x8a7d6a, accent: 0x9a8a5c },
  "医疗":        { floors: 2, roof: "flat",  wall: 0xe8e6de, roofColor: 0x7f9a8c, accent: 0x4a9c7a },
  "艺术实践":    { floors: 4, roof: "gable", wall: 0xdad2c6, roofColor: 0x6d4b7a, accent: 0x9a6fc0 },
  "自习与活动":  { floors: 3, roof: "flat",  wall: 0xdcd5c8, roofColor: 0x7f7a86, accent: 0x5c86bd },
  "运动场馆":    { floors: 0, roof: "track", wall: 0xe4e2da, roofColor: 0xb4483a, accent: 0x3d7a45 },
  "水域":        { floors: 0, roof: "water", wall: 0x5fa2c8, roofColor: 0x2b5f83, accent: 0xe8621f },
  "交通":        { floors: 0, roof: "none",  wall: 0x9aa4ab, roofColor: 0x6f7a82, accent: 0x6f8fb0 },
  "出入口":      { floors: 0, roof: "gate",  wall: 0xbfc6cc, roofColor: 0x8a4b3c, accent: 0xc9a227 },
  "公共空间":    { floors: 0, roof: "pad",   wall: 0xc9c2b4, roofColor: 0x8a8378, accent: 0x4f7a5f },
};
const DEFAULT_CAT = { floors: 2, roof: "flat", wall: 0xd6cfc4, roofColor: 0x8a8378, accent: 0x46688c };

/** 确定性伪随机：同一建筑每次生成的细节一致，避免每次刷新外观都变 */
function rng(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ============================================================
 * 程序化贴图：建筑立面
 * 生成"墙 + 窗"贴图，并同时输出自发光贴图（夜间点亮窗户用）。
 * 用 Canvas 现画而不是加载图片：既保证离线，也让窗户数量能跟着面宽自适应。
 * ============================================================ */
function makeFacadeTextures(opt) {
  const THREE = opt.THREE;
  const cols = Math.max(2, opt.cols);
  const rows = Math.max(1, opt.rows);
  const cell = 64;                       // 每个窗格的像素尺寸
  const W = cols * cell, H = rows * cell;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  const emi = document.createElement("canvas");
  emi.width = W; emi.height = H;
  const e = emi.getContext("2d");

  const base = new THREE.Color(opt.wall);
  const hex = (c) => "#" + c.getHexString();
  const wall = hex(base);
  const dark = hex(base.clone().multiplyScalar(0.84));
  const light = hex(base.clone().multiplyScalar(1.07));

  /* 墙体：竖向渐变 + 底部勒脚，制造轻微体积感 */
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, light);
  grad.addColorStop(0.55, wall);
  grad.addColorStop(1, dark);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  /* 自发光贴图初始全黑（白天不发光） */
  e.fillStyle = "#000";
  e.fillRect(0, 0, W, H);

  const pad = cell * 0.20;
  const winW = cell - pad * 2;
  const winH = cell * 0.52;
  const rnd = rng(opt.seed || "b");

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cell + pad;
      const y = r * cell + cell * 0.26;

      /* 窗框 */
      g.fillStyle = "rgba(40,48,56,.55)";
      g.fillRect(x - 2, y - 2, winW + 4, winH + 4);

      /* 玻璃：颜色随位置轻微变化，模拟不同角度反光 */
      const gl = g.createLinearGradient(x, y, x + winW, y + winH);
      const v = 118 + Math.floor(rnd() * 46);
      gl.addColorStop(0, "rgb(" + (v + 26) + "," + (v + 40) + "," + (v + 58) + ")");
      gl.addColorStop(0.55, "rgb(" + v + "," + (v + 16) + "," + (v + 34) + ")");
      gl.addColorStop(1, "rgb(" + (v - 18) + "," + (v - 6) + "," + (v + 10) + ")");
      g.fillStyle = gl;
      g.fillRect(x, y, winW, winH);

      /* 窗中竖框与窗台 */
      g.strokeStyle = "rgba(40,48,56,.5)";
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x + winW / 2, y);
      g.lineTo(x + winW / 2, y + winH);
      g.stroke();
      g.fillStyle = "rgba(255,255,255,.22)";
      g.fillRect(x - 3, y + winH + 1, winW + 6, 3);

      /* 夜间：约 62% 的窗户亮灯（确定性随机，保证每次一致） */
      if (rnd() > 0.38) {
        e.fillStyle = rnd() > 0.25 ? "rgba(255,214,150,0.95)" : "rgba(190,220,255,0.85)";
        e.fillRect(x, y, winW, winH);
      }
    }
  }
  g.fillStyle = "rgba(60,58,54,.30)";
  g.fillRect(0, H - cell * 0.17, W, cell * 0.17);

  const map = new THREE.CanvasTexture(canvas);
  const emissiveMap = new THREE.CanvasTexture(emi);
  [map, emissiveMap].forEach(t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  });
  return { map, emissiveMap };
}

/* ============================================================
 * 程序化模型：坡屋顶（双坡 + 屋脊）
 * 手工构造棱柱几何，比方块更像建筑。
 * ============================================================ */
function makeGableRoof(THREE, w, d, h, overhang) {
  const W = w / 2 + overhang, D = d / 2 + overhang, H = h;
  const v = [
    -W, 0, -D, W, 0, -D, W, 0, D, -W, 0, D,   // 底面 0..3
    -W, H, 0, W, H, 0,                          // 屋脊 4,5
  ];
  const idx = [
    0, 4, 5, 0, 5, 1,        // 一侧坡面
    3, 2, 6, 3, 6, 7,        // 另一侧坡面（顶点顺序反向以保证法线朝外）
    1, 5, 6, 1, 6, 2,        // 侧面
    0, 3, 7, 0, 7, 4,        // 侧面
    0, 1, 2, 0, 2, 3,        // 底面封口
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  /* 打个标记便于自检：坡屋顶必须算过法线，否则光照会全黑 */
  geo.__roof = true;
  return geo;
}

/* ============================================================
 * 主类
 * ============================================================ */
export class Campus3D {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = $("globeHost");
    this.rag = window.RAG;
    this.ready = false;
    this.built = false;
    this.bldgs = new Map();
    this.hot = null;

    this.cam = { theta: Math.PI * 0.22, phi: Math.PI * 0.32, dist: 150, target: { x: 0, y: 0, z: 0 } };
    this.drag = null;
    this.auto = true;
    this.night = false;
    this.fly = null;
    this.offset = { x: 0, z: 0 };
    this.sceneRadius = 50;
    this.defaultDist = 150;
    /* 正交视角的缩放倍率：正交没有近大远小，改相机距离 dist 不会改变成像大小，
       所以"滚轮缩放"只能作用在视锥上（halfH /= zoomFactor），见 _fitDistance。 */
    this.zoomFactor = 1;

    const auto = $("globeAuto");
    if (auto) auto.onchange = () => { this.auto = auto.checked; };
    const night = $("globeNight");
    if (night) night.onchange = () => { this.night = night.checked; this._applyLighting(); };
    const reset = $("globeReset");
    if (reset) reset.onclick = () => this.reset();
    const proj = $("globeProj");
    if (proj) {
      proj.checked = this.useOrtho !== false;
      proj.onchange = () => this.setCameraMode(proj.checked ? "ortho" : "persp");
    }
  }

  /** 切换正交（沙盘）/ 透视（漫游）相机 */
  setCameraMode(mode) {
    const ortho = mode !== "persp";
    if (ortho === this.useOrtho) return;
    this.useOrtho = ortho;
    this.zoomFactor = 1;                    // 切换投影方式时同步复位缩放
    this._applyCameraMode();
    this.defaultDist = this._fitDistance(this.cam.phi);
    this.cam.dist = ortho ? this.defaultDist : this.defaultDist;
    this.zoomMin = this.defaultDist * 0.16;
    this.zoomMax = this.defaultDist * 2.4;
    const cb = $("globeProj");
    if (cb) cb.checked = ortho;
    const meta = $("globeMeta");
    if (meta) {
      meta.textContent = "沙盘 " + Math.round(this.sandboxW) + "×" + Math.round(this.sandboxD) +
        " 单位 · " + (ortho ? "正交（沙盘）视角" : "透视（漫游）视角") +
        " · 拖拽旋转 · 滚轮缩放 · 点击楼宇查看详情";
    }
    toast(ortho ? "已切换为正交沙盘视角" : "已切换为透视漫游视角", "ok");
  }

  async init() {
    if (this.ready) return true;
    if (!this.host) return false;
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) {
      this.host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-mute)">' +
        '当前浏览器/显卡不支持 WebGL，3D 沙盘不可用。<br>2.5D 交互地图仍可正常使用。</div>';
      return false;
    }
    try {
      /* 用根路径而非 "../vendor/..."：后者会向上越过 v2 目录边界，
         只是恰好被浏览器的 URL 规范化纠正回去，属于依赖巧合。
         与 index.html 里 /vendor/echarts.min.js 的写法保持一致。 */
      this.THREE = await import("/vendor/three.module.min.js");
    } catch (e) {
      console.error("[3D] Three.js 加载失败", e);
      this.host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-mute)">' +
        '3D 引擎加载失败（vendor/three.module.min.js 缺失？）</div>';
      return false;
    }
    this._setup();
    this.ready = true;
    return true;
  }

  _setup() {
    const T = this.THREE;
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;
    this.places = (this.rag.placesPayload ? this.rag.placesPayload().places : []) || [];

    this.renderer = new T.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.host.innerHTML = "";
    this.host.appendChild(this.renderer.domElement);

    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x0a1422);
    this.scene.fog = new T.Fog(0x0a1422, 190, 420);
    /* 透视相机保留为备选（切"透视视角"时使用），默认启用正交 */
    this.perspCam = new T.PerspectiveCamera(44, w / h, 0.4, 1600);
    /* ★ 双相机：透视 + 正交（等轴测）
       ------------------------------------------------------------------
       为什么默认正交：沙盘是贴在地面上的平面布局，透视投影下地平面"近大远小"，
       远侧被压向屏幕上方，导致整片建筑挤在画面下部、构图永远不可能又完整又居中
       （实测建筑群中心落在屏幕 92% 高度处，而底板中心在 50%，两者在透视下无法同时居中）。
       正交投影没有近大远小，构图天然对称 —— 这正是"沙盘/等轴测"该有的样子。
       可在工具栏切换回透视，获得更接近人眼漫游的观感。 */
    this.orthoCam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.camera = this.orthoCam;
    this.useOrtho = true;

    /* 光照：半球环境 + 主光（投影）+ 补光 */
    this.hemi = new T.HemisphereLight(0xbfd8ff, 0x1a2634, 0.85);
    this.scene.add(this.hemi);
    this.sun = new T.DirectionalLight(0xfff2dc, 1.35);
    /* 注意：主光的位置在 _centerScene 里按场景尺度设置。
       这里必须保证 this.sun.position 已存在（Three.js 的 Light 继承自 Object3D，
       构造函数会给出 position），但为了防御性编程，仍然显式创建一次 ——
       早期版本在 _centerScene 里直接调用 this.sun.position.set() 时因 position 缺失报错。 */
    if (!this.sun.position) this.sun.position = new T.Vector3(70, 120, 60);
    this.sun.position.set(70, 120, 60);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    const sc = this.sun.shadow.camera;
    sc.left = -130; sc.right = 130; sc.top = 130; sc.bottom = -130;
    sc.near = 10; sc.far = 500;
    sc.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.fill = new T.DirectionalLight(0x7fb0ff, 0.42);
    this.fill.position.set(-80, 55, -70);
    this.scene.add(this.fill);

    /* ★ 场景居中：先建完所有对象，再整体平移，使包围盒中心落在原点。
       旧实现漏了这一步，导致校园偏在画面一侧。 */
    const content = new T.Group();
    this.scene.add(content);
    this.content = content;

    this._buildTerrain(content);
    this._buildRoads(content);
    this._buildBuildings(content);
    this._buildTrees(content);
    this._centerScene(content);
    this._bindPointer();
    this._applyLighting();

    this._onResize = rafThrottle(() => {
      if (!this.host) return;
      const w2 = this.host.clientWidth, h2 = this.host.clientHeight;
      if (!w2 || !h2) return;
      this.renderer.setSize(w2, h2);
      const asp = w2 / h2;
      if (this.perspCam) { this.perspCam.aspect = asp; this.perspCam.updateProjectionMatrix(); }
      if (this.orthoCam) {
        this.orthoCam.aspect = asp;
        this.orthoCam.updateProjectionMatrix();
      }
      /* 宽高比变了要重算视锥/取景距离，保证沙盘仍完整居中 */
      this._applyCameraMode();
      /* 宽高比变了，重新计算"完整入画"的距离；
         若当前正处于默认视角（用户没缩放过），同步跟随，保证沙盘始终完整居中。 */
      const wasDefault = Math.abs(this.cam.dist - this.defaultDist) < 0.5;
      this.defaultDist = this._fitDistance(this.cam.phi);
      this.zoomMin = this.defaultDist * 0.16;
      this.zoomMax = this.defaultDist * 2.4;
      if (wasDefault) this.cam.dist = this.defaultDist;
    });
    window.addEventListener("resize", this._onResize);
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this._onResize);
      this.ro.observe(this.host);
    }
    this._animate();

    const cnt = $("globeCount");
    if (cnt) cnt.textContent = String(this.bldgs.size);
  }

  /* ══════════════ 地面：按校园边界自动生成的沙盘底座 ══════════════
     关键设计：沙盘底板**不再是一个固定的大方块**，而是按 data/places.json 里
     所有场所的实际外接矩形 + 一圈小边距（约 45 米）生成。
     原因：早先底板固定为 1050×1050，而校园内容只占 876×814，
     四周留出一大圈空绿（就是"空沙盘"），既占画面又显得空旷；
     现在底板紧贴校园边界，空地基本消除，校园在画面里也更饱满。
     校园东西向比南北向长，底板因此是略扁的矩形 —— 这正好更适配 16:9 画布。 */
  _buildTerrain(parent) {
    const T = this.THREE;
    /* 按实际内容算外接矩形（逻辑坐标） */
    const rects = this.places.map(p => p.rect).filter(Boolean);
    const bx1 = Math.min(...rects.map(r => r.x));
    const bx2 = Math.max(...rects.map(r => r.x + r.w));
    const bz1 = Math.min(...rects.map(r => r.y));
    const bz2 = Math.max(...rects.map(r => r.y + r.h));
    const MARGIN_M = 45;                      // 校园边界外留的绿化/道路边距
    const x1 = bx1 - MARGIN_M, x2 = bx2 + MARGIN_M;
    const z1 = bz1 - MARGIN_M, z2 = bz2 + MARGIN_M;
    this.contentBounds = { x1: bx1, x2: bx2, z1: bz1, z2: bz2 };
    this.plateBounds = { x1, x2, z1, z2 };
    /* 世界单位尺寸 */
    this.sandboxW = (x2 - x1) * SCALE;
    this.sandboxD = (z2 - z1) * SCALE;
    /* 兼容旧字段（取景逻辑用它们） */
    this.sandboxSize = Math.max(this.sandboxW, this.sandboxD);
    this.sandboxHalf = this.sandboxSize / 2;

    const cx = (x1 + x2) / 2 * SCALE;
    const cz = (z1 + z2) / 2 * SCALE;

    /* 底座：深色台面，略比草坪外扩，形成一圈"沙盘边" */
    const base = new T.Mesh(
      new T.BoxGeometry(this.sandboxW + 1.6, 2.4, this.sandboxD + 1.6),
      new T.MeshStandardMaterial({ color: 0x141f2d, roughness: .96, metalness: .04 })
    );
    /* ★ 底座顶面必须比草坪顶面低一点（这里低 0.12）。
       早先两者顶面都落在 y=0（base -1.2+2.4/2、lawn -0.45+0.9/2）—— 完全共面即 z-fighting：
       不透明物体按"前→后"排序绘制，草坪先画、底座后画，而 depthFunc 是 LessEqual，
       深度相等时后画的底座仍然通过，于是**整片草坪被深蓝黑底座盖住**，
       远看就是一整块黑影（旁边的田径场依旧是绿的，可见并非光照问题）。
       0.12 远大于正交深度精度（near 0.1 / far 2000 下约 1e-4），稳定消除覆盖与闪烁。 */
    base.position.set(cx, -1.32, cz);
    base.receiveShadow = true;
    parent.add(base);

    /* 草坪面：与底座同级，收进 0.8 形成边缘线 */
    const lawn = new T.Mesh(
      new T.BoxGeometry(this.sandboxW, 0.9, this.sandboxD),
      new T.MeshStandardMaterial({ color: 0x2e4834, roughness: 1 })
    );
    lawn.position.set(cx, -0.45, cz);
    lawn.receiveShadow = true;
    parent.add(lawn);

    /* 中心广场：圆形铺装 + 绿岛 + 旗杆，给画面一个视觉焦点。
       位置直接取 data 里广场矩形的中心，避免与布局脱节。 */
    const plaza = this.places.find(p => p.id === "place_plaza");
    const px = (plaza ? plaza.x : 411) * SCALE;
    const pz = (plaza ? plaza.y : 795) * SCALE;
    const pr = plaza ? Math.min(plaza.rect.w, plaza.rect.h) * SCALE * 0.46 : 3.4;
    const round = new T.Mesh(
      new T.CylinderGeometry(pr, pr, 0.18, 44),
      new T.MeshStandardMaterial({ color: 0x7d8288, roughness: .9 })
    );
    round.position.set(px, 0.03, pz);
    round.receiveShadow = true;
    parent.add(round);

    const island = new T.Mesh(new T.CylinderGeometry(pr * 0.38, pr * 0.38, 0.5, 30),
      new T.MeshStandardMaterial({ color: 0x3d5c40, roughness: 1 }));
    island.position.set(px, 0.25, pz);
    island.receiveShadow = true;
    parent.add(island);

    const pole = new T.Mesh(new T.CylinderGeometry(0.16, 0.16, 9, 10),
      new T.MeshStandardMaterial({ color: 0xd8dde2, metalness: .7, roughness: .35 }));
    pole.position.set(px, 4.7, pz);
    pole.castShadow = true;
    parent.add(pole);
  }

  /* ══════════════ 道路：路面 + 中线虚线 ══════════════ */
  _buildRoads(parent) {
    const T = this.THREE;
    const byId = new Map(this.places.map(p => [p.id, p]));
    const LINKS = [
      ["place_gate", "place_plaza"], ["place_plaza", "place_market"],
      ["place_gate", "place_canteen"], ["place_canteen", "place_admin_office"],
      ["place_plaza", "place_sports"], ["place_sports", "place_clinic"],
      ["place_market", "place_express"], ["place_express", "place_clinic"],
      ["place_admin_office", "place_dorm"], ["place_dorm", "place_activity_center"],
      ["place_activity_center", "lake_fountain"], ["lake_fountain", "library_huatonglou"],
      ["library_huatonglou", "place_study_a113"], ["library_huatonglou", "building_a"],
      ["building_a", "place_print"], ["place_print", "lake_campus"],
      ["place_activity_center", "building_journalism"], ["building_journalism", "building_film"],
      ["building_film", "place_rehearsal"], ["place_rehearsal", "building_music_hall"],
      ["building_b", "place_studio"], ["place_studio", "lake_campus"],
      ["place_dorm", "place_bathhouse"], ["place_dorm", "place_canteen"],
    ];
    const roadMat = new T.MeshStandardMaterial({ color: 0x585d63, roughness: .95 });
    const lineMat = new T.MeshBasicMaterial({ color: 0xcfd6dc, transparent: true, opacity: .36 });

    LINKS.forEach(([a, b]) => {
      const pa = byId.get(a), pb = byId.get(b);
      if (!pa || !pb) return;
      const ax = pa.x * SCALE, az = pa.y * SCALE;
      const bx = pb.x * SCALE, bz = pb.y * SCALE;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) return;
      const ang = -Math.atan2(dz, dx);

      const road = new T.Mesh(new T.BoxGeometry(len, 0.2, 3.4), roadMat);
      road.position.set(ax + dx / 2, 0.06, az + dz / 2);
      road.rotation.y = ang;
      road.receiveShadow = true;
      parent.add(road);

      const seg = 2.2;
      const count = Math.max(1, Math.floor(len / (seg * 2)));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const dash = new T.Mesh(new T.BoxGeometry(seg, 0.02, 0.22), lineMat);
        dash.position.set(ax + dx * t, 0.17, az + dz * t);
        dash.rotation.y = ang;
        parent.add(dash);
      }
    });
  }

  /* ══════════════ 建筑 ══════════════ */
  _buildBuildings(parent) {
    const T = this.THREE;

    this.places.forEach(p => {
      const cat = CATEGORY[p.category] || DEFAULT_CAT;
      const r = p.rect || { x: p.x - 45, y: p.y - 35, w: 90, h: 70 };
      const bw = Math.max(3.2, r.w * SCALE * 0.92);
      const bd = Math.max(3.2, r.h * SCALE * 0.92);
      const floors = cat.floors;
      const bh = floors > 0 ? floors * LEVEL_HEIGHT : 1.1;

      const group = new T.Group();
      group.position.set(p.x * SCALE, 0, p.y * SCALE);

      if (cat.roof === "gate") group.add(this._makeGate(T, cat));
      else if (cat.roof === "none") group.add(this._makePad(T, bw, bd, cat, false));
      else if (cat.roof === "pad") group.add(this._makePad(T, bw, bd, cat, true));
      else if (cat.roof === "track") group.add(this._makeStadium(T, p, bw, bd));
      else if (cat.roof === "water") group.add(this._makeWater(T, p, bw, bd));
      else if (cat.roof === "shell") group.add(this._makeShellHall(T, bw, bd));
      else group.add(this._makeBlock(T, p, cat, bw, bd, bh, floors));

      const labelY = Math.max(bh + (cat.roof === "gable" ? 7.2 : 3.6), 4.2);
      const label = this._makeLabel(p.name);
      label.position.y = labelY;
      group.add(label);

      parent.add(group);

      const pickables = [];
      group.traverse(o => { if (o.isMesh) { o.userData.owner = p.id; pickables.push(o); } });
      this.bldgs.set(p.id, { group, pickables, label, place: p, bh });
    });
  }

  /** 普通楼体：分段贴图墙面 + 屋顶 + 入口 */
  _makeBlock(T, p, cat, bw, bd, bh, floors) {
    const g = new T.Group();

    /* 窗户列数按实际面宽算，保证窗格是方的、不被拉伸 */
    const colsX = Math.max(3, Math.round(bw / 2.0));
    const colsZ = Math.max(3, Math.round(bd / 2.0));
    const front = makeFacadeTextures({ THREE: T, cols: colsX, rows: floors, wall: cat.wall, seed: p.id + "f" });
    const side = makeFacadeTextures({ THREE: T, cols: colsZ, rows: floors, wall: cat.wall, seed: p.id + "s" });

    const mkMat = (tex) => new T.MeshStandardMaterial({
      map: tex.map, emissiveMap: tex.emissiveMap,
      emissive: new T.Color(0xffffff), emissiveIntensity: 0,
      color: 0xffffff, roughness: .78, metalness: .05,
    });
    const mSideX = mkMat(side);
    const mSideZ = mkMat(front);
    const mTop = new T.MeshStandardMaterial({ color: new T.Color(cat.wall).multiplyScalar(.96), roughness: .9 });

    /* BoxGeometry 材质顺序：+X, -X, +Y, -Y, +Z, -Z */
    const body = new T.Mesh(new T.BoxGeometry(bw, bh, bd), [mSideX, mSideX, mTop, mTop, mSideZ, mSideZ]);
    body.position.y = bh / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    /* 记录可变材质，供高亮与夜间自发光控制使用 */
    g.userData.bodyMats = [mSideX, mSideZ];

    /* 楼体棱线：强化体量感 */
    const edges = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(bw, bh, bd)),
      new T.LineBasicMaterial({ color: 0x2a3542, transparent: true, opacity: .32 })
    );
    edges.position.y = bh / 2;
    g.add(edges);

    /* ── 屋顶 ── */
    if (cat.roof === "gable") {
      const rh = Math.max(2.2, Math.min(bw, bd) * 0.26);
      const roof = new T.Mesh(
        makeGableRoof(T, bw, bd, rh, 0.7),
        new T.MeshStandardMaterial({ color: cat.roofColor, roughness: .82, metalness: .06 })
      );
      roof.position.y = bh;
      roof.castShadow = true;
      g.add(roof);
      const ridge = new T.Mesh(
        new T.BoxGeometry(bw + 1.6, 0.24, 0.36),
        new T.MeshStandardMaterial({ color: new T.Color(cat.roofColor).multiplyScalar(1.18), roughness: .7 })
      );
      ridge.position.y = bh + rh;
      ridge.castShadow = true;
      g.add(ridge);
    } else {
      /* 平屋顶：楼板 + 女儿墙 + 屋顶设备 */
      const slab = new T.Mesh(
        new T.BoxGeometry(bw + 0.5, 0.3, bd + 0.5),
        new T.MeshStandardMaterial({ color: new T.Color(cat.wall).multiplyScalar(.9), roughness: .92 })
      );
      slab.position.y = bh + 0.15;
      slab.castShadow = true;
      slab.receiveShadow = true;
      g.add(slab);

      const paraMat = new T.MeshStandardMaterial({ color: cat.roofColor, roughness: .86 });
      const ph = 0.85, pt = 0.28;
      [[0, bd / 2 - pt / 2, bw, pt], [0, -(bd / 2 - pt / 2), bw, pt],
      [bw / 2 - pt / 2, 0, pt, bd], [-(bw / 2 - pt / 2), 0, pt, bd]].forEach(([px, pz, pw, pd]) => {
        const wall = new T.Mesh(new T.BoxGeometry(pw, ph, pd), paraMat);
        wall.position.set(px, bh + 0.3 + ph / 2, pz);
        wall.castShadow = true;
        g.add(wall);
      });

      /* 屋顶设备：电梯机房 / 空调机组 / 水箱（确定性摆放，每次一致） */
      const rnd = rng(p.id + "roof");
      const boxMat = new T.MeshStandardMaterial({ color: 0xa9b0b6, roughness: .7, metalness: .25 });
      if (bw > 6 && bd > 6) {
        const room = new T.Mesh(new T.BoxGeometry(Math.min(3.4, bw * .28), 2.0, Math.min(3.0, bd * .28)), boxMat);
        room.position.set(-bw * .22, bh + 1.3, -bd * .22);
        room.castShadow = true;
        g.add(room);
      }
      for (let i = 0; i < 3; i++) {
        if (rnd() > 0.5) continue;
        const ac = new T.Mesh(new T.BoxGeometry(1.5, 0.9, 1.1), boxMat);
        ac.position.set((rnd() - .5) * bw * .6, bh + 0.75, (rnd() - .5) * bd * .6);
        ac.castShadow = true;
        g.add(ac);
      }
      if (rnd() > 0.55) {
        const tank = new T.Mesh(new T.CylinderGeometry(1.0, 1.0, 1.7, 16),
          new T.MeshStandardMaterial({ color: 0xc8ccd0, roughness: .55, metalness: .35 }));
        tank.position.set(bw * .24, bh + 1.15, bd * .22);
        tank.castShadow = true;
        g.add(tank);
      }
    }

    /* ── 入口：门厅 + 雨棚 + 台阶（只给多层建筑做） ── */
    if (floors >= 2) {
      const doorW = Math.min(bw * 0.34, 4.2);
      const lobby = new T.Mesh(
        new T.BoxGeometry(doorW, 2.3, 1.1),
        new T.MeshStandardMaterial({ color: new T.Color(cat.accent).multiplyScalar(.85), roughness: .6, metalness: .15 })
      );
      lobby.position.set(0, 1.15, bd / 2 + 0.5);
      lobby.castShadow = true;
      g.add(lobby);

      const canopy = new T.Mesh(
        new T.BoxGeometry(doorW + 1.6, 0.24, 2.0),
        new T.MeshStandardMaterial({ color: new T.Color(cat.roofColor).multiplyScalar(1.05), roughness: .8 })
      );
      canopy.position.set(0, 2.75, bd / 2 + 1.0);
      canopy.castShadow = true;
      g.add(canopy);

      const stepMat = new T.MeshStandardMaterial({ color: 0x9aa0a6, roughness: .95 });
      for (let i = 0; i < 2; i++) {
        const st = new T.Mesh(new T.BoxGeometry(doorW + 2.2 - i * 0.4, 0.26, 1.5 - i * 0.3), stepMat);
        st.position.set(0, 0.13 + i * 0.26, bd / 2 + 1.4 - i * 0.2);
        st.receiveShadow = true;
        g.add(st);
      }
    }
    return g;
  }

  /**
   * 田径场：红色环形塑胶跑道 + 中央绿色足球场 + 西侧看台。
   * 造型依据学校官方图集实拍（红色跑道、绿色人工草、红白座椅看台）。
   */
  _makeStadium(T, p, bw, bd) {
    const g = new T.Group();

    /* 场地基座 */
    const pad = new T.Mesh(
      new T.BoxGeometry(bw, 0.2, bd),
      new T.MeshStandardMaterial({ color: 0x8f6a58, roughness: .98 })
    );
    pad.position.y = 0.1;
    pad.receiveShadow = true;
    g.add(pad);

    /* 跑道：用大半径圆柱压扁做环形，外圈略低于内圈形成跑道面 */
    const trackGeo = new T.CylinderGeometry(1, 1, 0.16, 48);
    const track = new T.Mesh(trackGeo, new T.MeshStandardMaterial({ color: 0xb4483a, roughness: .92 }));
    track.scale.set(bw / 2 * 0.98, 1, bd / 2 * 0.98);
    track.position.y = 0.22;
    track.receiveShadow = true;
    g.add(track);

    /* 内场草皮：略高于跑道，让"跑道包住球场"的层次清楚 */
    const field = new T.Mesh(
      new T.BoxGeometry(bw * 0.62, 0.22, bd * 0.62),
      new T.MeshStandardMaterial({ color: 0x3d7a45, roughness: .95 })
    );
    field.position.y = 0.32;
    field.receiveShadow = true;
    g.add(field);

    /* 球场白线：中圈 + 中线 + 两侧禁区（用细长条表达） */
    const lineMat = new T.MeshBasicMaterial({ color: 0xf2f5f7, transparent: true, opacity: .55 });
    const mid = new T.Mesh(new T.BoxGeometry(0.4, 0.04, bd * 0.62), lineMat);
    mid.position.y = 0.45;
    g.add(mid);
    const circle = new T.Mesh(new T.TorusGeometry(bw * 0.09, 0.12, 6, 32), lineMat);
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = 0.45;
    g.add(circle);
    [-1, 1].forEach(sgn => {
      const box = new T.Mesh(new T.BoxGeometry(bw * 0.14, 0.04, bd * 0.06), lineMat);
      box.position.set(sgn * bw * 0.24, 0.45, 0);
      g.add(box);
    });

    /* 西侧看台：四级台阶 + 顶棚，朝向场地 */
    const standMat = new T.MeshStandardMaterial({ color: 0x9c4436, roughness: .88 });
    const seatMat = new T.MeshStandardMaterial({ color: 0xd8d2c8, roughness: .9 });
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const h = 0.9 + i * 0.85;
      const step = new T.Mesh(new T.BoxGeometry(1.5, h, bd * 0.66), standMat);
      step.position.set(-bw / 2 - 0.9 - i * 1.5, h / 2, 0);
      step.castShadow = true;
      step.receiveShadow = true;
      g.add(step);
      /* 座椅面 */
      const seat = new T.Mesh(new T.BoxGeometry(1.5, 0.14, bd * 0.66), seatMat);
      seat.position.set(-bw / 2 - 0.9 - i * 1.5, h + 0.07, 0);
      g.add(seat);
    }
    const roof = new T.Mesh(
      new T.BoxGeometry(7.6, 0.3, bd * 0.72),
      new T.MeshStandardMaterial({ color: 0x6f757c, roughness: .7, metalness: .25 })
    );
    roof.position.set(-bw / 2 - 3.2, 5.4, 0);
    roof.castShadow = true;
    g.add(roof);
    /* 顶棚支柱 */
    [0.7, -0.7].forEach(k => {
      const col = new T.Mesh(new T.CylinderGeometry(0.16, 0.16, 5.4, 8),
        new T.MeshStandardMaterial({ color: 0xaeb4b9, roughness: .6, metalness: .3 }));
      col.position.set(-bw / 2 - 0.4, 2.7, bd * 0.33 * k);
      col.castShadow = true;
      g.add(col);
    });

    /* 球门：两根门柱 + 横梁（两端各一个） */
    const goalMat = new T.MeshStandardMaterial({ color: 0xf4f6f8, roughness: .5, metalness: .2 });
    [-1, 1].forEach(sgn => {
      const gx = sgn * bw * 0.29;
      [-1, 1].forEach(zz => {
        const post = new T.Mesh(new T.CylinderGeometry(0.11, 0.11, 1.7, 8), goalMat);
        post.position.set(gx, 1.15, zz * bd * 0.10);
        post.castShadow = true;
        g.add(post);
      });
      const bar = new T.Mesh(new T.CylinderGeometry(0.11, 0.11, bd * 0.20, 8), goalMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(gx, 2.0, 0);
      g.add(bar);
    });

    return g;
  }

  /**
   * 水域：湖面 + 蜿蜒曲桥（夜景航拍里那串发光曲线就是它）。
   * 水面用半透明蓝色平面 + 轻微起伏的环形波纹表达。
   */
  _makeWater(T, p, bw, bd) {
    const g = new T.Group();
    if (p.shape === "fountain") {
      /* 喷泉广场：方形水池 + 中央橙色环形雕塑 + 铺装 */
      const pave = new T.Mesh(new T.BoxGeometry(bw, 0.18, bd),
        new T.MeshStandardMaterial({ color: 0x6d747b, roughness: .95 }));
      pave.position.y = 0.09;
      pave.receiveShadow = true;
      g.add(pave);

      const pool = new T.Mesh(new T.BoxGeometry(bw * 0.64, 0.3, bd * 0.48),
        new T.MeshStandardMaterial({ color: 0x2f6f96, roughness: .25, metalness: .35, transparent: true, opacity: .88 }));
      pool.position.y = 0.22;
      g.add(pool);

      /* 标志性橙色环形雕塑 */
      const R = Math.min(bw * 0.64, bd * 0.48) * 0.40;
      const ring = new T.Mesh(
        new T.TorusGeometry(R, R * 0.11, 12, 40),
        new T.MeshStandardMaterial({ color: 0xe8621f, roughness: .45, metalness: .3 })
      );
      ring.position.y = 0.3 + R;
      ring.castShadow = true;
      g.add(ring);
      /* 底座 */
      const base = new T.Mesh(new T.BoxGeometry(2.4, 0.5, 2.4),
        new T.MeshStandardMaterial({ color: 0x3b4249, roughness: .8 }));
      base.position.y = 0.55;
      base.castShadow = true;
      g.add(base);
      return g;
    }

    /* 湖面：略低于地面，形成"下沉水面"的观感 */
    const shore = new T.Mesh(new T.BoxGeometry(bw * 1.04, 0.22, bd * 1.04),
      new T.MeshStandardMaterial({ color: 0x4a5a4e, roughness: 1 }));
    shore.position.y = 0.11;
    shore.receiveShadow = true;
    g.add(shore);

    const water = new T.Mesh(
      new T.BoxGeometry(bw, 0.3, bd),
      new T.MeshStandardMaterial({ color: 0x2f6f96, roughness: .16, metalness: .45, transparent: true, opacity: .9 })
    );
    water.position.y = 0.16;
    g.add(water);

    /* 水岸亮边 */
    const rim = new T.Mesh(new T.BoxGeometry(bw * 1.02, 0.1, bd * 1.02),
      new T.MeshStandardMaterial({ color: 0xbfc9c0, roughness: .9 }));
    rim.position.y = 0.22;
    g.add(rim);

    /* 曲桥：沿一条平滑曲线拼接若干桥段，模拟蜿蜒栈道 */
    const curve = new T.CatmullRomCurve3([
      new T.Vector3(-bw * 0.46, 0.6, bd * 0.30),
      new T.Vector3(-bw * 0.18, 0.6, bd * 0.02),
      new T.Vector3(bw * 0.08, 0.6, -bd * 0.20),
      new T.Vector3(bw * 0.46, 0.6, -bd * 0.28),
    ]);
    const segs = 22;
    const deckMat = new T.MeshStandardMaterial({ color: 0xd9c9a8, roughness: .85 });
    const railMat = new T.MeshStandardMaterial({ color: 0xf2e6c8, roughness: .6, emissive: new T.Color(0x3a2c10), emissiveIntensity: .6 });
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const pt = curve.getPoint(i / segs);
      if (prev) {
        const dx = pt.x - prev.x, dz = pt.z - prev.z;
        const len = Math.hypot(dx, dz);
        const deck = new T.Mesh(new T.BoxGeometry(len * 1.1, 0.16, 1.5), deckMat);
        deck.position.set((pt.x + prev.x) / 2, 0.6, (pt.z + prev.z) / 2);
        deck.rotation.y = -Math.atan2(dz, dx);
        deck.castShadow = true;
        g.add(deck);
        /* 两侧灯带：夜间点亮，对应照片里的发光桥 */
        [0.85, -0.85].forEach(off => {
          const rail = new T.Mesh(new T.BoxGeometry(len * 1.1, 0.12, 0.16), railMat);
          rail.position.set((pt.x + prev.x) / 2, 0.78, (pt.z + prev.z) / 2);
          rail.rotation.y = -Math.atan2(dz, dx);
          rail.translateZ(off);
          g.add(rail);
        });
      }
      prev = pt;
    }
    return g;
  }

  /** 体育馆：矩形裙房 + 拱形壳体屋顶 */
  _makeShellHall(T, bw, bd) {
    const g = new T.Group();
    const wallH = 3.0;
    const body = new T.Mesh(new T.BoxGeometry(bw, wallH, bd),
      new T.MeshStandardMaterial({ color: 0xe4e2da, roughness: .85 }));
    body.position.y = wallH / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const dome = new T.Mesh(
      new T.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new T.MeshStandardMaterial({ color: 0x5f8f7a, roughness: .6, metalness: .18 })
    );
    dome.scale.set(bw / 2, Math.min(bw, bd) * 0.24, bd / 2);
    dome.position.y = wallH;
    dome.castShadow = true;
    g.add(dome);
    return g;
  }

  /**
   * 金色大门：学校形象地标。
   * 造型取自官方图集实拍 —— 一块巨大金色曲面拱门横跨入口，
   * 左侧低矮着地、向右扬起成尖角，门下可通行，右侧立校名牌。
   */
  _makeGate(T, cat) {
    const g = new T.Group();
    const goldMat = new T.MeshStandardMaterial({
      color: 0xe0b93c, metalness: .75, roughness: .28,
      emissive: new T.Color(0x3a2c06), emissiveIntensity: .35,
    });

    /* 主体：用一段被压扁并旋转的环面模拟"上扬的曲面板" */
    const arc = new T.Mesh(new T.TorusGeometry(7.6, 2.3, 16, 48, Math.PI * 0.92), goldMat);
    arc.rotation.z = Math.PI * 0.06;
    arc.scale.set(1, 1, 0.26);          // 压扁成板状
    arc.position.set(0, 3.2, 0);
    arc.castShadow = true;
    g.add(arc);

    /* 板面高光条：顺着弧线贴一层窄环，模拟金属反光带 */
    const shine = new T.Mesh(
      new T.TorusGeometry(8.9, 0.42, 8, 40, Math.PI * 0.62),
      new T.MeshStandardMaterial({ color: 0xffe9a6, metalness: .5, roughness: .2, emissive: new T.Color(0x554010), emissiveIntensity: .5 })
    );
    shine.rotation.z = Math.PI * 0.14;
    shine.scale.set(1, 1, 0.20);
    shine.position.set(0.3, 3.4, 0.35);
    g.add(shine);

    /* 落地支座：左端着地的厚墩 */
    const footing = new T.Mesh(new T.BoxGeometry(3.4, 2.6, 3.6), goldMat);
    footing.position.set(-7.4, 1.3, 0);
    footing.castShadow = true;
    g.add(footing);

    /* 校名牌：门内右侧的白色横牌 */
    const plate = new T.Mesh(
      new T.BoxGeometry(9.6, 1.5, 0.4),
      new T.MeshStandardMaterial({ color: 0xf7fafc, roughness: .5 })
    );
    plate.position.set(7.6, 1.5, 0.4);
    plate.castShadow = true;
    g.add(plate);
    const plateBase = new T.Mesh(new T.BoxGeometry(10.2, 0.5, 1.2),
      new T.MeshStandardMaterial({ color: 0xb9c0c6, roughness: .8 }));
    plateBase.position.set(7.6, 0.55, 0.4);
    g.add(plateBase);

    /* 门禁栅栏：几根浅色立柱 */
    const barMat = new T.MeshStandardMaterial({ color: 0xcdd5dc, metalness: .5, roughness: .4 });
    for (let i = 0; i < 9; i++) {
      const bar = new T.Mesh(new T.CylinderGeometry(0.13, 0.13, 2.6, 8), barMat);
      bar.position.set(-4.6 + i * 1.15, 1.3, 0);
      g.add(bar);
    }
    return g;
  }

  /** 软性场所的地坪（广场 / 停车场）：铺装 + 可选球场色块，避免出现突兀空地 */
  _makePad(T, bw, bd, cat, withCourt) {
    const g = new T.Group();
    const pad = new T.Mesh(
      new T.BoxGeometry(bw, 0.16, bd),
      new T.MeshStandardMaterial({ color: new T.Color(cat.wall).multiplyScalar(.55), roughness: 1 })
    );
    pad.position.y = 0.08;
    pad.receiveShadow = true;
    g.add(pad);

    if (withCourt && bw > 8) {
      const court = new T.Mesh(
        new T.BoxGeometry(bw * .7, 0.06, bd * .5),
        new T.MeshStandardMaterial({ color: 0x2f6b48, roughness: .95 })
      );
      court.position.y = 0.18;
      court.receiveShadow = true;
      g.add(court);
    }
    return g;
  }

  /* ══════════════ 绿化 ══════════════ */
  _buildTrees(parent) {
    const T = this.THREE;
    /* 共享几何与材质：几十棵树也只有两份资源，性能友好 */
    const trunkGeo = new T.CylinderGeometry(0.22, 0.3, 2.2, 7);
    const trunkMat = new T.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 });
    const crownGeo = new T.SphereGeometry(1.5, 10, 8);
    const crownMatA = new T.MeshStandardMaterial({ color: 0x3f7a48, roughness: .95 });
    const crownMatB = new T.MeshStandardMaterial({ color: 0x4f8b52, roughness: .95 });

    const rnd = rng("trees");
    this.places.forEach(p => {
      if (["公共空间", "出入口", "交通", "水域", "运动场馆"].indexOf(p.category) >= 0) return;
      const count = 3 + Math.floor(rnd() * 4);
      const r = p.rect || { x: p.x - 45, y: p.y - 35, w: 90, h: 70 };
      /* 树要种在楼体之外的绿地里：以矩形为基准向外留 6 米再随机散布，
         否则会长到楼里面去（旧版就出现过大树穿楼的情况）。 */
      for (let i = 0; i < count; i++) {
        const ang = rnd() * Math.PI * 2;
        const dist = (Math.max(r.w, r.h) / 2 + 6) * SCALE * (1.0 + rnd() * 0.55);
        const x = p.x * SCALE + Math.cos(ang) * dist;
        const z = p.y * SCALE + Math.sin(ang) * dist;
        /* 校区逻辑坐标范围约 0~1000，转换后为 0~100 */
        if (x < 2 || x > 98 || z < 2 || z > 98) continue;
        const s = 0.7 + rnd() * 0.55;

        const tree = new T.Group();
        const trunk = new T.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 1.1 * s;
        trunk.castShadow = true;
        tree.add(trunk);
        const crown = new T.Mesh(crownGeo, rnd() > .5 ? crownMatA : crownMatB);
        crown.scale.set(s, s * (0.85 + rnd() * .3), s);
        crown.position.y = 3.4 * s;
        crown.castShadow = true;
        tree.add(crown);
        tree.position.set(x, 0, z);
        parent.add(tree);
      }
    });
  }

  /* ══════════════ ★ 场景居中与自动取景 ══════════════ */
  _centerScene(content) {
    const T = this.THREE;
    /* 用 Box3 求出全部内容（建筑 + 道路 + 树木 + 地面）的真实包围盒，
       把中心平移到原点 —— 这一步修掉了"校园偏在画布一角"的问题。 */
    const box = new T.Box3().setFromObject(content);
    const center = box.getCenter(new T.Vector3());
    content.position.x -= center.x;
    content.position.z -= center.z;
    this.offset = { x: -center.x, z: -center.z };

    const contentSize = box.getSize(new T.Vector3());
    const span = Math.max(this.sandboxSize || 0, contentSize.x, contentSize.z);
    this.sceneRadius = span / 2;

    if (!this.cam) this.cam = { theta: Math.PI * 0.22, phi: Math.PI * 0.32, dist: 150, target: { x: 0, y: 0, z: 0 } };
    this.cam.target.x = 0;
    this.cam.target.z = 0;

    /* ★ 居中：相机目标对准"沙盘底板的中心"
       ------------------------------------------------------------------
       透视/正交相机的 target 都是**投影到画面正中心的世界点**，
       所以只要 target = 沙盘中心，沙盘就必然居中。
       注意：沙盘是按校园边界生成的矩形，中心不一定在世界原点，必须按 plateBounds 算。 */
    const L = this.plateBounds || { x1: 0, x2: 1000, z1: 0, z2: 1000 };
    this.plateCenter = {
      x: (L.x1 + L.x2) / 2 * SCALE,
      y: 0,
      z: (L.z1 + L.z2) / 2 * SCALE,
    };
    this.cam.target.x = this.plateCenter.x;
    this.cam.target.y = 0;
    this.cam.target.z = this.plateCenter.z;
    this.contentTop = Math.max(4, contentSize.y);   // 建筑最高点，取景时要一并纳入
    /* 取景与居中统一由 _applyCameraMode 完成：
       正交模式下它会额外做一次"投影包络中心 → 画面中心"的平移校正 */
    this._applyCameraMode();

    /* 主光与阴影相机跟随场景尺度，避免阴影范围不匹配导致漏影 */
    this.sun.position.set(this.sceneRadius * .8, this.sceneRadius * 1.5, this.sceneRadius * .7);
    const sc = this.sun.shadow.camera;
    const e = this.sceneRadius * 1.15;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
    sc.far = this.sceneRadius * 6;
    sc.updateProjectionMatrix();

    const meta = $("globeMeta");
    if (meta) {
      meta.textContent = "沙盘 " + Math.round(this.sandboxW) + "×" + Math.round(this.sandboxD) +
        " 单位 · 拖拽旋转 · 滚轮缩放 · 点击楼宇查看详情";
    }
  }

  /**
   * 计算"沙盘完整入画"所需的相机距离（透视/正交通用）。
   *
   * 目标点固定为沙盘中心，所以沙盘中心必然投影到画面正中。
   * 取景要覆盖的范围 = 沙盘四角 + 建筑最高点（沙盘是矩形，不是正方形）：
   *   · 正交：视锥是盒子，直接按"投影后的屏幕范围"反算 halfHeight，无需迭代
   *   · 透视：按最远角点迭代放大距离
   */
  _plateCorners() {
    const L = this.plateBounds;
    if (!L) {
      const h = (this.sandboxSize || 100) / 2;
      return [[-h, -h], [h, -h], [-h, h], [h, h]];
    }
    const cx = (L.x1 + L.x2) / 2 * SCALE, cz = (L.z1 + L.z2) / 2 * SCALE;
    const hw = (L.x2 - L.x1) / 2 * SCALE, hd = (L.z2 - L.z1) / 2 * SCALE;
    return [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx - hw, cz + hd], [cx + hw, cz + hd]];
  }

  _fitDistance(phi) {
    const aspect = this.camera.aspect || (this.orthoCam ? this.orthoCam.aspect : 1) || 1;
    const theta = this.cam ? this.cam.theta : 0;
    const ty = (this.cam && this.cam.target) ? this.cam.target.y : 0;
    const top = this.contentTop || 5;
    /* 余量：正交不会畸变，可以贴得很满；透视近角会被拉大，留多一点 */
    const MARGIN = this.useOrtho ? 0.99 : 0.90;
    const corners = this._plateCorners();

    /* eye = target + dir*d，朝向 target */
    const txx = (this.plateCenter ? this.plateCenter.x : 0);
    const tzz = (this.plateCenter ? this.plateCenter.z : 0);
    const dirOf = (d) => {
      /* eye = target + dir*d（target 是沙盘中心，可能不在原点） */
      const eye = {
        x: txx + Math.sin(phi) * Math.cos(theta) * d,
        y: ty + Math.cos(phi) * d,
        z: tzz + Math.sin(phi) * Math.sin(theta) * d,
      };
      const L = Math.hypot(eye.x - txx, eye.y - ty, eye.z - tzz) || 1;
      const fwd = { x: (txx - eye.x) / L, y: (ty - eye.y) / L, z: (tzz - eye.z) / L };
      const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const nrm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
      const right = nrm(cross(fwd, { x: 0, y: 1, z: 0 }));
      return { eye, fwd, right, up: cross(right, fwd) };
    };

    /* 正交：算出所有点相对沙盘中心的屏幕范围，反解 halfHeight。
       正交下沿视线方向的深度不影响成像大小，所以一次求解即可，无需迭代。

       ★ 两遍法（这里踩过坑）：
       地平面上的矩形在斜视角下会投影成**非对称四边形** —— 远端两点与近端两点
       沿相机竖直轴的位置不同（实测左侧两角 NDC 相同、右侧两角却是 0.474/-0.095）。
       如果只把 target 放在沙盘几何中心，投影包络就会整体偏上或偏下。
       因此：第一遍先按包络撑满视锥，第二遍按"包络中心与画面中心的偏移"反向移动 target，
       使四角投影严格对称居中。 */
    if (this.useOrtho) {
      const t0 = this.plateCenter || { x: 0, z: 0 };
      const measure = (tx, ty, tz) => {
        const b = dirOf(1);
        let maxU = 0, maxV = 0, minU = Infinity, maxU2 = -Infinity, minV = Infinity, maxV2 = -Infinity;
        const consider = (x, y, z) => {
          const v = { x: x - tx, y: y - ty, z: z - tz };
          const u = v.x * b.right.x + v.y * b.right.y + v.z * b.right.z;
          const vv = v.x * b.up.x + v.y * b.up.y + v.z * b.up.z;
          maxU = Math.max(maxU, Math.abs(u)); maxV = Math.max(maxV, Math.abs(vv));
          minU = Math.min(minU, u); maxU2 = Math.max(maxU2, u);
          minV = Math.min(minV, vv); maxV2 = Math.max(maxV2, vv);
        };
        corners.forEach(([cx, cz]) => { consider(cx, 0, cz); consider(cx, top, cz); });
        return { maxU, maxV, cu: (minU + maxU2) / 2, cv: (minV + maxV2) / 2 };
      };

      let m = measure(t0.x, ty, t0.z);
      const halfH0 = Math.max(m.maxV, m.maxU / aspect) / MARGIN;
      /* 第二遍：把包络中心推回画面中心（正交是仿射变换，平移 target 即平移成像） */
      const b = dirOf(1);
      const t1 = {
        x: t0.x + m.cu * b.right.x + m.cv * b.up.x,
        y: ty + m.cu * b.right.y + m.cv * b.up.y,
        z: t0.z + m.cu * b.right.z + m.cv * b.up.z,
      };
      const m2 = measure(t1.x, t1.y, t1.z);
      const halfH = Math.max(m2.maxV, m2.maxU / aspect) / MARGIN;
      const ratio = halfH0 > 0 ? halfH / halfH0 : 1;
      this.orthoHalfH = halfH;
      if (Math.abs(ratio - 1) > 0.01 || Math.abs(m2.cu) > 0.01 || Math.abs(m2.cv) > 0.01) {
        this._orthoAdjust = { target: t1, halfH };
      } else {
        this._orthoAdjust = { target: t1, halfH };
      }
      /* ★ 正交缩放落在这里：halfH 是"完整入画"的基准高度，再除以滚轮倍率。
         每帧都按 zoomFactor 重算，所以窗口尺寸变化（_onResize → _applyCameraMode）
         不会把用户的缩放丢掉。 */
      const zf = this.zoomFactor || 1;
      const hh = halfH / zf;
      if (this.orthoCam) {
        this.orthoCam.left = -hh * aspect;
        this.orthoCam.right = hh * aspect;
        this.orthoCam.top = hh;
        this.orthoCam.bottom = -hh;
        this.orthoCam.updateProjectionMatrix();
      }
      return (this.sandboxSize || 100) * 1.6;
    }

    /* 透视：按最远角点迭代放大距离 */
    const tanV = Math.tan(this.camera.fov * Math.PI / 360);
    const tanH = tanV * aspect;
    const worstNdc = (d) => {
      const b = dirOf(d);
      let worst = 0;
      const consider = (x, y, z) => {
        const v = { x: x - b.eye.x, y: y - b.eye.y, z: z - b.eye.z };
        const depth = v.x * b.fwd.x + v.y * b.fwd.y + v.z * b.fwd.z;
        if (depth <= 0.01) { worst = 99; return; }
        const nx = (v.x * b.right.x + v.y * b.right.y + v.z * b.right.z) / (depth * tanH);
        const ny = (v.x * b.up.x + v.y * b.up.y + v.z * b.up.z) / (depth * tanV);
        worst = Math.max(worst, Math.abs(nx), Math.abs(ny));
      };
      corners.forEach(([cx, cz]) => { consider(cx, 0, cz); consider(cx, top, cz); });
      return worst;
    };
    let d = (this.sandboxSize || 100) * Math.SQRT2 / Math.min(tanV, tanH) * 0.6;
    for (let i = 0; i < 8; i++) {
      const w = worstNdc(d);
      if (!isFinite(w) || w <= 0) break;
      const next = d * (w / MARGIN);
      if (Math.abs(next - d) < 0.05) { d = next; break; }
      d = next;
    }
    return d;
  }

  /** 把当前模式的相机同步到 cam 状态（正交要重算视锥，透视用 aspect + 重解距离） */
  _applyCameraMode() {
    const host = this.host || {};
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    const aspect = (w && h) ? w / h : 1;
    if (this.useOrtho && this.orthoCam) {
      this.camera = this.orthoCam;
      this.orthoCam.aspect = aspect;
      this.defaultDist = this._fitDistance(this.cam.phi);
      this._applyOrthoAdjust();
      this.cam.dist = this.defaultDist;
      if (this.orthoCam.updateProjectionMatrix) this.orthoCam.updateProjectionMatrix();
    } else if (this.perspCam) {
      this.camera = this.perspCam;
      this.perspCam.aspect = aspect;
      this.perspCam.updateProjectionMatrix();
      /* 切回透视时把目标还原到沙盘几何中心（正交会为了居中而平移它） */
      const c = this.plateCenter || { x: 0, z: 0 };
      this.cam.target.x = c.x;
      this.cam.target.y = 0;
      this.cam.target.z = c.z;
      this.defaultDist = this._fitDistance(this.cam.phi);
      this.cam.dist = this.defaultDist;
    }
    this.zoomMin = this.defaultDist * 0.16;
    this.zoomMax = this.defaultDist * 2.4;
  }

  /** 应用正交取景算出的"平移校正"：把投影包络中心推回画面中心 */
  _applyOrthoAdjust() {
    const adj = this._orthoAdjust;
    if (!adj || !adj.target) return;
    this.cam.target.x = adj.target.x;
    this.cam.target.y = adj.target.y;
    this.cam.target.z = adj.target.z;
    const L = this.plateBounds;
    if (L) {
      this.plateCenterProjected = {
        x: (L.x1 + L.x2) / 2 * SCALE,
        y: 0,
        z: (L.z1 + L.z2) / 2 * SCALE,
      };
    }
  }

  /* ══════════════ 楼名标签 ══════════════ */
  _makeLabel(text) {
    const T = this.THREE;
    const pad = 14, font = 32;
    const c = document.createElement("canvas");
    let g = c.getContext("2d");
    g.font = "600 " + font + "px 'PingFang SC','Microsoft YaHei',sans-serif";
    const tw = g.measureText(text).width;
    c.width = Math.ceil(tw + pad * 2);
    c.height = Math.ceil(font + pad * 1.4);
    g = c.getContext("2d");
    g.font = "600 " + font + "px 'PingFang SC','Microsoft YaHei',sans-serif";
    g.fillStyle = "rgba(10,20,34,.84)";
    const rr = 12;
    g.beginPath();
    g.moveTo(rr, 0); g.lineTo(c.width - rr, 0); g.quadraticCurveTo(c.width, 0, c.width, rr);
    g.lineTo(c.width, c.height - rr); g.quadraticCurveTo(c.width, c.height, c.width - rr, c.height);
    g.lineTo(rr, c.height); g.quadraticCurveTo(0, c.height, 0, c.height - rr);
    g.lineTo(0, rr); g.quadraticCurveTo(0, 0, rr, 0);
    g.fill();
    g.strokeStyle = "rgba(120,180,240,.38)";
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = "#dbe9f8";
    g.textBaseline = "middle";
    g.fillText(text, pad, c.height / 2 + 1);

    const tex = new T.CanvasTexture(c);
    tex.minFilter = T.LinearFilter;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(c.width * 0.052, c.height * 0.052, 1);
    return sp;
  }

  /* ══════════════ 昼夜光照 ══════════════ */
  _applyLighting() {
    if (!this.ready) return;
    const night = this.night;
    this.hemi.intensity = night ? 0.26 : 0.85;
    this.hemi.color = new this.THREE.Color(night ? 0x3a4c66 : 0xbfd8ff);
    this.sun.intensity = night ? 0.14 : 1.35;
    this.fill.intensity = night ? 0.32 : 0.42;

    const bg = new this.THREE.Color(night ? 0x050b14 : 0x0a1422);
    this.scene.background = bg;
    this.scene.fog.color = bg;
    this.scene.fog.near = night ? 150 : 190;
    this.scene.fog.far = night ? 340 : 420;

    /* 夜间点亮窗户靠贴图的 emissiveMap，白天把强度归零 */
    this.bldgs.forEach(rec => {
      const mats = rec.group.userData.bodyMats || [];
      mats.forEach(m => { m.emissiveIntensity = night ? 1.15 : 0; m.needsUpdate = true; });
      if (this.hot !== rec.place.id) this._restoreColor(rec);
    });
  }

  _restoreColor(rec) {
    (rec.group.userData.bodyMats || []).forEach(m => m.color.set(0xffffff));
  }

  /* ══════════════ 交互 ══════════════ */
  _bindPointer() {
    const dom = this.renderer.domElement;
    dom.style.cursor = "grab";
    dom.addEventListener("mousedown", (e) => {
      this.drag = { x: e.clientX, y: e.clientY, theta: this.cam.theta, phi: this.cam.phi };
      dom.style.cursor = "grabbing";
      this.auto = false;
      const cb = $("globeAuto");
      if (cb) cb.checked = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      this.cam.theta = this.drag.theta - (e.clientX - this.drag.x) * 0.006;
      this.cam.phi = clamp(this.drag.phi - (e.clientY - this.drag.y) * 0.005, 0.12, Math.PI * 0.47);
    });
    window.addEventListener("mouseup", () => {
      this.drag = null;
      if (this.renderer) this.renderer.domElement.style.cursor = "grab";
    });
    dom.addEventListener("wheel", (e) => {
      e.preventDefault();
      /* 正交（默认的"沙盘视角"）：必须改视锥，改 dist 没有任何视觉效果。
         上下限与透视保持一致（0.16x ~ 2.4x），避免两种模式手感不同。 */
      if (this.useOrtho && this.orthoCam) {
        this.zoomFactor = clamp((this.zoomFactor || 1) * (e.deltaY > 0 ? 0.91 : 1.1), 0.16, 2.4);
        this._applyCameraMode();
        return;
      }
      /* 缩放上下限按"完整入画距离"换算，不再与场景半径挂钩：
         这样无论窗口多大，最多缩到 2.4 倍取景距离、最近可推进到 0.16 倍。 */
      const lo = this.zoomMin || this.defaultDist * 0.16;
      const hi = this.zoomMax || this.defaultDist * 2.4;
      this.cam.dist = clamp(this.cam.dist * (e.deltaY > 0 ? 1.1 : 0.91), lo, hi);
    }, { passive: false });

    const ray = new this.THREE.Raycaster();
    const ndc = new this.THREE.Vector2();
    dom.addEventListener("click", (e) => {
      const r = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, this.camera);
      const all = [];
      this.bldgs.forEach(rec => all.push(...rec.pickables));
      const hit = ray.intersectObjects(all, false)[0];
      if (!hit || !hit.object.userData.owner) return;
      const id = hit.object.userData.owner;
      this.highlight(id);
      this.flyToPlace(id, true);
      /* 镜头对准楼层中部而不是地面，视觉上更聚焦 */
      const rec = this.bldgs.get(id);
      if (rec && this.fly) this.fly.ty = rec.bh * 0.45;
      if (this.ctx.onPickPlace) this.ctx.onPickPlace(id);
    });
  }

  _updateCamera() {
    if (this.auto && !this.drag) this.cam.theta += 0.0014;
    if (this.fly) {
      const k = 0.085;
      this.cam.theta += (this.fly.theta - this.cam.theta) * k;
      this.cam.phi += (this.fly.phi - this.cam.phi) * k;
      this.cam.dist += (this.fly.dist - this.cam.dist) * k;
      this.cam.target.x += (this.fly.tx - this.cam.target.x) * k;
      this.cam.target.y += (this.fly.ty - this.cam.target.y) * k;
      this.cam.target.z += (this.fly.tz - this.cam.target.z) * k;
      if (Math.abs(this.fly.dist - this.cam.dist) < 0.5) this.fly = null;
    }
    const { theta, phi, dist, target } = this.cam;
    this.camera.position.set(
      target.x + Math.sin(phi) * Math.cos(theta) * dist,
      target.y + Math.cos(phi) * dist,
      target.z + Math.sin(phi) * Math.sin(theta) * dist
    );
    this.camera.lookAt(target.x, target.y, target.z);
  }

  _animate() {
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._updateCamera();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  highlight(id) {
    if (this.hot && this.bldgs.get(this.hot)) this._restoreColor(this.bldgs.get(this.hot));
    this.hot = id;
    const rec = id ? this.bldgs.get(id) : null;
    if (!rec) return;
    (rec.group.userData.bodyMats || []).forEach(m => m.color.set(0x8fd4ff));
  }

  /** 逻辑坐标 → 世界坐标（含居中偏移），供镜头飞行使用 */
  _toWorld(x, y) {
    return { x: x * SCALE + this.offset.x, z: y * SCALE + this.offset.z };
  }

  flyToPlace(id, zoom) {
    const p = this.places.find(x => x.id === id);
    if (!p || !this.ready) return;
    const w = this._toWorld(p.x, p.y);
    const rec = this.bldgs.get(id);
    this.fly = {
      tx: w.x, tz: w.z,
      ty: rec ? rec.bh * 0.4 : 1.5,
      theta: this.cam.theta,
      phi: clamp(this.cam.phi, 0.22, 0.44),
      dist: zoom ? this.sceneRadius * 0.6 : this.cam.dist,
    };
  }

  reset() {
    this.cam.theta = Math.PI * 0.22;
    this.cam.phi = Math.PI * 0.32;
    this.zoomFactor = 1;                    // 复位＝回到"完整入画"
    /* 复位＝回到"沙盘完整居中入画"：目标对准沙盘中心（矩形沙盘中心可能不在原点） */
    const c = this.plateCenter || { x: 0, z: 0 };
    this.cam.target.x = c.x;
    this.cam.target.y = 0;
    this.cam.target.z = c.z;
    this._applyCameraMode();
    this.fly = null;
    this.highlight(null);
    const a = $("globeAuto");
    if (a) { a.checked = true; this.auto = true; }
  }

  /** 与对话联动：问到某地时自动定位 */
  focusPlace(id) {
    if (!this.ready) this.init().then(ok => { if (ok) this.focusPlace(id); });
    else { this.highlight(id); this.flyToPlace(id, true); }
  }

  show() {
    this.built = true;
    /* init() 是异步的（要动态 import three.js），首次进入本视图时下面那个 60ms 定时器
       往往早于 _setup() 执行，此时 _onResize 还不存在，校正就被静默跳过，
       画布于是停在 _setup() 里 `|| 600` 的兜底高度上。所以 init 完成后再校正一次。 */
    if (!this.ready) this.init().then(ok => { if (ok && this._onResize) this._onResize(); });
    setTimeout(() => this._onResize && this._onResize(), 60);
  }
}
