/* ============================================================
 * v2 · 平面布局预览图导出
 *
 * 用途：把 data/places.json 渲染成一张独立的 SVG 预览图，
 *       用于在没有浏览器的情况下核对布局（间距、比例、方位是否合理）。
 *       它复用与网页版一致的配色与图形语义，但不依赖 DOM。
 *
 * 用法：node tools\preview-layout.js           # 输出 data/layout-preview.svg
 *      node tools\preview-layout.js --png      # 另存 PNG（需要 Windows + System.Drawing）
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "data", "places.json");
const OUT_SVG = path.join(ROOT, "data", "layout-preview.svg");
const OUT_PNG = path.join(ROOT, "data", "layout-preview.png");

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const S = 1;          // 1 逻辑单位 = 1 px（图幅 1000×1000）

const CAT_COLOR = {
  "图书馆": ["#e8cfae", "#c9a87e"], "自习室": ["#ecdcbe", "#cfb894"],
  "教学楼": ["#e3c9a6", "#c2a077"], "学院楼": ["#dfab7d", "#bd8557"],
  "行政": ["#e9dcc4", "#cbb894"], "住宿": ["#d99a72", "#b5734c"],
  "餐饮": ["#e5cfa6", "#c6ac7d"], "生活服务": ["#ddd0b6", "#bfae8d"],
  "医疗": ["#e7e4d8", "#c8c4b3"], "艺术实践": ["#e0906a", "#bc6c46"],
  "自习与活动": ["#e0c3a0", "#c1a077"], "运动场馆": ["#c85a4a", "#a34134"],
  "水域": ["#3f7fa8", "#2b5f83"], "交通": ["#b9bfc4", "#9aa1a7"],
  "出入口": ["#e8c341", "#c99e1f"], "公共空间": ["#c8bfa8", "#a89e83"],
};
const DEF = ["#ddc7a6", "#bda684"];

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const out = [];
const push = s => out.push(s);

push('<svg xmlns="http://www.w3.org/2000/svg" width="' + (1000 * S) + '" height="' + (1000 * S) + '" viewBox="0 0 1000 1000">');
push('<defs>');
push('<radialGradient id="g" cx="50%" cy="40%" r="78%">' +
  '<stop offset="0%" stop-color="#1b2f45"/><stop offset="100%" stop-color="#0b1725"/></radialGradient>');
Object.keys(CAT_COLOR).forEach((k, i) => {
  const c = CAT_COLOR[k];
  push('<linearGradient id="c' + i + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + c[0] + '"/><stop offset="100%" stop-color="' + c[1] + '"/></linearGradient>');
});
push('<linearGradient id="def" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0%" stop-color="' + DEF[0] + '"/><stop offset="100%" stop-color="' + DEF[1] + '"/></linearGradient>');
push('<linearGradient id="water" x1="0" y1="0" x2="0.3" y2="1">' +
  '<stop offset="0%" stop-color="#5fa2c8"/><stop offset="100%" stop-color="#2b5f83"/></linearGradient>');
push('<linearGradient id="gold" x1="0" y1="0" x2="0.6" y2="1">' +
  '<stop offset="0%" stop-color="#f5d76e"/><stop offset="100%" stop-color="#b8891c"/></linearGradient>');
push('<filter id="soft"><feGaussianBlur stdDeviation="3"/></filter>');
push('</defs>');
push('<rect width="1000" height="1000" fill="url(#g)"/>');

/* 网格 */
for (let i = 0; i < 1000; i += 40) {
  push('<line x1="' + i + '" y1="0" x2="' + i + '" y2="1000" stroke="rgba(120,165,220,.06)"/>');
  push('<line x1="0" y1="' + i + '" x2="1000" y2="' + i + '" stroke="rgba(120,165,220,.06)"/>');
}

/* 分区标签 */
const ZONES = [
  ["入口与生活区", 420, 968], ["宿舍与活动区", 160, 560],
  ["教学与阅读区", 420, 620], ["艺术实践区", 220, 80],
  ["水系", 878, 380], ["运动区", 760, 600],
];
ZONES.forEach(z => push('<text x="' + z[1] + '" y="' + z[2] + '" fill="rgba(139,160,189,.42)" font-size="16" ' +
  'letter-spacing="4" text-anchor="middle" font-family="sans-serif">' + z[0] + '</text>'));

