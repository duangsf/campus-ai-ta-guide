/* ============================================================
 * v2 旗舰版 · 应用编排
 *
 * 职责：
 *  1. 组装各视图模块（对话 / 2.5D 地图 / 3D 沙盘 / 知识图谱 / 看板 / 评测）
 *  2. 维护全局上下文 ctx，让模块之间能互相联动
 *     （例：对话里调用 navigate_to → 地图自动飞行并画路线；
 *            点击 3D 沙盘楼宇 → 2.5D 地图同步选中）
 *  3. 配置管理（模式 / API Key / 模型 / 语音），只存本机 localStorage
 *  4. 启动自检：读 /api/health 判断后端与存储模式，并如实显示在徽标上
 * ============================================================ */

import { $, $$, el, esc, toast, api, readStore, writeStore, fmtMs } from "./util.js";
import { Avatar } from "./avatar.js";
import { TraceView } from "./trace.js";
import { ChatView } from "./chat.js";
import { CampusMap } from "./map.js";
import { Campus3D } from "./globe.js";
import { GraphView } from "./graph.js";
import { Dashboard } from "./dash.js";
import { EvalPanel } from "./eval.js";

const QUICK_BASE = [
  "现在还能去哪里自习？", "从宿舍到图书馆怎么走？", "新生报到要带什么材料？",
  "宿舍能洗澡吗，有热水吗？", "食堂几点开饭？", "补办学生证要什么材料？",
  "奖学金怎么评定？", "心情不好、晚上睡不着，可以找谁聊？", "学费一时交不上怎么办？",
];
/* 演示"服务范围边界"与"诚实拒答"的探针问题，放在快捷区末尾，
   现场可直接点，用来证明系统不会编造答案。 */
const QUICK_PROBES = [
  "今天食堂的午饭菜单有什么菜？",   // 知识库不可能收录 → 演示诚实拒答 + 自动建工单
  "帮我写一段 Python 快排代码",     // 域外意图 → 演示服务范围边界
];

const DEFAULT_CONFIG = {
  mode: "auto",
  apiKey: "",
  model: "DeepSeek-V4-Flash",
  tts: true,
  /* 极速模式：浏览器先本地预检索并把命中知识注入提示词，
     让模型无需先"决定去查资料"就能直接作答 —— 换取的收益是**知识注入确定发生**，
     而不是依赖模型的工具调用决策（模型偶尔会跳过检索直接凭记忆回答）。
     注意：实测上游模型延迟波动较大（1.5~7 秒），因此不应宣传"一定更快"；
     它的真正价值是"知识注入可控 + 链路更短 + 少一次工具调用的额度消耗"。 */
  fastMode: false,
  voiceFemale: "",
  voiceMale: "",
  role: "female",
};

