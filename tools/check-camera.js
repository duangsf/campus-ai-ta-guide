/* ============================================================
 * v2 · 3D 取景核验（正交沙盘视角 / 透视漫游视角）
 *
 * 为什么必须用脚本算：
 *   这个功能我连续修错了两轮，都是靠这个脚本离线算出来的：
 *     ① 按"建筑内容"而非"沙盘底板"算距离 → 底板被裁掉 94%
 *     ② 用"四角包围盒居中"当目标 → 底板中心被推到画面 62% 高度
 *     ③ 根本矛盾：透视投影下地平面"近大远小"，远侧建筑被压向画面上方，
 *        建筑群中心落在屏幕 92% 高度，而底板中心在 50% —— 无论怎么调参，
 *        透视都不可能让地面沙盘"完整 + 居中 + 建筑均匀分布"三者兼得。
 *        因此默认改为正交（等轴测）相机：没有近大远小，构图天然对称。
 *
 * 用法：node tools\check-camera.js [宽 高] [--persp]
 *   例：node tools\check-camera.js 787 458            # 正交沙盘视角
 *       node tools\check-camera.js 787 458 --persp    # 透视漫游视角
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/* ── 与 js/globe.js 保持一致的常量 ── */
const SCALE = 0.1;
const SANDBOX_MULT = 1.05;
const FOV = 44;
const PHI0 = Math.PI * 0.32;
const THETA0 = Math.PI * 0.22;
const MARGIN_ORTHO = 0.99;
const MARGIN_PERSP = 0.90;

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const USE_PERSP = process.argv.includes("--persp");
const W = parseInt(args[0], 10) || 1200;
const H = parseInt(args[1], 10) || 700;
const aspect = W / H;

const tanV = Math.tan(FOV * Math.PI / 360);
const tanH = tanV * aspect;

/* 内容范围与最高建筑（places.json 推得） */
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8"));
const rects = data.places.map(p => p.rect).filter(Boolean);
const cMinX = Math.min(...rects.map(r => r.x)), cMaxX = Math.max(...rects.map(r => r.x + r.w));
const cMinZ = Math.min(...rects.map(r => r.y)), cMaxZ = Math.max(...rects.map(r => r.y + r.h));
const contentCenter = { x: (cMinX + cMaxX) / 2 * SCALE, z: (cMinZ + cMaxZ) / 2 * SCALE };
const contentSpan = Math.max(cMaxX - cMinX, cMaxZ - cMinZ) * SCALE;
/* 最高建筑：住宿 7 层 × 3.4 = 23.8，再留一点余量 */
const contentTop = 24;

/* 沙盘＝校园外接矩形 + 一圈边距（与 globe.js 的 plateBounds 保持一致） */
const PLATE_MARGIN_M = 45;
const pMinX = cMinX - PLATE_MARGIN_M, pMaxX = cMaxX + PLATE_MARGIN_M;
const pMinZ = cMinZ - PLATE_MARGIN_M, pMaxZ = cMaxZ + PLATE_MARGIN_M;
const plateW = (pMaxX - pMinX) * SCALE, plateD = (pMaxZ - pMinZ) * SCALE;
const plateCX = (pMinX + pMaxX) / 2 * SCALE, plateCZ = (pMinZ + pMaxZ) / 2 * SCALE;
const sandboxSize = Math.max(plateW, plateD);
const CORNERS = [
  [plateCX - plateW / 2, plateCZ - plateD / 2], [plateCX + plateW / 2, plateCZ - plateD / 2],
  [plateCX - plateW / 2, plateCZ + plateD / 2], [plateCX + plateW / 2, plateCZ + plateD / 2],
];
const HEIGHTS = [0, contentTop];

const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const nrm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

/** 相机基向量：eye = plateCenter + dir*d，朝向 plateCenter */
function basis(theta, phi) {
  const dir = { x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) };
  const fwd = nrm({ x: -dir.x, y: -dir.y, z: -dir.z });
  const right = nrm(cross(fwd, { x: 0, y: 1, z: 0 }));
  return { fwd, right, up: cross(right, fwd), dir };
}

/* ── 正交：两遍法（与 globe.js 同算法） ──
   第一遍按 "target = 沙盘几何中心" 求投影包络；
   第二遍按 "包络中心 → 画面中心" 的偏移平移 target，再重算 halfHeight。
   地平面矩形在斜视角下会投影成非对称四边形，少了第二遍就会整体偏上/偏下。 */