/* 道路：与网页版使用同一份显式路网（主干道 + 支路），
   不再按 edges 两两连线 —— 那样会生成几十条斜线像蜘蛛网。 */
const byId = new Map(data.places.map(p => [p.id, p]));
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
const drawRoad = (ids, kind) => {
  const pts = ids.map(id => byId.get(id)).filter(Boolean);
  if (pts.length < 2) return;
  const d = pts.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join(" ");
  if (kind === "main") {
    push('<path d="' + d + '" fill="none" stroke="rgba(8,16,28,.68)" stroke-width="15" stroke-linecap="round"/>');
    push('<path d="' + d + '" fill="none" stroke="#3c4650" stroke-width="11.5" stroke-linecap="round"/>');
    push('<path d="' + d + '" fill="none" stroke="rgba(226,236,246,.28)" stroke-width="1.4" stroke-dasharray="10 10"/>');
  } else {
    push('<path d="' + d + '" fill="none" stroke="rgba(8,16,28,.5)" stroke-width="9" stroke-linecap="round"/>');
    push('<path d="' + d + '" fill="none" stroke="#353d45" stroke-width="6" stroke-linecap="round"/>');
  }
};
MAIN.forEach(ids => drawRoad(ids, "main"));
BRANCH.forEach(ids => drawRoad(ids, "branch"));

