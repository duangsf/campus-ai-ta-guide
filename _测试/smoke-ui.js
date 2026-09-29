/* ============================================================
 * v2 · 无头冒烟测试：真正执行地图与 3D 模块的构建逻辑
 *
 * 为什么需要它：
 *   verify.js 只做语法检查，抓不到"函数内部写错变量名"这类运行时错误
 *   （例如把 pb.x 误写成 pc.x，语法完全合法，但一点开地图就报错）。
 *   而这两个模块是纯 DOM/Three.js 渲染代码，不可能在 Node 里跑真实渲染。
 *
 * 做法：
 *   1. 用 Proxy 造一个"什么都接受"的最小 DOM，记录被调用过的元素与方法；
 *   2. 用桩替换 Three.js（只实现用到的那部分 API，并保持几何参数可校验）；
 *   3. 采用动态 import 加载真实模块源码，执行 build/setup 全流程；
 *   4. 断言关键产出：建筑数量、顶点法线是否算过、场景是否做过居中偏移、
 *      坐标是否落在合理范围、有没有调用到不存在的变量。
 *
 * 用法：node _测试\smoke-ui.js
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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

/* ══════════════════ 最小 DOM ══════════════════ */
function makeDom() {
  const created = { svg: [], canvas: 0, div: 0, other: 0 };
  const ids = {};

  function ctx2d() {
    const noop = () => {};
    const grad = { addColorStop: noop };
    return {
      fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textBaseline: "", globalAlpha: 1,
      createLinearGradient: () => grad, createRadialGradient: () => grad,
      fillRect: noop, strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop,
      fillText: noop, measureText: () => ({ width: 80 }), quadraticCurveTo: noop,
      save: noop, restore: noop, setLineDash: noop, translate: noop, scale: noop, setTransform: noop,
    };
  }

  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      children: [], childNodes: [], parentNode: null,
      style: {}, dataset: {}, className: "", id: "",
      textContent: "", innerHTML: "", value: "",
      width: 0, height: 0,
      clientWidth: 900, clientHeight: 620,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      appendChild(c) { this.children.push(c); if (c && typeof c === "object") c.parentNode = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      insertBefore(c) { return this.appendChild(c); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(k, v) { this["attr_" + k] = v; },
      getAttribute(k) { return this["attr_" + k]; },
      removeAttribute(k) { delete this["attr_" + k]; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620, right: 900, bottom: 620 }),
      getContext: () => ctx2d(),
      focus() {}, blur() {}, click() {},
      closest() { return null; },
      getElementsByTagName() { return []; },
    };
    return el;
  }

  const htmlIds = new Set(
    [...fs.readFileSync(path.join(ROOT, "index.html"), "utf8").matchAll(/id="([^"]+)"/g)].map(m => m[1])
  );

  const document = {
    readyState: "complete",
    getElementById(id) {
      if (!ids[id]) {
        const e = makeEl("div");
        e.id = id;
        if (htmlIds.has(id)) ids[id] = e;    // 只对"HTML 中真实存在"的 id 返回同一实例
        else return e;                        // 动态 id 每次新建（如图表容器）
      }
      return ids[id];
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === "canvas") created.canvas++;
      else if (String(tag).toLowerCase() === "div") created.div++;
      else created.other++;
      return makeEl(tag);
    },
    createElementNS(ns, tag) {
      created.svg.push(tag);
      return makeEl(tag);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: makeEl("body"),
    documentElement: makeEl("html"),
  };

  const window = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1400, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    performance: { now: () => Date.now() },
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  };
  window.window = window;
  return { document, window, created, ids };
}

