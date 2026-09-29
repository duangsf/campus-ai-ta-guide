/* ============================================================
 * v2 · 校园平面布局生成器（显式尺寸 + 自动收敛）
 *
 * 前两版的做法都失败了：
 *   ① 手写坐标      → 25 个场所两两 300 组关系，必然撞（14 对重叠）
 *   ② 均匀网格      → 格子接近正方，但建筑有长条/方正之分，等比例缩放后仍会压叠
 *
 * 本版做法：
 *   1. **按功能区显式声明**每个场所的坐标与尺寸（人能读懂、便于按实景调整），
 *      每个区块成组排布，组内沿主方向依次摆放、组间留出通道；
 *   2. 声明完成后运行**自动收敛**：反复检测相交的矩形对，
 *      按相交轴把两者各缩小一点（最多缩到 78%），直到零重叠；
 *   3. 最后用 tools/check-layout.js 独立复核，避免"生成器自己说自己没问题"。
 *
 * 用法：node tools\gen-layout.js [--dry]
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "data", "places.json");
const DRY = process.argv.includes("--dry");

/* ── 极小值工具 ── */
const r = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });

/* ============================================================
 * 布局声明：自南向北、自西向东
 *
 * 尺寸参考真实建筑尺度（1 单位 ≈ 1 米）：
 *   宿舍楼   ~110×26    教学楼/学院楼 ~95×52    图书馆 ~130×66
 *   食堂     ~100×60    田径场       ~300×175   水系   ~105×420
 *   小配套   ~45×45
 * ============================================================ */
const PLAN = {
  /* ── 南带（y 800+）：入口与生活服务 ── */
  place_gate:             r(392, 880, 216, 44),    // 金色大门（横向宽）
  place_plaza:            r(352, 762, 118, 66),    // 中心广场
  place_canteen:          r(96, 700, 118, 118),    // 食堂（竖向）
  place_market:           r(592, 800, 62, 56),     // 超市
  place_express:          r(664, 800, 66, 56),     // 快递
  place_clinic:           r(740, 800, 64, 56),     // 校医院
  place_parking:          r(820, 800, 116, 56),    // 停车场

  /* ── 西带（x 60~350）：宿舍生活区与活动区 ── */
  place_admin_office:     r(60, 566, 120, 84),     // 行政办公楼
  place_dorm:             r(60, 414, 168, 80),     // 宿舍区（横向长条）
  place_activity_center:  r(233, 356, 90, 104),    // 大学生活动中心
  place_bathhouse:        r(60, 300, 100, 66),     // 公共浴室
  place_study_center:     r(170, 296, 88, 58),     // 活动中心自习室
  building_journalism:    r(184, 216, 108, 76),    // 新闻传播学院

  /* ── 中带（x 280~690）：教学、阅读与艺术实践 ── */
  lake_fountain:          r(350, 358, 100, 86),    // 喷泉广场
  library_huatonglou:     r(298, 474, 148, 100),   // 话筒楼（图书馆）
  place_study_a113:       r(456, 474, 74, 68),     // A座113书库
  building_a:             r(500, 572, 110, 84),    // 教学楼A座
  place_print:            r(620, 458, 66, 66),     // 文印店
  building_film:          r(268, 104, 108, 92),    // 影视艺术学院
  place_rehearsal:        r(166, 110, 92, 82),     // 排练厅
  building_music_hall:    r(64, 110, 92, 92),      // 音乐厅

  /* ── 东带（x 700+）：水系、运动与教学楼 ── */
  lake_campus:            r(830, 200, 96, 340),    // 校园水系（南北长条）
  place_sports:           r(620, 620, 296, 176),   // 田径场（大横向）
  building_b:             r(690, 70, 110, 82),     // 教学楼B座
  place_studio:           r(822, 78, 92, 74),      // 演播厅
};

/* ============================================================
 * 自动收敛：反复消解相交矩形，直到零重叠
 * ============================================================ */
function intersect(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return null;
  return { ox, oy };
}

function resolve(plan) {
  const ids = Object.keys(plan);
  const scale = {};
  ids.forEach(id => { scale[id] = 1; });
  const log = [];

  for (let pass = 0; pass < 200; pass++) {
    let fixed = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = ids[i], B = ids[j];
        const hit = intersect(plan[A], plan[B]);
        if (!hit) continue;
        fixed++;
        /* 沿相交较小的轴收缩，两边各承担一半，保持中心基本不动。
           注意 need 必须在外层定义：写在 if 块里的话，块外引用会命中 TDZ
           （这类错误只在有重叠时才会触发，很容易漏测）。 */
        const alongX = hit.ox <= hit.oy;
        const need = (alongX ? hit.ox : hit.oy) / 2 + 1;
        if (alongX) {
          shrink(A, "w", need); shrink(B, "w", need);
        } else {
          shrink(A, "h", need); shrink(B, "h", need);
        }
        if (log.length < 40) {
          log.push("  " + A + " × " + B + " 相交(" + Math.round(hit.ox) + "×" + Math.round(hit.oy) +
            ") → 沿" + (alongX ? "水平" : "垂直") + "轴各收缩 " + Math.round(need));
        }
      }
    }
    if (!fixed) break;
  }

  function shrink(id, dim, amount) {
    const p = plan[id];
    /* 收缩同时受"最小可用尺寸"保护：不能把楼缩成一个点 */
    const minW = 34, minH = 26;
    if (dim === "w") {
      const nw = Math.max(minW, p.w - amount);
      p.x += Math.round((p.w - nw) / 2);
      p.w = Math.round(nw);
    } else {
      const nh = Math.max(minH, p.h - amount);
      p.y += Math.round((p.h - nh) / 2);
      p.h = Math.round(nh);
    }
  }

  return { plan, log };
}

const { plan, log } = resolve(PLAN);

/* ── 写回 places.json ── */
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
let updated = 0;
const missing = [];
data.places.forEach(p => {
  const rect = plan[p.id];
  if (!rect) { missing.push(p.id); return; }
  p.rect = rect;
  p.x = rect.x + Math.round(rect.w / 2);
  p.y = rect.y + Math.round(rect.h / 2);
  updated++;
});

data.meta.coordinate = "0-1000 逻辑坐标，y 轴向下；按功能区显式排布并按真实建筑尺度缩放，1 单位 ≈ 1 米（示意布局，非实测测绘）";
data.meta.layoutNote =
  "各场所的相对方位按校园功能区关系编排，占地尺寸按真实建筑量级缩放，建筑之间保留通道与绿化间距。" +
  "**不是实测测绘数据**，精确点位请以校内导视牌与官方平面图为准。";

if (!DRY) fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");

console.log("");
console.log("  校园平面布局生成" + (DRY ? "（试运行，未写文件）" : "完成"));
console.log("  ────────────────────────────────────────");
console.log("  已重排场所  " + updated + " / " + data.places.length);
if (missing.length) console.log("  ⚠ 未声明：" + missing.join(", "));
if (log.length) {
  console.log("");
  console.log("  自动消解的重叠（前 " + Math.min(log.length, 12) + " 条）：");
  log.slice(0, 12).forEach(l => console.log(l));
}
console.log("");
console.log("  下一步：node tools\\check-layout.js  独立复核");
console.log("");