function orthoFit(theta, phi) {
  const b = basis(theta, phi);
  const measure = (tx, ty, tz) => {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    CORNERS.forEach(([cx, cz]) => {
      HEIGHTS.forEach(y => {
        const v = { x: cx - tx, y: y - ty, z: cz - tz };
        const u = v.x * b.right.x + v.y * b.right.y + v.z * b.right.z;
        const vv = v.x * b.up.x + v.y * b.up.y + v.z * b.up.z;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
      });
    });
    return { minU, maxU, minV, maxV, cu: (minU + maxU) / 2, cv: (minV + maxV) / 2 };
  };

  const m1 = measure(plateCX, 0, plateCZ);
  const t = {
    x: plateCX + m1.cu * b.right.x + m1.cv * b.up.x,
    y: 0 + m1.cu * b.right.y + m1.cv * b.up.y,
    z: plateCZ + m1.cu * b.right.z + m1.cv * b.up.z,
  };
  const m2 = measure(t.x, t.y, t.z);
  const halfH = Math.max((m2.maxV - m2.minV) / 2, (m2.maxU - m2.minU) / 2 / aspect) / MARGIN_ORTHO;
  const halfW = halfH * aspect;
  const ndc = (x, y, z) => {
    const v = { x: x - t.x, y: y - t.y, z: z - t.z };
    const u = v.x * b.right.x + v.y * b.right.y + v.z * b.right.z;
    const vv = v.x * b.up.x + v.y * b.up.y + v.z * b.up.z;
    return { nx: u / halfW, ny: vv / halfH, sx: (u / halfW + 1) / 2, sy: (1 - vv / halfH) / 2 };
  };
  return { halfH, halfW, ndc, target: t, mode: "ortho", bbox: m2 };
}

/* ── 透视：迭代解距离 ── */
function perspFit(theta, phi) {
  const worst = (d) => {
    const b = basis(theta, phi);
    const eye = { x: plateCX + b.dir.x * d, y: b.dir.y * d, z: plateCZ + b.dir.z * d };
    let w = 0;
    CORNERS.forEach(([cx, cz]) => {
      HEIGHTS.forEach(y => {
        const v = { x: cx - eye.x, y: y - eye.y, z: cz - eye.z };
        const depth = v.x * b.fwd.x + v.y * b.fwd.y + v.z * b.fwd.z;
        if (depth <= 0.01) { w = 99; return; }
        const nx = (v.x * b.right.x + v.y * b.right.y + v.z * b.right.z) / (depth * tanH);
        const ny = (v.x * b.up.x + v.y * b.up.y + v.z * b.up.z) / (depth * tanV);
        w = Math.max(w, Math.abs(nx), Math.abs(ny));
      });
    });
    return w;
  };
  let d = (Math.max(plateW, plateD)) * Math.SQRT2 / Math.min(tanV, tanH) * 0.6;
  for (let i = 0; i < 8; i++) {
    const w = worst(d);
    if (!isFinite(w) || w <= 0) break;
    const next = d * (w / MARGIN_PERSP);
    if (Math.abs(next - d) < 0.05) { d = next; break; }
    d = next;
  }
  const b = basis(theta, phi);
  const eye = { x: plateCX + b.dir.x * d, y: b.dir.y * d, z: plateCZ + b.dir.z * d };
  const ndc = (x, y, z) => {
    const v = { x: x - eye.x, y: y - eye.y, z: z - eye.z };
    const depth = v.x * b.fwd.x + v.y * b.fwd.y + v.z * b.fwd.z;
    if (depth <= 0.01) return { nx: NaN, ny: NaN, sx: NaN, sy: NaN };
    const nx = (v.x * b.right.x + v.y * b.right.y + v.z * b.right.z) / (depth * tanH);
    const ny = (v.x * b.up.x + v.y * b.up.y + v.z * b.up.z) / (depth * tanV);
    return { nx, ny, sx: (nx + 1) / 2, sy: (1 - ny) / 2 };
  };
  return { dist: d, ndc, mode: "persp" };
}

/* ── 计算并输出 ── */
const fit = USE_PERSP ? perspFit(THETA0, PHI0) : orthoFit(THETA0, PHI0);

console.log("");
console.log("  3D 取景核验 · 画布 " + W + "×" + H + "（宽高比 " + aspect.toFixed(2) + "）" +
  "  ·  " + (USE_PERSP ? "透视漫游视角" : "正交沙盘视角（默认）"));