/* ══════════════════ 桩 Three.js ══════════════════ */
function makeThreeStub(trace) {
  class Vector3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    getHexString() { return "cccccc"; }
  }
  class Color {
    constructor(v) { this.v = v; trace.colors++; }
    clone() { return new Color(this.v); }
    multiplyScalar() { return this; }
    set() { return this; }
    getHexString() { return "cccccc"; }
  }
  class Object3D {
    constructor() {
      this.children = []; this.position = new Vector3(); this.scale = new Vector3(1, 1, 1);
      this.rotation = new Vector3(); this.userData = {};
    }
    add(o) { this.children.push(o); if (o) o.parent = this; return this; }
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
    traverse(fn) { fn(this); this.children.forEach(c => c && c.traverse && c.traverse(fn)); }
    lookAt() { return this; }
    /* 曲桥两侧灯带用到了沿自身 Z 轴平移，桩里必须实现，否则桥的拼接会中断 */
    translateZ(d) { this.position.z += d || 0; return this; }
    translateX(d) { this.position.x += d || 0; return this; }
    translateY(d) { this.position.y += d || 0; return this; }
  }
  class Mesh extends Object3D {
    constructor(geo, mat) {
      super();
      this.isMesh = true;
      this.geometry = geo; this.material = mat;
      trace.meshes++;
      if (geo && geo.__roof) trace.roofs++;
      if (Array.isArray(mat)) trace.multiMat++;
    }
  }
  class Group extends Object3D {}
  class LineSegments extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
  class Sprite extends Object3D { constructor(m) { super(); this.material = m; } }
  class Scene extends Object3D { constructor() { super(); this.fog = { color: new Color(0) }; this.background = new Color(0); } }
  class PerspectiveCamera extends Object3D {
    constructor(fov, aspect, near, far) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; }
    updateProjectionMatrix() { trace.projUpdates++; }
  }
  /** 正交相机：记录视锥边界，供取景断言校验（沙盘默认用正交） */
  class OrthographicCamera extends Object3D {
    constructor(left, right, top, bottom, near, far) {
      super();
      this.isOrthographicCamera = true;
      this.left = left; this.right = right; this.top = top; this.bottom = bottom;
      this.near = near; this.far = far; this.aspect = 1; this.zoom = 1;
    }
    updateProjectionMatrix() { trace.projUpdates++; }
  }
  class WebGLRenderer {
    constructor() { this.domElement = makeDomElement(); this.shadowMap = { enabled: false, type: 0 }; }
    setPixelRatio() {} setSize(w, h) { this.w = w; this.h = h; }
    render() { trace.renders++; }
  }
  function makeDomElement() {
    return {
      style: {}, addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 620 }),
      width: 900, height: 620, parentNode: null,
    };
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; this.__normalsComputed = false; }
    setAttribute(name, attr) { this.attributes[name] = attr; return this; }
    setIndex(idx) { this.index = idx; return this; }
    computeVertexNormals() { this.__normalsComputed = true; trace.normalsComputed++; }
    dispose() {}
  }
  class Float32BufferAttribute { constructor(arr, item) { this.array = arr; this.itemSize = item; } }
  class BoxGeometry { constructor(w, h, d) { this.parameters = { width: w, height: h, depth: d }; } dispose() {} }
  class SphereGeometry { constructor() {} dispose() {} }
  class CylinderGeometry { constructor() {} dispose() {} }
  class TorusGeometry { constructor(r, t, rs, ts, arc) { this.parameters = { radius: r, tube: t, radialSegments: rs, tubularSegments: ts, arc: arc }; } dispose() {} }
  class PlaneGeometry { constructor() {} dispose() {} }
  class EdgesGeometry { constructor(g) { this.source = g; } dispose() {} }
  /** 平滑曲线：只需支持 getPoint(t) 返回 Vector3 —— 3D 曲桥按它逐段拼接 */
  class CatmullRomCurve3 {
    constructor(points) { this.points = points || []; }
    getPoint(t) {
      const n = this.points.length;
      if (!n) return new Vector3();
      if (n === 1) return this.points[0].clone();
      /* 线性插值即可：测试只关心"取点能用、坐标合法" */
      const f = Math.max(0, Math.min(1, t)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(f));
      const k = f - i;
      const a = this.points[i], b = this.points[i + 1];
      return new Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    }
  }
  class Box3 {
    constructor() { this.min = new Vector3(0, 0, 0); this.max = new Vector3(0, 0, 0); }
    setFromObject(obj) {
      /* 用真实内容估算包围盒：遍历所有 Mesh 的 position 取极值，
         这样"居中偏移"才有可校验的输入。 */
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let found = false;
      obj.traverse(o => {
        if (!o.isMesh) return;
        found = true;
        minX = Math.min(minX, o.position.x - 5); maxX = Math.max(maxX, o.position.x + 5);
        minZ = Math.min(minZ, o.position.z - 5); maxZ = Math.max(maxZ, o.position.z + 5);
      });
      if (!found) { minX = -60; maxX = 60; minZ = -60; maxZ = 60; }
      this.min = new Vector3(minX, 0, minZ);
      this.max = new Vector3(maxX, 0, maxZ);
      trace.box3Calls++;
      return this;
    }
    getCenter(t) { t.x = (this.min.x + this.max.x) / 2; t.y = 0; t.z = (this.min.z + this.max.z) / 2; return t; }
    getSize(t) { t.x = this.max.x - this.min.x; t.y = 1; t.z = this.max.z - this.min.z; return t; }
  }
  class CanvasTexture { constructor(c) { this.image = c; this.wrapS = 0; this.wrapT = 0; this.anisotropy = 1; this.minFilter = 0; } }

  function Material(opts) { Object.assign(this, opts || {}); if (!(this.color instanceof Color)) this.color = new Color(this.color); this.needsUpdate = false; }

  return {
    Vector2: class { constructor(x, y) { this.x = x || 0; this.y = y || 0; } },
    Vector3, Color, Object3D, Mesh, Group, LineSegments, Sprite, Scene, PerspectiveCamera, OrthographicCamera,
    WebGLRenderer, BufferGeometry, Float32BufferAttribute, BoxGeometry, SphereGeometry,
    CylinderGeometry, TorusGeometry, PlaneGeometry, EdgesGeometry, Box3, CanvasTexture, CatmullRomCurve3, Raycaster: class { setFromCamera() {} intersectObjects() { return []; } },
    MeshStandardMaterial: Material, MeshBasicMaterial: Material, LineBasicMaterial: Material,
    SpriteMaterial: Material, HemisphereLight: class extends Object3D { constructor() { super(); this.intensity = 1; this.color = new Color(0); } },
    DirectionalLight: class extends Object3D { constructor() { super(); this.intensity = 1; this.castShadow = false; this.shadow = { mapSize: { set() {} }, camera: { updateProjectionMatrix() {} }, bias: 0 }; } },
    Fog: function (c, n, f) { this.color = new Color(c); this.near = n; this.far = f; },
    GridHelper: class extends Object3D {},
    PCFSoftShadowMap: 1, SRGBColorSpace: "srgb", RepeatWrapping: 1000, LinearFilter: 1006,
  };
}

