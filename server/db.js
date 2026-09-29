/* ============================================================
 * v2 数据层 · node:sqlite 真落库
 *
 * 设计说明：
 *  - 使用 Node 内置的 node:sqlite（Node 22.5+ 提供，零第三方依赖），
 *    避免为了"真数据库"而引入 better-sqlite3 这类需要编译的依赖。
 *  - 若当前 Node 版本不支持 node:sqlite，自动降级为内存表，
 *    保证服务一定能启动（路演稳定性优先），并在 /api/health 中如实上报存储模式。
 *
 * 表结构：
 *   qa_log     问答流水（含检索策略、分数、延迟、命中来源、降级情况）
 *   feedback   用户对回答的满意度反馈
 *   ticket     未命中问题自动生成的"知识盲区"工单
 *   kb_extra   运营后台新增/编辑的知识条目（覆盖式，不改源文件）
 * ============================================================ */
"use strict";

const DB_FILE = process.env.DB_FILE || "data/v2.db";

let backend = "memory";      // "sqlite" | "memory"
let sqliteDb = null;

/* ---------- 内存降级实现（接口与 sqlite 版本保持一致） ---------- */
const mem = { qa: [], feedback: [], ticket: [], kb: [], seq: { qa: 1, feedback: 1, ticket: 1, kb: 1 } };

function memRun(kind, row) {
  if (kind === "qa") { row.id = mem.seq.qa++; mem.qa.push(row); return row.id; }
  if (kind === "feedback") { row.id = mem.seq.feedback++; mem.feedback.push(row); return row.id; }
  if (kind === "ticket") { row.id = mem.seq.ticket++; mem.ticket.push(row); return row.id; }
  if (kind === "kb") { row.id = mem.seq.kb++; mem.kb.push(row); return row.id; }
}