console.log("  ────────────────────────────────────────────────────────────");
console.log("  沙盘底板      " + plateW.toFixed(1) + " × " + plateD.toFixed(1) + " 单位");
console.log("  建筑内容跨度  " + contentSpan.toFixed(1) + " 单位 · 最高建筑约 " + contentTop + " 单位");
if (USE_PERSP) console.log("  取景距离      " + fit.dist.toFixed(1) + " 单位（相机目标 = 底板中心）");
else console.log("  正交视锥      halfHeight " + fit.halfH.toFixed(1) + " · halfWidth " + fit.halfW.toFixed(1) +
  "（相机目标 = 底板中心）");
console.log("");

const labels = ["左上", "右上", "左下", "右下"];
console.log("  底板四角在画面中的位置（0%=左/上，100%=右/下）：");
let maxNdc = 0;
CORNERS.forEach(([cx, cz], i) => {
  const p = fit.ndc(cx, 0, cz);
  maxNdc = Math.max(maxNdc, Math.abs(p.nx), Math.abs(p.ny));
  const out = (Math.abs(p.nx) > 1 || Math.abs(p.ny) > 1) ? "  ✗ 出界" : "";
  console.log("    " + labels[i] + "  (" + (p.sx * 100).toFixed(1) + "%, " + (p.sy * 100).toFixed(1) + "%)" +
    "   NDC=(" + p.nx.toFixed(3) + ", " + p.ny.toFixed(3) + ")" + out);
});

/* 正交：判据是"投影包络居中"；透视：判据是"沙盘中心居中" */
let offX, offY, c0;
if (!USE_PERSP && fit.bbox) {
  offX = Math.abs(fit.bbox.cu / (fit.halfW)) * 50;
  offY = Math.abs(fit.bbox.cv / (fit.halfH)) * 50;
  c0 = fit.ndc(plateCX, 0, plateCZ);
} else {
  c0 = fit.ndc(plateCX, 0, plateCZ);
  offX = Math.abs(c0.sx - 0.5) * 100; offY = Math.abs(c0.sy - 0.5) * 100;
}
const pc = fit.ndc(contentCenter.x, contentTop / 2, contentCenter.z);
const bx = Math.abs(pc.sx - 0.5) * 100, by = Math.abs(pc.sy - 0.5) * 100;
/* 建筑群在屏幕上的横向/纵向铺开范围 */
let bMin = { x: 1, y: 1 }, bMax = { x: 0, y: 0 };
rects.forEach(r => {
  [[r.x, r.y], [r.x + r.w, r.y + r.h]].forEach(([lx, lz]) => {
    const p = fit.ndc(lx * SCALE, contentTop / 2, lz * SCALE);
    if (!isFinite(p.sx)) return;
    bMin = { x: Math.min(bMin.x, p.sx), y: Math.min(bMin.y, p.sy) };
    bMax = { x: Math.max(bMax.x, p.sx), y: Math.max(bMax.y, p.sy) };
  });
});

console.log("");
console.log("  最大 |NDC|     " + maxNdc.toFixed(3) +
  (maxNdc <= 1 ? "  ✓ 完整入画" : "  ✗ 被裁掉 " + ((maxNdc - 1) * 100).toFixed(0) + "%"));
console.log("  ★ 沙盘中心     (" + (c0.sx * 100).toFixed(1) + "%, " + (c0.sy * 100).toFixed(1) + "%)");
console.log("  ★ 构图居中偏差 " + offX.toFixed(2) + " / " + offY.toFixed(2) + " pt（判据：投影包络中心 = 画面中心）" +
  ((offX < 0.5 && offY < 0.5) ? "   ✓ 居中" : "   ✗ 未居中"));
console.log("  ★ 建筑群中心   (" + (pc.sx * 100).toFixed(1) + "%, " + (pc.sy * 100).toFixed(1) +
  "%)    偏差 " + bx.toFixed(1) + " / " + by.toFixed(1) + " pt" +
  ((bx < 5 && by < 5) ? "   ✓ 居中" : "   ← 偏离"));
console.log("    建筑群铺开   水平 " + (bMin.x * 100).toFixed(0) + "%~" + (bMax.x * 100).toFixed(0) +
  "%   垂直 " + (bMin.y * 100).toFixed(0) + "%~" + (bMax.y * 100).toFixed(0) + "%");
console.log("");

const ok = maxNdc <= 1.001 && offX < 0.5 && offY < 0.5;
console.log("  " + (ok ? "✅ 构图合格：沙盘完整入画且底板中心位于画面正中" : "❌ 构图不合格"));
console.log("");
process.exit(ok ? 0 : 1);
