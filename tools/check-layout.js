/* ============================================================
 * v2 · 校园平面布局校验
 *
 * 用途：检查 data/places.json 里各场所的占地矩形是否重叠、间距是否过小。
 * 起因：早期版本按"大学校园一般布局"随意给了尺寸（宿舍 160×170m、食堂 200×130m），
 *       结果是每栋楼被放大到失真、楼与楼互相压叠，地图看起来挤成一团。
 *       靠肉眼在几百个坐标里找重叠不可靠，所以做成可重复运行的检查。
 *
 * 判据：
 *   ① 任何两个场所的矩形不得相交（overlap = 0）
 *   ② 相邻场所之间至少留 MIN_GAP 的间距，保证道路与绿化有地方放
 *   ③ 所有场所必须落在校区边界内
 *   ④ 建筑占地与分类的合理尺寸区间相符（防止又出现"巨型宿舍楼"）
 *
 * 用法：node tools\check-layout.js
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "data", "places.json");
const MIN_GAP = 2;           // 相邻场所最小间距（逻辑单位 ≈ 米）
const BOUND = { min: 40, max: 960 };

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const places = data.places;

/**
 * 各分类的合理占地边长上限（米）。
 * 上限按"该类型最大的真实单体"给：田径场与水域本身就是大尺度场地，
 * 不能按普通建筑卡；否则校验会一直报"尺寸失真"而掩盖真正的重叠问题。
 */
const SIZE_RANGE = {
  "图书馆": [55, 170], "自习室": [40, 120], "教学楼": [60, 150],
  "学院楼": [60, 150], "行政": [60, 130], "住宿": [70, 190],
  "餐饮": [60, 150], "生活服务": [30, 110], "医疗": [30, 90],
  "艺术实践": [50, 130], "自习与活动": [50, 140], "运动场馆": [120, 320],
  "水域": [60, 360], "交通": [60, 160], "出入口": [80, 230], "公共空间": [80, 220],
};

function rectOf(p) {
  const r = p.rect;
  if (!r) return null;
  return { id: p.id, name: p.name, cat: p.category, x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h, w: r.w, h: r.h };
}

/**
 * 两个矩形的间距。
 *   返回 >0：分离（两轴间隙的较大值）
 *   返回  0：边界恰好接触 —— **不算重叠**（相交面积为 0）。
 *            若把接触判成重叠，"排得很紧凑的相邻建筑"将永远无法通过校验。
 *   返回 <0：真实相交，绝对值是相交面积的平方根（越大越严重）
 */
function gapOf(a, b) {
  const gapX = Math.max(a.x1 - b.x2, b.x1 - a.x2);
  const gapY = Math.max(a.y1 - b.y2, b.y1 - a.y2);
  if (gapX > 0 || gapY > 0) return Math.max(gapX, gapY);
  const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const area = Math.max(0, ox) * Math.max(0, oy);
  if (area <= 0) return 0;
  return -Math.sqrt(area);
}

const rects = places.map(rectOf).filter(Boolean);
let issues = 0;
const report = { overlap: [], tight: [], outOfBounds: [], oversized: [], missing: [] };

/* ① 两两检查重叠与间距 */
for (let i = 0; i < rects.length; i++) {
  for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const g = gapOf(a, b);
    if (g < 0) {
      /* 只有真实相交才算重叠（接触面积 > 0） */
      report.overlap.push({ a, b, overlap: Math.abs(g) });
      issues++;
    } else if (g < MIN_GAP) {
      report.tight.push({ a, b, gap: +g.toFixed(1) });
      issues++;
    }
  }
}

/* ② 边界检查 */
rects.forEach(r => {
  if (r.x1 < BOUND.min || r.y1 < BOUND.min || r.x2 > BOUND.max || r.y2 > BOUND.max) {
    report.outOfBounds.push(r);
    issues++;
  }
});

/* ③ 尺寸合理性 */
rects.forEach(r => {
  const range = SIZE_RANGE[r.cat];
  if (!range) return;
  const longSide = Math.max(r.w, r.h);
  if (longSide > range[1]) {
    report.oversized.push({ r, longSide, limit: range[1] });
    issues++;
  }
});

/* ④ 缺少 rect 的场所 */
places.forEach(p => { if (!p.rect) report.missing.push(p.id); else if (report.missing.length) return; });

/* ── 输出 ── */
const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log("  校园平面布局校验 · " + places.length + " 个场所");
console.log("  ────────────────────────────────────────────────────────");

if (report.overlap.length) {
  console.log("");
  console.log("  ✗ 重叠（必须修复）：" + report.overlap.length + " 对");
  report.overlap
    .sort((a, b) => b.overlap - a.overlap)
    .forEach(o => {
      console.log("    · " + pad(o.a.name, 16) + " × " + pad(o.b.name, 16) +
        " 重叠约 " + o.overlap.toFixed(0) + " 单位");
      console.log("        " + o.a.id + " [" + o.a.x1 + "," + o.a.y1 + " → " + o.a.x2 + "," + o.a.y2 + "]");
      console.log("        " + o.b.id + " [" + o.b.x1 + "," + o.b.y1 + " → " + o.b.x2 + "," + o.b.y2 + "]");
    });
}

if (report.tight.length) {
  console.log("");
  console.log("  ⚠ 间距过小（<" + MIN_GAP + "）：" + report.tight.length + " 对");
  report.tight
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 20)
    .forEach(o => console.log("    · " + pad(o.a.name, 16) + " × " + pad(o.b.name, 16) + " 间距 " + o.gap));
}

if (report.outOfBounds.length) {
  console.log("");
  console.log("  ⚠ 超出校区边界 [" + BOUND.min + "," + BOUND.max + "]：" + report.outOfBounds.length + " 个");
  report.outOfBounds.forEach(r => console.log("    · " + pad(r.name, 16) + " [" + r.x1 + "," + r.y1 + " → " + r.x2 + "," + r.y2 + "]"));
}

if (report.oversized.length) {
  console.log("");
  console.log("  ⚠ 占地过大（疑似尺寸失真）：" + report.oversized.length + " 个");
  report.oversized.forEach(o => console.log("    · " + pad(o.r.name, 16) + " 长边 " + o.longSide +
    " > 上限 " + o.limit + "（" + o.r.cat + "）"));
}

if (report.missing.length) {
  console.log("");
  console.log("  ⚠ 缺少 rect：" + report.missing.join(", "));
}

/* 统计指标：覆盖率 = 建筑占地和 / 校区面积 */
const areaSum = rects.filter(r => r.cat !== "公共空间" && r.cat !== "水域" && r.cat !== "运动场馆")
  .reduce((s, r) => s + r.w * r.h, 0);
const campus = (BOUND.max - BOUND.min) * (BOUND.max - BOUND.min);
console.log("");
console.log("  建筑占地合计 " + Math.round(areaSum / 10000) + " 万 m² · 校区 " +
  Math.round(campus / 10000) + " 万 m² · 建筑密度 " + (areaSum / campus * 100).toFixed(1) + "%");
console.log("  " + (issues === 0
  ? "✅ 无重叠、间距合规、尺寸合理"
  : "❌ 共 " + issues + " 处问题需修复"));
console.log("");

process.exit(issues === 0 ? 0 : 1);