/* 建筑 */
data.places.forEach(p => {
  const r = p.rect;
  if (!r) return;
  const idx = Object.keys(CAT_COLOR).indexOf(p.category);
  const fill = idx >= 0 ? "url(#c" + idx + ")" : "url(#def)";

  if (p.category === "出入口") {
    /* 金色大门：曲面拱 + 门匾 */
    const cx = p.x, y = p.y, W = 200, H = 60;
    push('<path d="M' + (cx - W / 2) + ' ' + (y + 14) + ' L' + (cx - W / 2 + 10) + ' ' + (y - H) +
      ' L' + (cx + W * 0.30) + ' ' + (y - H) + ' C' + (cx + W * 0.44) + ' ' + (y - H) + ' ' +
      (cx + W * 0.50) + ' ' + (y - H * 0.6) + ' ' + (cx + W / 2) + ' ' + (y - 20) +
      ' L' + (cx + W * 0.12) + ' ' + (y - 10) + ' C' + (cx - W * 0.16) + ' ' + (y - 6) + ' ' +
      (cx - W * 0.40) + ' ' + (y + 4) + ' ' + (cx - W / 2) + ' ' + (y + 14) + ' Z" ' +
      'fill="url(#gold)" stroke="rgba(255,236,180,.6)" stroke-width="1.6"/>');
    push('<rect x="' + (cx + 24) + '" y="' + (y - 18) + '" width="86" height="14" rx="2" fill="rgba(250,252,255,.92)"/>');
    push('<text x="' + (cx + 67) + '" y="' + (y - 7) + '" fill="#1d3550" font-size="10" font-weight="700" ' +
      'text-anchor="middle" font-family="sans-serif">河北传媒学院</text>');
    push('<text x="' + cx + '" y="' + (y + 36) + '" fill="#e8eef6" font-size="15" text-anchor="middle" ' +
      'font-family="sans-serif">金色大门</text>');
    return;
  }

  if (p.shape === "track") {
    push('<rect x="' + (r.x + 4) + '" y="' + (r.y + 6) + '" width="' + r.w + '" height="' + r.h +
      '" rx="' + (Math.min(r.w, r.h) * .42) + '" fill="rgba(24,34,48,.4)" filter="url(#soft)"/>');
    push('<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h +
      '" rx="' + (Math.min(r.w, r.h) * .42) + '" fill="#b4483a" stroke="rgba(255,190,170,.3)" stroke-width="1.6"/>');
    push('<rect x="' + (p.x - r.w * .31) + '" y="' + (p.y - r.h * .31) + '" width="' + r.w * .62 + '" height="' + r.h * .62 +
      '" rx="4" fill="#3d7a45" stroke="rgba(255,255,255,.42)" stroke-width="1.2"/>');
    push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r.w * .09 + '" fill="none" stroke="rgba(255,255,255,.4)"/>');
    push('<line x1="' + p.x + '" y1="' + (p.y - r.h * .31) + '" x2="' + p.x + '" y2="' + (p.y + r.h * .31) + '" stroke="rgba(255,255,255,.4)"/>');
    push('<rect x="' + (r.x - 16) + '" y="' + (r.y + r.h * .18) + '" width="14" height="' + r.h * .64 +
      '" rx="3" fill="#8f3a2e" stroke="rgba(255,200,180,.32)"/>');
    push('<text x="' + p.x + '" y="' + (r.y + r.h + 20) + '" fill="#e8eef6" font-size="15" text-anchor="middle" font-family="sans-serif">田径场</text>');
    return;
  }

  if (p.shape === "lake") {
    push('<ellipse cx="' + p.x + '" cy="' + p.y + '" rx="' + r.w * .48 + '" ry="' + r.h * .46 +
      '" fill="url(#water)" stroke="rgba(150,210,240,.22)" stroke-width="1.4"/>');
    const d = "M" + (r.x - 10) + " " + (p.y + 60) + " C" + (r.x + 30) + " " + (p.y - 60) + " " +
      (p.x + 20) + " " + (p.y + 40) + " " + (p.x + 20) + " " + p.y + " C" + (p.x + 20) + " " + (p.y - 60) + " " +
      (r.x + r.w - 20) + " " + (p.y + 40) + " " + (r.x + r.w + 10) + " " + (p.y - 70);
    push('<path d="' + d + '" fill="none" stroke="#d9c9a8" stroke-width="4" stroke-linecap="round"/>');
    push('<text x="' + p.x + '" y="' + (r.y + r.h + 20) + '" fill="#e8eef6" font-size="14" text-anchor="middle" font-family="sans-serif">校园水系</text>');
    return;
  }

  if (p.shape === "fountain") {
    push('<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="10" fill="rgba(74,84,92,.92)"/>');
    const pw = r.w * .62, ph = r.h * .46, ringR = Math.min(pw, ph) * .30;
    push('<rect x="' + (p.x - pw / 2) + '" y="' + (p.y - ph / 2) + '" width="' + pw + '" height="' + ph + '" rx="6" fill="url(#water)"/>');
    push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + ringR + '" fill="none" stroke="#e8621f" stroke-width="6"/>');
    push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + ringR + '" fill="none" stroke="#ffa15c" stroke-width="2"/>');
    push('<text x="' + p.x + '" y="' + (r.y + r.h + 20) + '" fill="#e8eef6" font-size="14" text-anchor="middle" font-family="sans-serif">喷泉广场</text>');
    return;
  }

  const isPad = p.category === "公共空间" || p.category === "交通";
  push('<rect x="' + (r.x + 4) + '" y="' + (r.y + 6) + '" width="' + r.w + '" height="' + r.h +
    '" rx="7" fill="rgba(24,34,48,.38)" filter="url(#soft)"/>');
  push('<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="7" fill="' +
    (isPad ? "rgba(74,84,92,.9)" : fill) + '" stroke="rgba(120,175,235,.42)" stroke-width="1.5"/>');
  if (!isPad) {
    push('<rect x="' + (r.x + 1.5) + '" y="' + (r.y + 1.5) + '" width="' + (r.w - 3) + '" height="5" rx="3" fill="#ffffff" opacity=".16"/>');
    /* 窗格 */
    const cols = Math.max(2, Math.round(r.w / 26)), rows = Math.max(2, Math.round(r.h / 26));
    for (let cx = 0; cx < cols; cx++) for (let cy = 0; cy < rows; cy++) {
      push('<rect x="' + (r.x + cx * r.w / cols + r.w / cols * .18) + '" y="' + (r.y + cy * r.h / rows + r.h / rows * .22) +
        '" width="' + (r.w / cols * .64) + '" height="' + (r.h / rows * .38) + '" rx="1.4" fill="rgba(255,255,255,.18)"/>');
    }
  }
  push('<text x="' + p.x + '" y="' + (r.y + r.h + 20) + '" fill="#c7dcf3" font-size="14" text-anchor="middle" ' +
    'font-family="sans-serif">' + esc(p.name.replace(/（.*?）/g, "")) + '</text>');
});

push('</svg>');

exportSvg();

function exportSvg() {
  const svg = out.join("\n");
  fs.writeFileSync(OUT_SVG, svg, "utf8");
  console.log("");
  console.log("  布局预览已导出：" + path.relative(ROOT, OUT_SVG));
  console.log("  场所 " + data.places.length + " 个 · 尺寸 1000×1000");
  if (process.argv.includes("--png")) {
    console.log("  （PNG 转换请在 PowerShell 中用 System.Drawing 完成，见 README 命令）");
  }
  console.log("");
}