/* ---------- 初始化 ---------- */
function init() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const path = require("node:path");
    const file = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(__dirname, "..", DB_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqliteDb = new DatabaseSync(file);
    sqliteDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS qa_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session TEXT,
        role TEXT,
        question TEXT NOT NULL,
        answer TEXT,
        intent TEXT,
        strategy TEXT,
        top_score REAL,
        confidence REAL,
        hit INTEGER,
        sources TEXT,
        latency_first INTEGER,
        latency_answer INTEGER,
        latency_total INTEGER,
        degraded INTEGER DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_qa_ts ON qa_log(ts);
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        qa_id INTEGER,
        session TEXT,
        vote INTEGER NOT NULL,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS ticket (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        question TEXT NOT NULL,
        intent TEXT,
        count INTEGER DEFAULT 1,
        status TEXT DEFAULT 'open',
        last_ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS kb_extra (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        key TEXT NOT NULL,
        cat TEXT,
        q TEXT,
        k TEXT,
        a TEXT,
        src TEXT,
        enabled INTEGER DEFAULT 1
      );
    `);
    migrate();
    backend = "sqlite";
  } catch (e) {
    backend = "memory";
    console.warn("[db] node:sqlite 不可用，降级为内存存储（数据不跨进程持久化）：" + e.message);
  }
}

/**
 * 轻量迁移：为已存在的旧库补齐后续版本新增的列。
 * 演示项目最怕"升级代码就必须删库"，那会导致历史演示数据丢失；
 * 这里用 PRAGMA 读现有列并补齐缺失项，保证任何旧库都能平滑升级。
 */
function migrate() {
  const ensureColumn = (table, column, decl) => {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (cols.indexOf(column) < 0) {
      sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      console.log("[db] 已为 " + table + " 补充列 " + column);
    }
  };
  ensureColumn("qa_log", "latency_answer", "INTEGER");
  ensureColumn("qa_log", "degraded", "INTEGER DEFAULT 0");
  ensureColumn("qa_log", "error", "TEXT");
}

/* ---------- 写入 ---------- */
function logQA(row) {
  const r = {
    ts: Date.now(), session: row.session || null, role: row.role || null,
    question: row.question || "", answer: row.answer || "", intent: row.intent || null,
    strategy: row.strategy || null, top_score: num(row.topScore), confidence: num(row.confidence),
    hit: row.hit ? 1 : 0, sources: JSON.stringify(row.sources || []),
    latency_first: num(row.latencyFirst), latency_answer: num(row.latencyAnswer),
    latency_total: num(row.latencyTotal),
    degraded: row.degraded ? 1 : 0, error: row.error || null,
  };
  if (backend === "sqlite") {
    const st = sqliteDb.prepare(`INSERT INTO qa_log
      (ts,session,role,question,answer,intent,strategy,top_score,confidence,hit,sources,latency_first,latency_answer,latency_total,degraded,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const info = st.run(r.ts, r.session, r.role, r.question, r.answer, r.intent, r.strategy,
      r.top_score, r.confidence, r.hit, r.sources, r.latency_first, r.latency_answer, r.latency_total, r.degraded, r.error);
    return Number(info.lastInsertRowid);
  }
  return memRun("qa", r);
}

function logFeedback(row) {
  const r = { ts: Date.now(), qa_id: num(row.qaId), session: row.session || null, vote: row.vote ? 1 : 0, note: row.note || null };
  if (backend === "sqlite") {
    const info = sqliteDb.prepare(`INSERT INTO feedback (ts,qa_id,session,vote,note) VALUES (?,?,?,?,?)`)
      .run(r.ts, r.qa_id, r.session, r.vote, r.note);
    return Number(info.lastInsertRowid);
  }
  return memRun("feedback", r);
}

/** 未命中问题累积为工单：同一问题只累加次数（这就是看板里的"知识盲区排行榜"） */
function upsertTicket(row) {
  const q = (row.question || "").trim();
  if (!q) return null;
  const now = Date.now();
  if (backend === "sqlite") {
    const found = sqliteDb.prepare(`SELECT id,count FROM ticket WHERE question = ?`).get(q);
    if (found) {
      sqliteDb.prepare(`UPDATE ticket SET count = count + 1, last_ts = ? WHERE id = ?`).run(now, found.id);
      return found.id;
    }
    const info = sqliteDb.prepare(`INSERT INTO ticket (ts,question,intent,count,status,last_ts) VALUES (?,?,?,1,'open',?)`)
      .run(now, q, row.intent || null, now);
    return Number(info.lastInsertRowid);
  }
  const found = mem.ticket.find(t => t.question === q);
  if (found) { found.count++; found.last_ts = now; return found.id; }
  return memRun("ticket", { ts: now, question: q, intent: row.intent || null, count: 1, status: "open", last_ts: now });
}

function saveKbEntry(row) {
  const r = {
    ts: Date.now(), key: row.id || ("kb_" + Date.now()), cat: row.cat || "后台新增", q: row.q || "",
    k: JSON.stringify(row.k || []), a: row.a || "", src: row.src || "运营后台录入", enabled: row.enabled === false ? 0 : 1,
  };
  if (backend === "sqlite") {
    const exist = sqliteDb.prepare(`SELECT id FROM kb_extra WHERE key = ?`).get(r.key);
    if (exist) {
      sqliteDb.prepare(`UPDATE kb_extra SET cat=?,q=?,k=?,a=?,src=?,enabled=? WHERE key=?`)
        .run(r.cat, r.q, r.k, r.a, r.src, r.enabled, r.key);
      return exist.id;
    }
    const info = sqliteDb.prepare(`INSERT INTO kb_extra (ts,key,cat,q,k,a,src,enabled) VALUES (?,?,?,?,?,?,?,?)`)
      .run(r.ts, r.key, r.cat, r.q, r.k, r.a, r.src, r.enabled);
    return Number(info.lastInsertRowid);
  }
  const found = mem.kb.find(k => k.key === r.key);
  if (found) { Object.assign(found, r); return found.id; }
  return memRun("kb", r);
}

function deleteKbEntry(key) {
  if (backend === "sqlite") {
    sqliteDb.prepare(`DELETE FROM kb_extra WHERE key = ?`).run(key);
    return true;
  }
  const i = mem.kb.findIndex(k => k.key === key);
  if (i >= 0) { mem.kb.splice(i, 1); return true; }
  return false;
}

function listKbExtra() {
  if (backend === "sqlite") {
    return sqliteDb.prepare(`SELECT * FROM kb_extra ORDER BY ts DESC`).all().map(rowToKb);
  }
  return mem.kb.slice().reverse().map(rowToKb);
}

function rowToKb(r) {
  let k = [];
  try { k = JSON.parse(r.k || "[]"); } catch (e) { k = []; }
  return { id: r.key, cat: r.cat, q: r.q, k: k, a: r.a, src: r.src, enabled: !!r.enabled, extra: true };
}

/* ---------- 看板聚合查询 ---------- */
function analytics() {
  if (backend === "sqlite") {
    const q1 = (sql, ...p) => sqliteDb.prepare(sql).all(...p);
    const g = (sql, ...p) => sqliteDb.prepare(sql).get(...p);
    const total = g(`SELECT COUNT(*) n FROM qa_log WHERE role='user'`) || { n: 0 };
    const sessions = g(`SELECT COUNT(DISTINCT session) n FROM qa_log`) || { n: 0 };
    const hit = g(`SELECT COUNT(*) n FROM qa_log WHERE role='user' AND hit=1`) || { n: 0 };
    const degraded = g(`SELECT COUNT(*) n FROM qa_log WHERE degraded=1`) || { n: 0 };
    const care = g(`SELECT COUNT(*) n FROM qa_log WHERE intent='情绪安抚'`) || { n: 0 };
    const lat = g(`SELECT AVG(latency_first) f, AVG(latency_answer) a, AVG(latency_total) t FROM qa_log WHERE latency_total IS NOT NULL`) || {};
    const fb = g(`SELECT SUM(vote) up, COUNT(*) n FROM feedback`) || { up: 0, n: 0 };
    const top = q1(`SELECT question q, COUNT(*) n FROM qa_log WHERE role='user' GROUP BY question ORDER BY n DESC LIMIT 10`);
    const intent = q1(`SELECT COALESCE(intent,'未识别') name, COUNT(*) value FROM qa_log WHERE role='user' GROUP BY intent ORDER BY value DESC LIMIT 12`);
    const hours = q1(`SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) h, COUNT(*) n
                      FROM qa_log WHERE role='user' GROUP BY h ORDER BY h`);
    const days = q1(`SELECT date(ts/1000,'unixepoch','localtime') d, COUNT(*) n FROM qa_log WHERE role='user' GROUP BY d ORDER BY d DESC LIMIT 7`);
    const strategy = q1(`SELECT COALESCE(strategy,'-') name, COUNT(*) value FROM qa_log WHERE role='user' GROUP BY strategy ORDER BY value DESC`);
    const tickets = q1(`SELECT question q, count n, intent, status FROM ticket ORDER BY count DESC, last_ts DESC LIMIT 12`);
    const misses = q1(`SELECT question q, ts FROM qa_log WHERE role='user' AND hit=0 ORDER BY ts DESC LIMIT 12`);
    const scores = q1(`SELECT top_score s FROM qa_log WHERE role='user' AND top_score IS NOT NULL ORDER BY ts DESC LIMIT 200`);
    const answers = q1(`SELECT latency_total t FROM qa_log WHERE latency_total IS NOT NULL ORDER BY ts DESC LIMIT 200`);
    const roles = q1(`SELECT COALESCE(role,'-') name, COUNT(*) value FROM qa_log WHERE role='user' GROUP BY role`);
    return {
      storage: backend,
      totals: {
        questions: total.n, sessions: sessions.n, hits: hit.n, care: care.n,
        hitRate: total.n ? +(hit.n / total.n * 100).toFixed(1) : 0,
        degraded: degraded.n,
        /* 两个延迟指标必须分开，否则会把"模型先决定调工具"的耗时误当成用户等待：
           avgFirst  = 从提问到"任何输出"（含工具调用决策轮），反映链路整体反应
           avgAnswer = 从提问到"最终答案的第一个字"，才是用户真正感知的等待 */
        avgFirst: lat.f ? Math.round(lat.f) : 0,
        avgAnswer: lat.a ? Math.round(lat.a) : 0,
        avgTotal: lat.t ? Math.round(lat.t) : 0,
        satisfy: fb.n ? +(fb.up / fb.n * 100).toFixed(1) : null,
        feedbacks: fb.n,
      },
      top, intent, hours, days: days.reverse(), strategy, tickets, misses,
      scoreDist: bucketScores(scores.map(x => x.s)),
      latencyDist: bucketLatency(answers.map(x => x.t)),
      roles,
    };
  }
  /* 内存模式：用与 SQLite 相同的结构在 JS 里聚合，保证前端代码只有一套 */
  const users = mem.qa.filter(r => r.role === "user");
  const total = users.length;
  const hit = users.filter(r => r.hit).length;
  const care = users.filter(r => r.intent === "情绪安抚").length;
  const sessions = new Set(mem.qa.map(r => r.session).filter(Boolean)).size;
  const latFirst = users.map(r => r.latency_first).filter(v => v != null);
  const latAnswer = users.map(r => r.latency_answer).filter(v => v != null);
  const latTotal = users.map(r => r.latency_total).filter(v => v != null);
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const group = (arr, keyFn) => {
    const m = new Map();
    arr.forEach(r => { const k = keyFn(r); if (k == null) return; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].map(([name, value]) => ({ name, value }));
  };
  const topMap = new Map();
  users.forEach(r => topMap.set(r.question, (topMap.get(r.question) || 0) + 1));
  const fbUp = mem.feedback.filter(f => f.vote).length;
  return {
    storage: backend,
    totals: {
      questions: total, sessions, hits: hit, care,
      hitRate: total ? +(hit / total * 100).toFixed(1) : 0,
      degraded: mem.qa.filter(r => r.degraded).length,
      avgFirst: avg(latFirst), avgAnswer: avg(latAnswer), avgTotal: avg(latTotal),
      satisfy: mem.feedback.length ? +(fbUp / mem.feedback.length * 100).toFixed(1) : null,
      feedbacks: mem.feedback.length,
    },
    top: [...topMap.entries()].map(([q, n]) => ({ q, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    intent: group(users, r => r.intent || "未识别").sort((a, b) => b.value - a.value).slice(0, 12),
    hours: group(users, r => new Date(r.ts).getHours()).map(x => ({ h: +x.name, n: x.value })).sort((a, b) => a.h - b.h),
    days: group(users, r => new Date(r.ts).toLocaleDateString("sv")).map(x => ({ d: x.name, n: x.value })).slice(-7),
    strategy: group(users, r => r.strategy || "-").sort((a, b) => b.value - a.value),
    tickets: mem.ticket.slice().sort((a, b) => b.count - a.count).slice(0, 12).map(t => ({ q: t.question, n: t.count, intent: t.intent, status: t.status })),
    misses: users.filter(r => !r.hit).slice(-12).reverse().map(r => ({ q: r.question, ts: r.ts })),
    scoreDist: bucketScores(users.map(r => r.top_score).filter(v => v != null).slice(-200)),
    latencyDist: bucketLatency(latTotal.slice(-200)),
    roles: group(users, r => r.role || "-"),
  };
}

function bucketScores(arr) {
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
  const labels = ["0~0.2", "0.2~0.4", "0.4~0.6", "0.6~0.8", "0.8~1.0"];
  const out = labels.map(name => ({ name, value: 0 }));
  arr.forEach(s => {
    for (let i = 0; i < labels.length; i++) if (s >= edges[i] && s < edges[i + 1]) { out[i].value++; break; }
  });
  return out;
}

function bucketLatency(arr) {
  const edges = [0, 500, 1000, 2000, 4000, 8000, Infinity];
  const labels = ["<0.5s", "0.5~1s", "1~2s", "2~4s", "4~8s", ">8s"];
  const out = labels.map(name => ({ name, value: 0 }));
  arr.forEach(v => {
    for (let i = 0; i < labels.length; i++) if (v >= edges[i] && v < edges[i + 1]) { out[i].value++; break; }
  });
  return out;
}

function reset() {
  if (backend === "sqlite") {
    sqliteDb.exec(`DELETE FROM qa_log; DELETE FROM feedback; DELETE FROM ticket;`);
    return true;
  }
  mem.qa.length = 0; mem.feedback.length = 0; mem.ticket.length = 0;
  return true;
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { init, logQA, logFeedback, upsertTicket, saveKbEntry, deleteKbEntry, listKbExtra, analytics, reset, backend: () => backend };