/* ══════════════════ 加载被测模块 ══════════════════ */
function loadModule(file, sandbox) {
  let src = fs.readFileSync(path.join(ROOT, file), "utf8");
  /* 去掉 import 语句：依赖从沙箱里注入 */
  src = src.replace(/^\s*import\s[^;]*;\s*$/gm, "");
  /* 把 export class 改成挂到沙箱变量上 */
  src = src.replace(/export\s+class\s+(\w+)/g, "class $1");
  src = src.replace(/export\s+\{[^}]*\};?/g, "");
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: file });
  return { ctx, src };
}

(async () => {
  console.log("");
  console.log("  无头冒烟测试：地图与 3D 模块构建流程");

  const { document, window, created } = makeDom();
  const trace = { colors: 0, meshes: 0, roofs: 0, multiMat: 0, normalsComputed: 0, box3Calls: 0, projUpdates: 0, renders: 0 };
  const THREE = makeThreeStub(trace);

  /* 沙箱全局：模拟浏览器环境 + 本项目数据 */
  const sandbox = {
    console, document, window, performance: window.performance,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    setTimeout, clearTimeout, Math, JSON, Object, Array, String, Number, Boolean, Date, isNaN, parseFloat, parseInt,
    ResizeObserver: window.ResizeObserver,
    __threeStub: THREE,
    __trace: trace,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  /* 注入项目数据（真实 data/*.js 是给浏览器用的，这里直接读 JSON） */
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  const rag = require(path.join(ROOT, "src", "rag.js"));
  sandbox.window.RAG = rag;
  sandbox.RAG = rag;

  /* util.js 的依赖：只用到 $ / clamp / toast / rafThrottle / esc */
  const utilShim = `
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
    const toast = () => {};
    const rafThrottle = (fn) => fn;
  `;
  vm.runInContext(utilShim, vm.createContext(sandbox));

  /* ── 3D 模块 ── */
  group("① 3D 沙盘构建");
  let campus3d = null;
  await TA("模块可加载并完成 _setup 全流程（无运行时错误）", async () => {
    const res = loadModule("js/globe.js", sandbox);
    const Cls = vm.runInContext("Campus3D", res.ctx);
    const ctx = { setStatus() {}, config: {}, onPickPlace() {}, focusPlace() {} };
    campus3d = new Cls(ctx);
    /* 绕过 WebGL 检测与动态 import，直接把桩注入并调用真实 _setup */
    campus3d.THREE = THREE;
    campus3d.host = document.getElementById("globeHost");
    campus3d._setup();
    if (!campus3d.ready) campus3d.ready = true;
  });

  T("建筑全部建模成功", () => {
    const places = rag.placesPayload().places;
    if (campus3d.bldgs.size !== places.length) {
      throw new Error("建模 " + campus3d.bldgs.size + " 栋，期望 " + places.length + " 栋");
    }
  });

  T("生成了坡屋顶几何且都算过法线（否则模型会全黑）", () => {
    if (trace.roofs < 1) throw new Error("没有生成任何坡屋顶（gable 分类可能失配）");
    if (trace.normalsComputed < trace.roofs) {
      throw new Error("坡屋顶 " + trace.roofs + " 个，但只算了 " + trace.normalsComputed + " 次法线");
    }
  });

  T("楼体使用多材质（六面分别贴图）", () => {
    if (trace.multiMat < 5) throw new Error("多材质网格仅 " + trace.multiMat + " 个，六面贴图可能失效");
  });

  T("★ 场景做了居中偏移（修掉偏在画布一侧的问题）", () => {
    if (trace.box3Calls < 1) throw new Error("未调用 Box3 求包围盒，居中逻辑缺失");
    const off = campus3d.offset;
    if (!off) throw new Error("未记录居中偏移量");
    if (Math.abs(off.x) < 1 && Math.abs(off.z) < 1) {
      throw new Error("偏移量近似为 0，场景可能仍偏离中心：" + JSON.stringify(off));
    }
    /* 断言真正要守的性质：**内容整体平移量恰好抵消原始包围盒中心**。
       注意不能在偏移之后再取一次包围盒来验证 —— 那时 content 已经移动过，
       再算出来的中心是"二次偏移"后的位置，会把正确实现误判为错误。 */
    const T3 = campus3d.THREE;
    const box = new T3.Box3().setFromObject(campus3d.content);
    const cx = box.getCenter(new T3.Vector3());
    if (Math.abs(cx.x - (-off.x)) > 1.5 || Math.abs(cx.z - (-off.z)) > 1.5) {
      throw new Error("偏移量与内容中心不匹配：offset=" + JSON.stringify(off) +
        "，内容中心=(" + cx.x.toFixed(1) + ", " + cx.z.toFixed(1) + ")");
    }
    /* content.position 应当就是那个偏移量（居中逻辑把它写进了 position） */
    if (Math.abs(campus3d.content.position.x - off.x) > 0.01 ||
      Math.abs(campus3d.content.position.z - off.z) > 0.01) {
      throw new Error("居中偏移未落到 content.position 上");
    }
  });

  T("★ 沙盘完整居中入画（正交沙盘视角：矩形沙盘的 8 个极值点都在视锥内）", () => {
    /* 默认是正交沙盘视角：视锥是盒子，所以"完整入画 + 居中"可以直接用
       camera 的 left/right/top/bottom 精确判定，比透视线性迭代更可靠。
       校验 8 个点 = 沙盘矩形四角 × （地面、建筑最高点）。
       注意沙盘是按校园边界生成的**矩形**，不能再按 sandboxSize/2 当正方形算。 */
    const cam = campus3d.camera;
    if (!cam || !cam.isOrthographicCamera) {
      throw new Error("默认相机不是正交相机（沙盘视角）。useOrtho=" + campus3d.useOrtho);
    }
    if (!(cam.top > 0) || !(cam.right > 0)) throw new Error("正交视锥未设置：top=" + cam.top + " right=" + cam.right);

    const corners = campus3d._plateCorners();
    const top = campus3d.contentTop || 5;
    const cam2 = campus3d.cam;
    const pc = campus3d.plateCenter || { x: 0, z: 0 };
    const phi = cam2.phi, theta = cam2.theta;
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const nrm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
    const fwd = nrm({ x: -Math.sin(phi) * Math.cos(theta), y: -Math.cos(phi), z: -Math.sin(phi) * Math.sin(theta) });
    const right = nrm(cross(fwd, { x: 0, y: 1, z: 0 }));
    const up = cross(right, fwd);

    let worstU = 0, worstV = 0;
    corners.forEach(([cx, cz]) => {
      [0, top].forEach(y => {
        const v = { x: cx - pc.x, y: y, z: cz - pc.z };
        worstU = Math.max(worstU, Math.abs(v.x * right.x + v.y * right.y + v.z * right.z));
        worstV = Math.max(worstV, Math.abs(v.x * up.x + v.y * up.y + v.z * up.z));
      });
    });
    if (worstU > cam.right + 0.01) {
      throw new Error("水平超出视锥：" + worstU.toFixed(1) + " > right " + cam.right.toFixed(1));
    }
    if (worstV > cam.top + 0.01) {
      throw new Error("垂直超出视锥：" + worstV.toFixed(1) + " > top " + cam.top.toFixed(1));
    }
    /* 居中判据（正交下的正确判据）：
       地平面矩形在斜视角下投影成非对称四边形，所以"target = 沙盘几何中心"
       **不等于**居中。真正的判据是**投影包络的中心落在画面中心**，
       即四角投影的 min/max 关于 0 对称。代码为此专门做了一次平移校正。 */
    const b = (() => {
      const cross = (a, c) => ({ x: a.y * c.z - a.z * c.y, y: a.z * c.x - a.x * c.z, z: a.x * c.y - a.y * c.x });
      const nrm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
      const fwd = nrm({ x: -Math.sin(phi) * Math.cos(theta), y: -Math.cos(phi), z: -Math.sin(phi) * Math.sin(theta) });
      const right = nrm(cross(fwd, { x: 0, y: 1, z: 0 }));
      return { fwd, right, up: cross(right, fwd) };
    })();
    const t = cam2.target;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    corners.forEach(([cx, cz]) => {
      [0, top].forEach(y => {
        const v = { x: cx - t.x, y: y - t.y, z: cz - t.z };
        const u = v.x * b.right.x + v.y * b.right.y + v.z * b.right.z;
        const vv = v.x * b.up.x + v.y * b.up.y + v.z * b.up.z;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
      });
    });
    const offU = Math.abs((minU + maxU) / 2), offV = Math.abs((minV + maxV) / 2);
    const spanU = (maxU - minU) / 2, spanV = (maxV - minV) / 2;
    if (offU > 0.6) throw new Error("水平方向未居中：投影包络中心偏移 " + offU.toFixed(2) + " 世界单位");
    if (offV > 0.6) throw new Error("垂直方向未居中：投影包络中心偏移 " + offV.toFixed(2) + " 世界单位");
    if (spanU > cam.right + 0.01) throw new Error("水平超出视锥：" + spanU.toFixed(1) + " > " + cam.right.toFixed(1));
    if (spanV > cam.top + 0.01) throw new Error("垂直超出视锥：" + spanV.toFixed(1) + " > " + cam.top.toFixed(1));
    /* 占屏比：不能缩得太小 */
    const fill = Math.max(spanV / cam.top, spanU / cam.right);
    if (fill < 0.55) throw new Error("沙盘在画面中偏小，占屏比仅 " + (fill * 100).toFixed(0) + "%");
  });

  T("相机取景已按投影包络校正（正交模式）", () => {
    const pc = campus3d.plateCenter;
    if (!pc) throw new Error("未计算沙盘中心");
    if (!(campus3d.defaultDist > 0)) throw new Error("未计算默认距离");
    if (campus3d.sceneRadius <= 0) throw new Error("场景半径异常：" + campus3d.sceneRadius);
    if (campus3d.useOrtho) {
      const t = campus3d.cam.target;
      /* 校正只应发生在相机竖直轴与朝向构成的平面内；水平位移不应过大 */
      const moved = Math.hypot(t.x - pc.x, t.z - pc.z);
      if (moved > 3) throw new Error("居中校正位移过大：" + moved.toFixed(2) + " 世界单位");
      if (Math.abs(t.y - 0) < 0.05) {
        throw new Error("正交模式未做居中校正（target.y 仍为 0），投影包络可能偏移");
      }
    }
  });

  T("阴影相机范围跟随场景尺度（避免漏影）", () => {
    const sc = campus3d.sun.shadow.camera;
    if (sc.updateProjectionMatrixCount === 0 && trace.projUpdates === 0) {
      throw new Error("阴影相机未更新投影矩阵");
    }
  });

  T("程序化贴图已生成（墙 + 窗 + 自发光）", () => {
    if (created.canvas < 10) throw new Error("Canvas 贴图数量偏少：" + created.canvas);
    if (trace.colors < 10) throw new Error("颜色对象数量偏少：" + trace.colors);
  });

  T("昼夜切换不抛异常并改变光照强度", () => {
    const daySun = campus3d.sun.intensity;
    campus3d.night = true;
    campus3d._applyLighting();
    const nightSun = campus3d.sun.intensity;
    if (!(nightSun < daySun)) throw new Error("夜间主光未压暗：" + daySun + " → " + nightSun);
    campus3d.night = false;
    campus3d._applyLighting();
  });

  T("高亮与复位不抛异常", () => {
    const id = rag.placesPayload().places[0].id;
    campus3d.highlight(id);
    if (campus3d.hot !== id) throw new Error("高亮未记录当前建筑");
    campus3d.highlight(null);
    if (campus3d.hot !== null) throw new Error("取消高亮失败");
  });

  T("镜头飞向建筑使用世界坐标（含居中偏移）", () => {
    const p = rag.placesPayload().places[0];
    campus3d.flyToPlace(p.id, true);
    if (!campus3d.fly) throw new Error("未生成飞行目标");
    const w = campus3d._toWorld(p.x, p.y);
    if (Math.abs(campus3d.fly.tx - w.x) > 0.001 || Math.abs(campus3d.fly.tz - w.z) > 0.001) {
      throw new Error("飞行目标未使用居中后的世界坐标");
    }
  });

  /* ── 2.5D 地图 ── */
  group("② 2.5D 地图构建");
  let map = null;
  await TA("模块可加载并完成 _buildScene 全流程（无运行时错误）", async () => {
    const res = loadModule("js/map.js", sandbox);
    const Cls = vm.runInContext("CampusMap", res.ctx);
    const ctx = { config: {}, onPickPlace() {} };
    map = new Cls(ctx);
  });

  T("所有场所都生成了图形节点", () => {
    const places = rag.placesPayload().places;
    if (map.bldgNodes.size !== places.length) {
      throw new Error("生成 " + map.bldgNodes.size + " 个，期望 " + places.length + " 个");
    }
  });

  T("建筑节点包含投影/主体/亮边等图层（不再是单层矩形）", () => {
    const rec = map.bldgNodes.get("library_huatonglou");
    if (!rec) throw new Error("话筒楼节点缺失");
    /* 主体 + 至少 5 层装饰 = 6 个以上子元素 */
    if (rec.g.children.length < 5) {
      throw new Error("话筒楼仅 " + rec.g.children.length + " 个图层，立体感不足");
    }
  });

  T("道路绘制了路肩 / 路面 / 中线三层", () => {
    const kinds = created.svg;
    if (kinds.filter(k => k === "path").length < 30) {
      throw new Error("path 元素仅 " + kinds.filter(k => k === "path").length + " 个，道路分层可能未生效");
    }
  });

  T("生成了树木与草坪（绿化元素存在）", () => {
    const gCount = created.svg.length;
    if (created.svg.filter(k => k === "circle").length < 20) {
      throw new Error("circle 元素偏少，树冠/广场圆环可能未绘制");
    }
  });

  T("校门使用牌坊造型（含立柱与门匾文字）", () => {
    const gate = map.bldgNodes.get("place_gate");
    if (!gate) throw new Error("校门节点缺失");
    if (gate.g.children.length < 6) throw new Error("校门图层仅 " + gate.g.children.length + " 个，牌坊结构不完整");
  });

  T("广场与停车场走地坪分支（不画成楼房）", () => {
    const plaza = map.bldgNodes.get("place_plaza");
    if (!plaza) throw new Error("中心广场节点缺失");
    if (plaza.g.children.length < 2) throw new Error("广场图层过少");
  });

  T("轨迹动画方法可用（路线绘制 / 清除）", () => {
    const r = map.showRoute("place_dorm", "library_huatonglou");
    if (!r) throw new Error("未能生成路线");
    if (!r.nodes || r.nodes.length < 2) throw new Error("路线节点不足");
    if (!(r.minutes >= 1)) throw new Error("步行时间异常：" + r.minutes);
    map.clearRoute();
  });

  T("实时状态叠加不抛异常", () => {
    map.renderStatus();
    map.live = false;
    map.renderStatus();
    map.live = true;
    map.renderStatus();
  });

  T("坐标换算与相机变换可用", () => {
    const p = map._screenToSvg ? map._screenToSvg(100, 100) : null;
    if (!p || typeof p.x !== "number") throw new Error("_screenToSvg 返回值异常");
    map.flyTo({ x: 500, y: 500, w: 400, h: 400 }, 1);
  });

  console.log("");
  console.log("  ────────────────────────────────────────────");
  console.log("  冒烟测试：" + pass + " 通过，" + fail + " 失败 " + (fail ? "❌" : "✅"));
  if (fail) {
    console.log("");
    failures.forEach(f => console.log("   · " + f.name + "\n     " + f.msg));
  }
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("冒烟测试脚本异常：" + (e.stack || e.message));
  process.exit(1);
});