class App {
  constructor() {
    this.config = Object.assign({}, DEFAULT_CONFIG, readStore("v2_config", {}));
    this.session = readStore("v2_session", "") || (Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    writeStore("v2_session", this.session);
    this.health = null;
    this.views = new Map();
    this.current = "chat";
    this.lastAnswer = null;

    /* 统一的上下文对象：模块之间只通过它通信，避免互相直接引用 */
    this.ctx = {
      config: this.config,
      session: this.session,
      getRole: () => this.role,
      useCloud: () => this.useCloud(),
      setStatus: (k, t) => this.setStatus(k, t),
      onQuestion: () => this.onQuestion(),
      afterAnswer: (info) => this.afterAnswer(info),
      applyToolDetail: (d) => this.applyToolDetail(d),
      focusPlace: (id, fromId) => this.focusPlace(id, fromId),
      onPickPlace: (id) => this.onPickPlace(id),
      avatar: null,
      trace: null,
    };
  }

  get role() { return this.config.role === "male" ? "male" : "female"; }

  /** 是否走云端 Agent：mode 决定策略，无 Key 则自动降级本地 */
  useCloud() {
    if (this.config.mode === "local") return false;
    const hasKey = !!this.config.apiKey || !!(this.health && this.health.hasEnvKey);
    if (this.config.mode === "cloud") return hasKey;
    return hasKey;    // auto
  }

  /* ══════════════ 启动 ══════════════ */
  async start() {
    this.ctx.avatar = new Avatar();
    this.ctx.trace = new TraceView();

    this.chat = new ChatView(this.ctx);
    this.map = new CampusMap(this.ctx);
    this.globe = new Campus3D(this.ctx);
    this.graph = new GraphView(this.ctx);
    this.dash = new Dashboard(this.ctx);
    this.evalPanel = new EvalPanel(this.ctx);

    this._bindNav();
    this._bindHeader();
    this._bindSettings();
    this._bindRole();

    await this.checkHealth();
    this.applyRole(this.role, true);
    this.chat.renderQuick(QUICK_BASE);
    this._renderStageStats();
    this.setStatus("idle", this.useCloud() ? "在线，随时为你服务" : "本地知识库模式就绪");

    const boot = $("boot");
    const app = $("app");
    if (app) app.hidden = false;
    /* 元素从 hidden 变为可见后才有布局尺寸，此时必须重新测量画布 */
    this.ctx.avatar.refresh();
    if (boot) {
      boot.classList.add("done");
      setTimeout(() => boot.remove(), 550);
    }
    setTimeout(() => this.ctx.avatar.refresh(), 240);
    this.welcome();
  }

  /* ══════════════ 健康检查与模式徽标 ══════════════ */
  async checkHealth() {
    const badge = $("modeBadge");
    try {
      this.health = await api("/api/health");
      if (this.useCloud()) {
        badge.className = "badge online";
        badge.textContent = "☁️ 云端 Agent 模式";
      } else {
        badge.className = "badge offline";
        badge.textContent = this.health.hasEnvKey ? "📦 本地知识库（可切云端）" : "📦 本地知识库 · 离线可用";
      }
      const st = $("setModel");
      if (st && !st.value) st.placeholder = this.health.model || DEFAULT_CONFIG.model;
      if (this.health.storage === "memory") {
        badge.title = "Node 版本不支持 node:sqlite，看板数据不跨进程持久化";
      }
    } catch (e) {
      this.health = null;
      /* 直接双击 index.html 时没有后端：如实标注为纯前端离线模式 */
      badge.className = "badge offline";
      badge.textContent = "📦 纯前端离线模式";
      badge.title = "未连接后端：检索与问答在本机浏览器内完成，看板与评测不可用";
    }
  }

  _updateBadge() {
    const badge = $("modeBadge");
    if (!badge) return;
    if (this.useCloud()) {
      badge.className = "badge online";
      badge.textContent = "☁️ 云端 Agent 模式";
    } else {
      badge.className = "badge offline";
      badge.textContent = "📦 本地知识库 · 离线可用";
    }
  }

  /* ══════════════ 视图切换 ══════════════ */
  _bindNav() {
    $$(".navBtn").forEach(btn => {
      btn.onclick = () => this.switchView(btn.getAttribute("data-view"));
    });
  }

  switchView(name) {
    if (!name || name === this.current) return;
    $$(".navBtn").forEach(b => b.classList.toggle("active", b.getAttribute("data-view") === name));
    $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
    this.current = name;

    const titles = {
      chat: ["智慧校园问答助手", "语音 / 文字均可 · 三路融合检索 · 答案带来源 · 支持多轮追问"],
      map: ["2.5D 交互式校园地图", "拖拽缩放 · 点击楼宇 · 问路自动生成路线 · 实时开放状态"],
      globe: ["3D 校园沙盘", "数据与 2.5D 地图同源 · 支持昼夜切换与视角漫游"],
      graph: ["校园知识图谱", "多跳检索的数据底座 · 实体链接与关系扩散可视化"],
      dash: ["运营数据看板", "来自服务端 sqlite 的真实问答日志，而非浏览器本地模拟"],
      eval: ["检索策略消融评测", "同一评测集下四种策略的量化对比，含闸门带来的可用性代价"],
    };
    const t = titles[name] || titles.chat;
    const tEl = $("panelTitle"), hEl = $("panelHint");
    if (tEl) tEl.textContent = t[0];
    if (hEl) hEl.textContent = t[1];

    if (name === "map") this.map.renderStatus();
    if (name === "globe") this.globe.show();
    if (name === "graph") this.graph.show();
    if (name === "dash") this.dash.show();
    if (name === "eval") this.evalPanel.show();
  }

  /* ══════════════ 头部与状态 ══════════════ */
  _bindHeader() {
    const set = $("btnSet");
    if (set) set.onclick = () => this.openSettings();
  }

  setStatus(kind, text) {
    const chip = $("statusChip"), t = $("statusText");
    if (!chip || !t) return;
    chip.className = "statusChip" + (kind && kind !== "idle" ? " " + kind : "");
    t.textContent = text;
  }

  /** 舞台下方的实时统计条：让"系统在做什么"始终可见 */
  _renderStageStats() {
    const box = $("stageStats");
    if (!box) return;
    const idx = (window.RAG && window.RAG.indexStats) ? window.RAG.indexStats() : {};
    const parts = [
      "知识条目 <b>" + (idx.entries || 0) + "</b>",
      "图谱 <b>" + (idx.entities || 0) + "/" + (idx.relations || 0) + "</b>",
      "工具 <b>" + (window.RAG && window.RAG.toolSpecs ? window.RAG.toolSpecs().length : 0) + "</b>",
      this.health && this.health.storage === "sqlite" ? "存储 <b>sqlite</b>" : "存储 <b>local</b>",
    ];
    box.innerHTML = parts.map(p => "<span>" + p + "</span>").join("");
  }

  /* ══════════════ 角色切换 ══════════════ */
  _bindRole() {
    $$(".roleBtn").forEach(btn => {
      btn.onclick = () => this.applyRole(btn.getAttribute("data-role"));
    });
  }

  applyRole(role, silent) {
    this.config.role = role === "male" ? "male" : "female";
    writeStore("v2_config", this.config);
    $$(".roleBtn").forEach(b => b.classList.toggle("active", b.getAttribute("data-role") === this.config.role));
    this.ctx.avatar.setRole(this.config.role);
    const meta = this.config.role === "male"
      ? { n: "小航", tag: "校园事务助手" }
      : { n: "小岚", tag: "学生服务助手" };
    const tEl = $("panelTitle");
    if (tEl && this.current === "chat") tEl.textContent = meta.tag;
    if (!silent) {
      this.chat.setTip("已切换为" + meta.n + "（" + meta.tag + "），音色与形象同步切换");
      this.ctx.avatar.setEmotion("happy");
      if (this.config.tts) this.chat.speech.speak("我是" + meta.n + "，" + meta.tag + "，有什么可以帮你？");
    }
  }

  /* ══════════════ 欢迎语 ══════════════ */
  welcome() {
    const name = this.role === "male" ? "小航" : "小岚";
    const mode = this.useCloud() ? "云端大模型" : "本地知识库";
    const text =
      "你好，我是 **" + name + "**，河北传媒学院的校园 AI 导览助教。\n\n" +
      "我能做什么：\n" +
      "- **校园问答**：报到流程、校区地址、图书馆开放时间、宿舍条件、奖助资助、办事流程\n" +
      "- **实时查询**：问我「现在还能去哪里自习」，我会按当前时间算出还开着的场所\n" +
      "- **地图导航**：问我「从宿舍到图书馆怎么走」，我会在校园地图上画出路线与步行时间\n" +
      "- **办事指引**：补办学生证、开在读证明、请假、报修，给你材料清单和办理步骤\n\n" +
      "当前模式：**" + mode + "**。" +
      (this.useCloud()
        ? "检索过程会在右侧「RAG 链路」抽屉里实时展开，可以随时点开看。"
        : "没有配置 API Key，我直接用本机知识库回答 —— 完全离线也能演示。") +
      "\n\n试着问我一个问题吧，也可以点下面的快捷提问。";

    const { bubble } = this.chat.appendBot();
    setTimeout(() => {
      this.chat.renderMarkdown(bubble, text);
      this._renderStageStats();
    }, 280);
  }

  /* ══════════════ 问答应答钩子 ══════════════ */
  onQuestion() {
    this.ctx.avatar.setEmotion("thinking");
  }

  afterAnswer(info) {
    this.lastAnswer = info;
    this._renderStageStats();
    /* 本地模式下地图/图谱可能要同步刷新（工具不会走服务端） */
    if (info.local && this.current === "map") this.map.renderStatus();
  }

  /** 工具返回的结构化数据 → 驱动地图/3D 联动 */
  applyToolDetail(detail) {
    if (!detail) return;
    if (detail.navigate && detail.navigate.to) {
      const nav = detail.navigate;
      if (this.map) {
        this.map.showRoute(nav.from, nav.to);
        if (this.current !== "map") {
          toast("已在地图上生成导航路线，点击左侧「地图」查看", "ok");
          /* 不强制切视图，避免打断对话阅读；但徽标上做提示 */
          const btn = $$(".navBtn").find(b => b.getAttribute("data-view") === "map");
          if (btn) {
            btn.style.borderColor = "var(--cyan)";
            setTimeout(() => { btn.style.borderColor = ""; }, 2600);
          }
        }
      }
      if (this.globe && this.globe.ready) this.globe.focusPlace(nav.to);
    }
    if (detail.status && detail.status.list) {
      if (this.map) this.map.renderStatus();
    }
    if (detail.retrieval || detail.graph) {
      if (this.graph) this.graph.show();
    }
  }

  focusPlace(placeId, fromId) {
    this.switchView("map");
    if (fromId) this.map.showRoute(fromId, placeId);
    else this.map.focusPlace(placeId, true);
  }

  onPickPlace(placeId) {
    /* 3D 沙盘选中后，同步 2.5D 地图的选中与详情卡，保持两屏一致 */
    if (this.map) {
      this.map.highlight(placeId);
      this.map.select(placeId, false);
    }
  }

  /* ══════════════ 设置 ══════════════ */
  _bindSettings() {
    const save = $("btnSave"), cancel = $("btnCancel");
    if (save) save.onclick = () => this.saveSettings();
    if (cancel) cancel.onclick = () => this.closeSettings();
    const modal = $("modal");
    if (modal) modal.addEventListener("click", e => { if (e.target === modal) this.closeSettings(); });
    const keyHint = $("keyHint");
    if (keyHint) {
      keyHint.textContent = "Key 仅保存在本机浏览器 localStorage，不会写入代码仓库；" +
        "若通过 node server/server.js 启动，也可改用环境变量 DEEPSEEK_API_KEY。";
    }
  }

  openSettings() {
    $("setMode").value = this.config.mode;
    $("setKey").value = this.config.apiKey || "";
    $("setModel").value = this.config.model || "";
    $("setTts").value = String(this.config.tts);
    const fast = $("setFast");
    if (fast) fast.value = String(!!this.config.fastMode);
    this._fillVoices("setVoiceF", this.config.voiceFemale);
    this._fillVoices("setVoiceM", this.config.voiceMale);
    $("modal").classList.add("show");
  }

  closeSettings() { $("modal").classList.remove("show"); }

  _fillVoices(selId, current) {
    const sel = $(selId);
    if (!sel) return;
    sel.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "自动（按角色匹配清亮音色）";
    sel.appendChild(auto);
    if (!window.speechSynthesis) return;
    const voices = (window.speechSynthesis.getVoices() || []).filter(v => /zh|Chinese|中文/i.test(v.lang + v.name));
    let matched = false;
    voices.forEach(v => {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = v.name;
      if (current === v.name) { o.selected = true; matched = true; }
      sel.appendChild(o);
    });
    if (!matched) sel.value = "";
  }

  saveSettings() {
    this.config.mode = $("setMode").value;
    this.config.apiKey = $("setKey").value.trim();
    this.config.model = $("setModel").value.trim() || DEFAULT_CONFIG.model;
    this.config.tts = $("setTts").value === "true";
    const fast = $("setFast");
    if (fast) this.config.fastMode = fast.value === "true";
    this.config.voiceFemale = $("setVoiceF").value;
    this.config.voiceMale = $("setVoiceM").value;
    writeStore("v2_config", this.config);
    this.closeSettings();
    this._updateBadge();
    toast(this.useCloud() ? "已切换到云端 Agent 模式" : "已切换到本地知识库模式", "ok");
    this.chat.setTip(this.useCloud()
      ? (this.config.fastMode
        ? "极速模式：先本地检索再注入知识，只走一轮模型往返，链路更短"
        : "Agent 模式：检索与工具调用在服务端 Agent 循环中执行，RAG 链路可在右侧抽屉查看")
      : "本地模式：全部推理在本机浏览器完成，断网可用");
  }
}

/* ══════════════ 启动 ══════════════ */
const app = new App();
window.__app = app;   // 便于控制台调试与自动化测试

/* 语音音色列表在部分浏览器是异步加载的，加载完成后若设置面板开着则刷新 */
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    const modal = $("modal");
    if (modal && modal.classList.contains("show")) {
      app._fillVoices("setVoiceF", app.config.voiceFemale);
      app._fillVoices("setVoiceM", app.config.voiceMale);
    }
  };
}

window.addEventListener("error", (e) => {
  console.error("[app error]", e.error || e.message);
});

app.start().catch(e => {
  console.error("[启动失败]", e);
  const boot = $("boot");
  if (boot) {
    boot.innerHTML = '<div class="boot-box"><div class="boot-title">启动失败</div>' +
      '<div class="boot-sub">' + esc(e.message || String(e)) + '</div></div>';
  }
});

export { app };
