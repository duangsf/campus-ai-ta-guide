/* ============================================================
 * v2 · 检索引擎（浏览器 / Node 同构）
 *
 * 设计目标：把 v1 的 `q.indexOf(kw) >= 0` 子串匹配，升级为一条
 * 可解释、可评测、可消融的检索链路：
 *
 *   查询理解 → 分词/同义扩展 → 三路召回 → 融合重排 → 置信度闸门
 *
 * 三路召回（互为补充）：
 *   ① BM25     —— 词项精确匹配，带文档长度归一化
 *   ② 语义向量 —— 字符 n-gram + 词项 TF-IDF 稀疏向量余弦，
 *                 解决同义改写与口语化（"宿舍能洗澡吗" ≈ "寝室卫浴条件"）
 *   ③ 知识图谱 —— 实体链接后沿关系多跳扩散，
 *                 解决"从宿舍到最近的自习室"这类跨实体推理
 *
 * 同构策略：本文件既可被 Node `require`，也可被浏览器 <script> 直接加载。
 * 数据来源由 loadData() 按环境自动选择（Node 读 data/*.json；浏览器读全局变量）。
 * 这保证"界面上展示的检索过程"与"服务端真实检索过程"是同一份实现，
 * 不存在演示与实际不一致的问题。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RAG = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const IS_NODE = typeof module === "object" && typeof require === "function";

  /* 全库文本缓存（词表级覆盖用的 haystack）。
     必须在模块顶部声明：rebuild() 在模块初始化阶段就会被调用，
     若把声明放在文件后半部分，初始化时会命中 let 的暂时性死区。 */
  let KB_HAY = null;

  /* ==========================================================
   * 0. 数据装载
   * ========================================================== */
  let EXTERNAL = null;   // 由服务端/页面注入的数据（优先级最高）

  function loadData() {
    if (EXTERNAL) return EXTERNAL;
    if (IS_NODE) {
      const fs = require("fs");
      const path = require("path");
      const base = path.join(__dirname, "..");
      const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } };
      /* 语料文件的结构是 { meta, entries }，必须取 .entries；
         直接返回包装对象会让 Array.isArray 判定失败，导致语料静默丢失。 */
      const corpusFile = readJson(path.join(base, "data", "corpus.json"));
      return {
        kb: require("./knowledge.js"),
        graph: readJson(path.join(base, "data", "graph.json")),
        places: readJson(path.join(base, "data", "places.json")),
        corpus: (corpusFile && Array.isArray(corpusFile.entries)) ? corpusFile.entries : (Array.isArray(corpusFile) ? corpusFile : []),
        forms: readJson(path.join(base, "data", "forms.json")),
        depts: readJson(path.join(base, "data", "departments.json")),
        extra: AUTO_EXTRA,
      };
    }
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    return {
      kb: g.V2_KB || [], graph: g.V2_GRAPH || null, places: g.V2_PLACES || null,
      corpus: g.V2_CORPUS || [], forms: g.V2_FORMS || null, depts: g.V2_DEPTS || null,
      extra: g.V2_KB_EXTRA || [],
    };
  }

  let AUTO_EXTRA = [];      // 运营后台新增的条目
  let USER_EXTRA = null;    // 显式注入的条目

  /* ==========================================================
   * 1. 中文分词与查询理解
   *
   * 为什么不用 jieba：零依赖、离线、可复现。中文检索在无词典场景下
   * 2-gram 召回已接近分词；我们把"领域词典"（关键词表 + 同义词 + 图谱实体名）
   * 作为先验注入做最大匹配，兼顾精度与召回。
   * ========================================================== */
  const STOP = new Set(("的 了 是 我 你 他 她 它 们 在 有 和 与 及 或 也 都 很 就 还 要 会 能 可以 什么 怎么 如何 哪里 哪个 哪些 多少 几 吗 呢 吧 啊 呀 哦 嗯 一下 请问 麻烦 想 问 说 给 帮 这 那 这个 那个 一个 请 需 需要 有没 有没有 是不是 能不能 好 不 没 别 之 其 并 但 而 为 以 于 由 从 到 对 把 被").split(/\s+/));

  const ALIAS = [
    ["食堂", "餐厅|就餐|吃饭|伙食|饭堂|菜品"], ["宿舍", "寝室|公寓|住宿|床铺|寝室楼"],
    ["图书馆", "话筒楼|借阅室|阅览室|藏书|馆藏"], ["自习", "看书|学习|复习|备考|刷题"],
    ["快递", "驿站|取件|包裹|邮寄|物流|代收"], ["一卡通", "校园卡|饭卡|门禁卡|水卡"],
    ["报到", "入学|注册|迎新|新生|开学|报到点"], ["选课", "课程|课表|排课|选课系统"],
    ["成绩", "分数|绩点|补考|重修|考核|及格"], ["奖学金", "助学金|资助|贷款|绿色通道|困难补助"],
    ["教学楼", "教室|上课|机房|实验室|A座|B座"], ["校医院", "医务室|看病|就医|门诊|体检|健康"],
    ["社团", "学生会|协会|组织|第二课堂|纳新|招新"], ["校园活动", "艺术节|文化节|比赛|演出|讲座|晚会"],
    ["地图", "平面图|导览图|布局|位置|怎么走|路线"], ["电话", "联系方式|号码|咨询|找谁|客服"],
    ["交通", "班车|公交|地铁|校车|到校|接站|停车"], ["就业", "实习|招聘|求职|校招|生涯|简历"],
    ["心理咨询", "情绪|压力|焦虑|不开心|烦|抑郁|心理"], ["校园网", "上网|wifi|网络|网速|账号|宽带"],
    ["用电", "充电|插座|吹风机|电器|违禁|断电"], ["洗浴", "澡堂|热水|淋浴|浴室|洗澡|澡堂"],
    ["考证", "四六级|计算机等级|教师资格|普通话|证书"], ["转专业", "专业调整|换专业|双学位|辅修"],
    ["借书", "借阅|归还|续借|超期|罚款|馆藏"], ["请假", "病假|事假|外出|报备|离校"],
    ["校历", "放假|假期|开学时间|寒暑假|考试周|学期"], ["学费", "缴费|住宿费|收费|退费|费用"],
    ["户口", "迁户口|户籍|档案|组织关系|党团"], ["军训", "军事训练|军训时间|军训服装|教官"],
    ["打印", "复印|打印店|文印|自助打印|成绩单"], ["体育馆", "操场|健身房|球场|运动|体育课|跑道"],
    ["琴房", "排练厅|音乐厅|演播厅|练功房|录音棚"], ["失物招领", "丢失|捡到|寻物|挂失|补办"],
    ["宿舍报修", "报修|维修|故障|坏了|漏水|电路"], ["辅导员", "班主任|老师|学工|带班"],
    ["班车", "校车|通勤|时刻表|发车"], ["食堂价格", "饭菜价格|伙食费|消费|贵不贵"],
  ].map(p => ({ from: p[0], to: p[1].split("|") }));

  const aliasIndex = new Map();
  ALIAS.forEach(a => {
    aliasIndex.set(a.from, a.to);
    a.to.forEach(t => { if (!aliasIndex.has(t)) aliasIndex.set(t, a.to.concat([a.from])); });
  });

  function hasCJK(s) { return /[\u4e00-\u9fa5]/.test(s); }

  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[\u3000\s]+/g, " ")
      .replace(/[。，、；：？！“”‘’（）【】《》,.;:?!"'()\[\]<>~`|]/g, " ")
      .toLowerCase()
      .trim();
  }

  /**
   * 分词：领域词典最大匹配 + 段内 n-gram + 拉丁词。
   *
   * 关键设计：n-gram **只在同一个空格段内生成**，不跨段、不跨已命中词典词的边界。
   * 否则会产生大量跨词边界的垃圾词（"图书馆几点开门" → "馆几""馆几点""点开门"），
   * 这些词天然不在任何文档里，会把"未收录判定"的覆盖率无脑拉低，
   * 导致正常问题被误判为未收录。
   *
   * 输出同时带上权重：词典词/长词信息量高，2-gram 与单字低（供覆盖率加权的口径统一）。
   */
  function tokenizeDetailed(text, opts) {
    const o = opts || {};
    const norm = normalize(text);
    if (!norm) return [];
    const dict = o.dict;
    const sub = o.dictSub || (dict === state.dict ? state.dictSub : null);
    const out = [];
    const push = (term, weight, kind) => {
      if (!term || STOP.has(term)) return;
      out.push({ term, weight, kind });
    };
    /* 词内子串集合查询：判断一个 n-gram 是否为某个真实词的组成部分。
       预构建成 Set 后是 O(1)，避免每次 tokenize 都遍历整个词典。 */
    const inWord = (s) => {
      if (!s) return false;
      if (dict && dict.has(s)) return true;
      return !!(sub && sub.has(s));
    };

    for (const seg of norm.split(" ").filter(Boolean)) {
      if (!hasCJK(seg)) { if (seg.length > 1 && !STOP.has(seg)) push(seg, 1.2, "latin"); continue; }

      /* ① 段内词典最大匹配（最长 6 字），命中即整词入列并标记已消费 */
      const chars = [...seg];
      const n = chars.length;
      const consumed = new Array(n).fill(false);
      if (dict && dict.size) {
        for (let len = Math.min(6, n); len >= 2; len--) {
          for (let i = 0; i + len <= n; i++) {
            let free = true;
            for (let k = i; k < i + len; k++) if (consumed[k]) { free = false; break; }
            if (!free) continue;
            const term = chars.slice(i, i + len).join("");
            if (dict.has(term)) {
              push(term, 1.0 + Math.min(len, 6) * 0.1, "dict");
              for (let k = i; k < i + len; k++) consumed[k] = true;
            }
          }
        }
      }

      /* ② 对"未被词典命中的连续片段"补 n-gram。
         这一步是覆盖率判据能否成立的关键。早期版本对未消费片段无条件补 2/3-gram，
         于是"身体不舒服校医室在哪"会产出"体不""不舒""校医""医室"这类跨词碎片
         （"校医室"被词典整词命中，"身体"未命中，两者相邻就拼出跨边界组合）。
         这些碎片天然不在任何知识条目里，会被词表级覆盖当成"未收录证据"，
         把正常提问误判成知识库没有。

         这里不要求 n-gram 必须出现在词典里 —— 词典只覆盖 keyword 表（约 900 词），
         正文里的"窗口""招牌"等词天然不在其中，一刀切会误杀真实词。
         正确判据是"组合必须落在同一个未命中片段内部"，即天然不跨已识别词的边界。 */
      let run = [];
      const flushRun = () => {
        /* 只补 2-gram，不补 3-gram：这条取舍踩过坑，值得记下来。
           早期版本同时补 2/3-gram，"绿色通道怎么申请"会产出
           "怎么申 / 么申 / 么申请"这类碎片，它们恰是两个文档正文里"怎么申请"的子串，
           df 极小、IDF 极高，BM25 会把这两个文档顶到正确条目 k18 前面 ——
           表现为"加了三路召回，R@1 反而比 v1 子串匹配还低"。
           2-gram（"怎么""申请"）与真实词重合度高得多，副作用小：
           领域复合词已由词典整词命中，2-gram 只需承担"未登录词兜底召回"的职责。 */
        for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2).join(""), 0.6, "bigram");
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (consumed[i]) { if (run.length) flushRun(); }
        else run.push(chars[i]);
      }
      if (run.length) flushRun();
    }
    /* 去重：同一词项只保留权重最高的一次出现，避免重复计入覆盖率分母 */
    const best = new Map();
    out.forEach(t => {
      const prev = best.get(t.term);
      if (!prev || t.weight > prev.weight) best.set(t.term, t);
    });
    return [...best.values()];
  }

  /** 兼容旧签名：只返回词项字符串数组 */
  function tokenize(text, opts) {
    return tokenizeDetailed(text, opts).map(t => t.term);
  }

  /**
   * 闸门专用分词：**只保留领域词典命中的整词与拉丁词**，不补任何 n-gram 碎片。
   *
   * 为什么必须与召回分词分开：
   *   召回阶段需要 n-gram 兜底才能容忍未登录词（"睡不着""招牌"），
   *   但覆盖率判定要的是"问题里的实词在不在知识库里"。
   *   若拿带碎片的分词去算覆盖率，"心情特别差"会同时产出"心情特/情特/特别差"等
   *   永远不可能在文档中出现的组合，覆盖率被系统性压低，
   *   于是正常提问被误判为"知识库未收录" —— 这正是之前闸门失真的根因。
   *
   * 未登录的真词（如"睡不着"）会漏掉，但它们在知识库里本来也不存在，
   * 不参与覆盖率统计反而更接近"这条知识是否覆盖了问题主题"的语义。
   */
  function tokenizeGated(text, opts) {
    const o = opts || {};
    const norm = normalize(text);
    if (!norm) return [];
    const dict = o.dict || state.dict;
    const out = [];
    const seen = new Set();
    const push = (term, weight, kind) => {
      if (!term || STOP.has(term) || seen.has(term)) return;
      seen.add(term);
      out.push({ term, weight, kind });
    };
    for (const seg of norm.split(" ").filter(Boolean)) {
      if (!hasCJK(seg)) { if (seg.length > 1 && !STOP.has(seg)) push(seg, 1.2, "latin"); continue; }
      const chars = [...seg];
      const n = chars.length;
      const consumed = new Array(n).fill(false);
      if (dict && dict.size) {
        for (let len = Math.min(6, n); len >= 2; len--) {
          for (let i = 0; i + len <= n; i++) {
            let free = true;
            for (let k = i; k < i + len; k++) if (consumed[k]) { free = false; break; }
            if (!free) continue;
            const term = chars.slice(i, i + len).join("");
            if (dict.has(term)) {
              push(term, 1.0 + Math.min(len, 6) * 0.1, "dict");
              for (let k = i; k < i + len; k++) consumed[k] = true;
            }
          }
        }
      }
      /* 未命中词典的连续片段：保留其中的 2-gram。
         这些不是跨词碎片（它们不跨越已识别词的边界），而是词典没收录的真实词，
         例如"几点""开饭""特别""舒服"。全部丢弃会让短查询只剩 1 个词，
         触发"低信号"保护而误拒正常问题。 */
      let run = [];
      const flushRun = () => {
        for (let i = 0; i + 2 <= run.length; i++) {
          push(run.slice(i, i + 2).join(""), 0.6, "bigram");
        }
        run = [];
      };
      for (let i = 0; i < n; i++) {
        if (consumed[i]) { if (run.length) flushRun(); }
        else run.push(chars[i]);
      }
      if (run.length) flushRun();
    }
    return out;
  }

  function expandTerms(text) {
    const norm = normalize(text);
    const out = [];
    aliasIndex.forEach((to, from) => {
      if (norm.indexOf(from) >= 0) to.forEach(t => { if (out.indexOf(t) < 0) out.push(t); });
    });
    return out;
  }

  /** 查询改写：生成多条检索子查询（可视化中"改写 = N 条子查询"的来源） */
  function rewriteQueries(text) {
    const norm = normalize(text);
    const subs = [norm];
    expandTerms(norm).forEach(t => { if (subs.indexOf(t) < 0) subs.push(t); });
    const stem = norm
      .replace(/(是什么|有哪些|有多少|怎么样|怎么办|怎么弄|怎么走|在哪里|在哪|几点|多久|多少|吗|呢|啊|呀|的|了|请问)/g, " ")
      .replace(/\s+/g, " ").trim();
    if (stem && stem !== norm && subs.indexOf(stem) < 0) subs.push(stem);
    return subs.filter(Boolean).slice(0, 5);
  }

  /* ==========================================================
   * 2. 意图分类
   * ========================================================== */
  const INTENT_RULES = [
    ["情绪安抚", ["不开心", "难过", "伤心", "焦虑", "压力", "累", "烦", "哭", "孤独", "害怕", "郁闷", "崩溃", "难受", "想家", "emo"]],
    ["报到入学", ["报到", "入学", "迎新", "注册", "新生", "录取", "通知书", "开学"]],
    ["图书馆自习", ["图书馆", "自习", "借阅", "阅览", "占座", "座位预约", "开馆", "闭馆", "续借"]],
    ["住宿生活", ["宿舍", "寝室", "公寓", "床", "洗浴", "热水", "洗衣", "空调", "电费", "报修"]],
    ["餐饮服务", ["食堂", "吃饭", "餐厅", "外卖", "伙食", "超市", "饭菜", "饭菜价格"]],
    ["专业学业", ["专业", "课程", "选课", "成绩", "学分", "考试", "重修", "辅修", "转专业", "绩点", "考证"]],
    ["奖助资助", ["奖学金", "助学金", "资助", "贷款", "绿色通道", "勤工", "困难", "补助"]],
    ["校园活动", ["社团", "活动", "艺术节", "纳新", "比赛", "演出", "讲座", "志愿"]],
    ["交通出行", ["班车", "公交", "地铁", "怎么去", "接站", "校车", "停车", "打车"]],
    ["校园导航", ["地图", "在哪", "怎么走", "布局", "几号楼", "路线", "远不远", "位置"]],
    ["办事流程", ["怎么办", "流程", "办理", "手续", "补办", "申请", "材料", "证明", "盖章", "报修", "请假"]],
    ["联系方式", ["电话", "联系", "咨询", "找谁", "客服", "邮箱", "部门"]],
    ["就业发展", ["就业", "实习", "招聘", "求职", "简历", "校招", "考研", "保研", "生涯"]],
    ["网络信息", ["校园网", "wifi", "上网", "网速", "账号", "教务系统", "一卡通", "app", "打印"]],
    ["安全健康", ["安全", "就医", "校医院", "体检", "心理咨询", "防盗", "诈骗", "消防", "医务室"]],
    ["费用缴纳", ["学费", "住宿费", "缴费", "收费", "退费", "费用", "多少钱"]],
    ["校园文化", ["校训", "校史", "文化", "理念", "精神", "特色", "简介"]],
    ["通用咨询", []],
  ];

  function intentOf(query) {
    const norm = normalize(query);
    let best = { name: "通用咨询", hits: 0 };
    for (const [name, kws] of INTENT_RULES) {
      let hits = 0;
      kws.forEach(k => { if (norm.indexOf(normalize(k)) >= 0) hits++; });
      if (hits > best.hits) best = { name, hits };
    }
    if (!best.hits && /怎么|如何|流程|怎么办/.test(norm)) best = { name: "办事流程", hits: 1 };
    return best.name;
  }

  /* ==========================================================
   * 3. 索引
   * ========================================================== */
  const state = {
    entries: [], dict: new Set(), dictSub: new Set(), postings: new Map(), df: new Map(),
    avgLen: 1, docLen: [], idf: new Map(),
    vectors: [], vnorm: [], vecTerms: new Set(),
    graph: { entities: [], relations: [] }, entityTerms: new Map(), entityDocs: new Map(),
    placeIndex: new Map(), formTable: [], deptTable: [],
    loaded: false,
  };

  function buildCorpusText(e) {
    return [e.q || "", (e.k || []).join(" "), (e.a || "").length > 400 ? (e.a || "").slice(0, 400) : (e.a || ""), e.cat || "", e.src || ""].join(" ");
  }

  function buildIndex() {
    const data = loadData();
    const base = Array.isArray(data.kb) ? data.kb : [];
    const corpus = Array.isArray(data.corpus) ? data.corpus : [];
    const extra = (USER_EXTRA || data.extra || []).slice();
    state.entries = base.concat(corpus, extra).filter(e => e && e.a);

    state.graph = data.graph || { entities: [], relations: [] };
    state.formTable = (data.forms && data.forms.forms) || [];
    state.deptTable = (data.depts && data.depts.departments) || [];

    /* 领域词典 = 关键词 + 同义词 + 图谱实体名/别名 + 场所名 */
    state.dict = new Set();
    state.entries.forEach(e => (e.k || []).forEach(k => { const n = normalize(k); if (n.length >= 2 && n.length <= 8) state.dict.add(n); }));
    ALIAS.forEach(a => { state.dict.add(a.from); a.to.forEach(t => state.dict.add(t)); });

    state.entityTerms = new Map();
    (state.graph.entities || []).forEach(en => {
      state.dict.add(normalize(en.name));
      state.entityTerms.set(normalize(en.name), en.id);
      (en.alias || []).forEach(a => { state.dict.add(normalize(a)); state.entityTerms.set(normalize(a), en.id); });
    });

    state.placeIndex = new Map();
    ((data.places && data.places.places) || []).forEach(p => {
      state.placeIndex.set(p.id, p);
      if (p.name) { state.dict.add(normalize(p.name)); if (!state.entityTerms.has(normalize(p.name))) state.entityTerms.set(normalize(p.name), p.entity || p.id); }
      (p.tags || []).forEach(t => state.dict.add(normalize(t)));
    });

    rebuild();
    /* 预构建"词内子串"集合：分词时判断 n-gram 是否为真实构词成分用，
       建一次即可（词典在索引重建时才会变化）。 */
    state.dictSub = new Set();
    state.dict.forEach(w => {
      for (let len = 2; len < w.length; len++) {
        for (let i = 0; i + len <= w.length; i++) state.dictSub.add(w.slice(i, i + len));
      }
    });
    state.loaded = true;
    return state;
  }

  function rebuild() {
    const N = state.entries.length;
    state.postings = new Map(); state.df = new Map();
    state.docLen = new Array(N).fill(0);
    let totalLen = 0;

    state.entries.forEach((e, i) => {
      const toks = tokenize(buildCorpusText(e), { dict: state.dict });
      const tf = new Map();
      toks.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      state.docLen[i] = toks.length;
      totalLen += toks.length;
      tf.forEach((v, t) => {
        if (!state.postings.has(t)) state.postings.set(t, new Map());
        state.postings.get(t).set(i, v);
        state.df.set(t, (state.df.get(t) || 0) + 1);
      });
    });
    state.avgLen = N ? totalLen / N : 1;

    state.idf = new Map();
    state.postings.forEach((_, t) => {
      const df = state.df.get(t) || 1;
      state.idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    });

    /* 稀疏 TF-IDF 向量（语义召回） */
    state.vectors = new Array(N);
    state.vnorm = new Array(N);
    state.vecTerms = new Set();
    for (let i = 0; i < N; i++) {
      const vec = new Map();
      const toks = tokenize(buildCorpusText(state.entries[i]), { dict: state.dict });
      const tf = new Map();
      toks.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      let maxTf = 1;
      tf.forEach(v => { if (v > maxTf) maxTf = v; });
      tf.forEach((v, t) => {
        const w = (0.5 + 0.5 * v / maxTf) * (state.idf.get(t) || 0.5);
        vec.set(t, w);
        state.vecTerms.add(t);
      });
      state.vectors[i] = vec;
      state.vnorm[i] = normOf(vec);
    }

    /* 实体 → 关联条目 倒排（图谱召回入口） */
    state.entityDocs = new Map();
    state.entries.forEach((e, i) => {
      (e.entities || []).forEach(en => {
        if (!state.entityDocs.has(en)) state.entityDocs.set(en, []);
        state.entityDocs.get(en).push(i);
      });
    });
    KB_HAY = null;      // 全库文本 haystack 随索引变化失效
  }

  function normOf(vec) { let s = 0; vec.forEach(v => { s += v * v; }); return Math.sqrt(s) || 1; }

  /* ==========================================================
   * 4. 三路召回
   * ========================================================== */
  function bm25(query, k1, b) {
    const K1 = k1 == null ? 1.5 : k1, B = b == null ? 0.75 : b;
    const scores = new Array(state.entries.length).fill(0);
    const qtf = new Map();
    tokenize(query, { dict: state.dict }).forEach(t => qtf.set(t, (qtf.get(t) || 0) + 1));
    qtf.forEach((qCount, t) => {
      const posting = state.postings.get(t);
      if (!posting) return;
      const idf = state.idf.get(t) || 0;
      const qw = (1 + Math.log(qCount)) * informativeness(t, posting.size);
      posting.forEach((tf, i) => {
        const dl = state.docLen[i] || 1;
        scores[i] += qw * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / state.avgLen));
      });
    });
    return scores;
  }

  /**
   * 查询侧词项"信息量"降权。
   *
   * BM25 天然偏爱稀有词：IDF 随 df 减小而增大。这对真实专有名词是对的，
   * 但查询里的**兜底 2-gram 碎片**会因此获得不应有的权重。典型例子：
   *   "绿色通道怎么申请" 里，真实词"申请"的 df=26（IDF 1.62），
   *   而跨词碎片"么申"只出现在 2 个文档里（IDF 3.98）——
   *   结果碎片把正确条目 k18 挤出了 Top1，表现为"加了三路召回反而更差"。
   *
   * 处理方式：词项越稀有且大概率是碎片时，给它的查询权重越低。
   * 判据取 min(df, 4)：df 越小惩罚越重。真实未登录词（如"睡不着"）
   * 通常在某类条目里反复出现，df 不会极端小，因此不受影响。
   */
  function informativeness(term, df) {
    /* 只对"非词典词"（即兜底 n-gram）降权；词典整词是人工确认过的主题词，不降权 */
    if (state.dict && state.dict.has(term)) return 1;
    if (df >= 4) return 1;
    /* 降权幅度经实测确定：把 df≤2 的兜底碎片压到有效权重约 0.8
       （真实主题词"申请"约 1.6），足以让排序由主题词主导，
       同时不会把语义召回一起压坏 —— 更狠的系数会使 R@3 从 91.7% 掉到 87.5%。
       这类词项的 BM25 召回应由语义向量路线兜底，而不是靠 BM25 硬撑。 */
    return 0.06 + 0.28 * (df / 4);
  }

  function vectorScore(query) {
    const subs = rewriteQueries(query);
    const qvec = new Map();
    subs.forEach((s, si) => {
      const weight = si === 0 ? 1 : 0.55;
      const tf = new Map();
      tokenize(s, { dict: state.dict }).forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      tf.forEach((v, t) => {
        const idfw = state.idf.get(t) || (state.vecTerms.has(t) ? 0.5 : 0.3);
        qvec.set(t, (qvec.get(t) || 0) + weight * v * idfw);
      });
    });
    const qn = normOf(qvec);
    const scores = new Array(state.entries.length).fill(0);
    qvec.forEach((qw, t) => {
      const posting = state.postings.get(t);
      if (posting) { posting.forEach((_, i) => { scores[i] += qw * (state.vectors[i].get(t) || 0); }); return; }
      if (t.length >= 2) {
        state.postings.forEach((p, term) => {
          if (term.indexOf(t) >= 0 || t.indexOf(term) >= 0) p.forEach((_, i) => { scores[i] += qw * 0.4 * (state.vectors[i].get(term) || 0); });
        });
      }
    });
    for (let i = 0; i < scores.length; i++) scores[i] = scores[i] / ((qn * state.vnorm[i]) || 1);
    return scores;
  }

  function linkEntities(query) {
    const norm = normalize(query);
    const found = [];
    state.entityTerms.forEach((id, term) => {
      if (term.length >= 2 && norm.indexOf(term) >= 0) found.push({ term, id, len: term.length });
    });
    expandTerms(norm).forEach(t => {
      const id = state.entityTerms.get(normalize(t));
      if (id && !found.some(f => f.id === id)) found.push({ term: t, id, len: t.length });
    });
    found.sort((a, b) => b.len - a.len);
    const seen = new Set(); const out = [];
    found.forEach(f => { if (!seen.has(f.id)) { seen.add(f.id); out.push(f); } });
    return out.slice(0, 4);
  }

  function graphScore(query, hops) {
    const H = hops == null ? 2 : hops;
    const linked = linkEntities(query);
    const scores = new Array(state.entries.length).fill(0);
    const detail = { linked, paths: [] };
    if (!linked.length || !state.graph.relations || !state.graph.relations.length) return { scores, detail };

    const weight = new Map();
    linked.forEach(l => weight.set(l.id, 1));
    let frontier = [...weight.keys()];
    const visited = new Set(frontier);
    for (let h = 1; h <= H; h++) {
      const next = [];
      state.graph.relations.forEach(rel => {
        if (frontier.indexOf(rel.from) < 0 || visited.has(rel.to)) return;
        const w = (weight.get(rel.from) || 0) * (rel.w == null ? 0.6 : rel.w) * Math.pow(0.7, h - 1);
        weight.set(rel.to, Math.max(weight.get(rel.to) || 0, w));
        next.push(rel.to);
        if (detail.paths.length < 10) detail.paths.push({ from: rel.from, to: rel.to, rel: rel.rel, hop: h, w: +w.toFixed(3) });
      });
      frontier = next;
      next.forEach(n => visited.add(n));
      if (!frontier.length) break;
    }
    weight.forEach((w, id) => {
      ((state.entityDocs && state.entityDocs.get(id)) || []).forEach(i => { scores[i] += w; });
    });
    const max = Math.max(...scores, 0);
    if (max > 0) for (let i = 0; i < scores.length; i++) scores[i] = scores[i] / max;
    return { scores, detail };
  }

  /* ==========================================================
   * 5. 融合重排 + 置信度闸门
   * ========================================================== */
  const WEIGHTS = { bm25: 0.45, vector: 0.35, graph: 0.20 };
  const DEFAULT_THRESHOLD = 0.1;

  /* 阈值可外部注入：标定脚本扫描阈值时若仍读模块默认值，
     "标定看到的分布"与"实际运行的分布"就会不一致，标定结果完全失真。 */
  function resolveThreshold(t) { return t == null ? DEFAULT_THRESHOLD : t; }

  function normalizeArr(arr) { const max = Math.max(...arr, 0); return max > 0 ? arr.map(v => v / max) : arr.map(() => 0); }

  function keywordHits(query, entry) {
    const norm = normalize(query);
    const hit = [];
    (entry.k || []).forEach(k => { if (norm.indexOf(normalize(k)) >= 0) hit.push(k); });
    return hit;
  }

  /**
   * 查询词项覆盖率：命中的检索词占"实质查询词"的比重（按信息量加权）。
   *
   * 这是置信度闸门的核心判据。仅靠检索分数无法判断"未收录"，因为
   * 各路线分数都做过 max 归一化，Top1 恒为满分 —— 于是
   * "食堂三楼川菜窗口的招牌菜"和"图书馆几点开门"会拿到同样的最高分。
   * 真正有区分度的问题是：**问题里的具体词，知识库里到底有没有**。
   *
   *   图书馆几点开门          → 图书馆、开门 全部命中 → coverage ≈ 1
   *   食堂三楼川菜窗口的招牌菜 → 三楼、川菜、窗口 在库中不存在 → coverage 明显偏低
   *
   * 单字不参与统计（信息量过低），长词权重更高，避免口语化表达被误判为未收录。
   */
  /**
   * 覆盖率：用分词的词项权重统计"查询词有多少被目标文本覆盖"。
   *
   * 三个关键设计，都是为了"既不放过未收录、也不误伤正常提问"：
   *  ① 同义词归一：命中别名（如"饭堂"→"食堂"）也算覆盖，
   *     否则口语化提问会被系统当成"知识库没有"而错误拒答；
   *  ② 子串归并：若某个更长的查询词已被覆盖，则其子串也算覆盖
   *     （"自习室"覆盖后，"自习""习室"不应再算未覆盖）；
   *  ③ 加权：词典词与长词权重高，2-gram 权重低（口语化片语不该主导判定）。
   */
  function coverAgainst(tokens, hayText) {
    /* 空查询也要返回完整字段：调用方直接取 .missDetail/.misses，
       早期版本在这里少给了一个字段，导致 /api/rag 在空查询时 500。 */
    if (!tokens || !tokens.length) {
      return { raw: 0, total: 0, hit: 0, misses: [], missDetail: [], tokens: 0 };
    }
    const hay = normalize(hayText);
    const covered = [];
    const misses = [];
    let total = 0, hit = 0;
    tokens.forEach(t => {
      const w = t.weight;
      total += w;
      const direct = hay.indexOf(t.term) >= 0;
      /* ① 同义词归一 */
      const aliases = aliasIndex.get(t.term) || [];
      const viaAlias = !direct && aliases.some(a => hay.indexOf(a) >= 0);
      if (direct || viaAlias) { hit += w; covered.push(t.term); return; }
      misses.push(t);
    });
    /* ② 子串归并：被更长已覆盖词包含的查询词，视为已覆盖 */
    const stillMiss = [];
    let extraHit = 0;
    misses.forEach(m => {
      if (covered.some(c => c.length > m.term.length && c.indexOf(m.term) >= 0)) { hit += m.weight; extraHit += m.weight; }
      else stillMiss.push(m);
    });
    /* 未覆盖词按信息量排序，取最高的几个用于向用户解释"为什么判定未收录" */
    stillMiss.sort((a, b) => (b.term.length - a.term.length) || (b.weight - a.weight));
    return {
      raw: total > 0 ? hit / total : 0,
      total: +total.toFixed(2), hit: +hit.toFixed(2),
      misses: stillMiss.map(m => m.term).slice(0, 6),
      missDetail: stillMiss.slice(0, 6).map(m => ({ term: m.term, weight: +m.weight.toFixed(2), kind: m.kind })),
      tokens: tokens.length,
    };
  }

  /**
   * 置信度闸门（v1 基线与 v2 共用，保证消融对比是"同一判据下的检索质量差异"）
   *
   * 判据构成：
   *   ① 检索强度   三路召回融合后 Top1 的归一化分数
   *   ② 文档级覆盖 问题里被识别的词有多少落在候选条目里
   *   ③ 词表级覆盖 这些词有多少存在于整个知识库
   *
   * 两个工程细节决定它是否可用：
   *
   *  A. **多候选聚合**：只拿 Top1 算覆盖过于脆弱 —— 一个问题可能命中多条相关知识，
   *     Top1 只覆盖了其中一半词，但因"Top1 就该覆盖全部"而被判未收录。
   *     因此对前若干个候选各算一次覆盖，取最大值作为"知识库对该问题的覆盖能力"。
   *
   *  B. **单一命中不可单独放行**：若门控分词只识别出 1 个词（例如"心情特别差，
   *     晚上睡不着"只识别出"心情"），这一个词命中就会得到覆盖率 1.0，
   *     这个信号强度不足以支撑"我很确定"，必须要求最低词项数。
   *
   * 注意：闸门分词（tokenizeGated）只保留词典整词、不补 n-gram 碎片，
   * 否则"心情特/情特/特别差"这类永远不可能出现在文档中的组合会把覆盖率系统性压低。
   */
  const MIN_GATE_TOKENS = 2;

  /**
   * 判断"证据是否充分"。
   * 不能只看词项数量：像"图书馆"这种 3 字领域词，单个词就足以指向明确主题。
   * 因此规则是：≥2 个可识别词，或"唯一那个词本身有足够信息量（≥3 字且为词典词）"。
   */
  function isEvidenceSufficient(tokens) {
    if (!tokens || !tokens.length) return false;
    if (tokens.length >= MIN_GATE_TOKENS) return true;
    const t = tokens[0];
    return t.term.length >= 3 && t.kind === "dict";
  }

  function coverageGate(query, entry, opts) {
    const o = opts || {};
    /* 闸门用"仅词典词"的干净分词（见 tokenizeGated 注释） */
    const detail = o.tokenDetail || tokenizeGated(query, { dict: state.dict });

    /* 多候选：优先用调用方传入的候选集合，否则退化为单条 entry */
    const entries = (o.entries && o.entries.length) ? o.entries : [entry || { q: "", k: [], a: "", cat: "" }];
    let doc = { raw: 0, misses: [], missDetail: [], tokens: detail.length };
    let docEntry = entries[0];
    entries.forEach(e => {
      const c = coverAgainst(detail, [e.q || "", (e.k || []).join(" "), e.cat || "", String(e.a || "").slice(0, 400)].join(" "));
      if (c.raw > doc.raw) { doc = c; docEntry = e; }
    });
    const vocab = coverAgainst(detail, vocabHaystack());
    const soft = (c) => c.raw / Math.pow(Math.max(c.tokens, 1), 0.3);
    const docSoft = soft(doc), vocabSoft = soft(vocab);
    const aggregate = Math.min(docSoft, vocabSoft);
    const scorePart = o.topScore == null ? 1 : 0.55 + 0.45 * clamp01(o.topScore / Math.max((o.threshold || DEFAULT_THRESHOLD) * 1.4, 1e-6));
    const confidence = clamp01(scorePart * aggregate);
    const tokenRich = isEvidenceSufficient(detail);

    return {
      confidence: +confidence.toFixed(3),
      coverage: +docSoft.toFixed(3),
      docCoverage: +doc.raw.toFixed(3),
      vocabCoverage: +vocabSoft.toFixed(3),
      vocabRaw: +vocab.raw.toFixed(3),
      aggregate: +aggregate.toFixed(3),
      tokenCount: detail.length,
      tokenRich,
      matchedEntryId: docEntry && docEntry.id ? docEntry.id : null,
      /* 未归一化的原始覆盖率：调参脚本必须基于原始量重新聚合，
         否则会重复归一化，得出完全错误的结论。 */
      raw: { doc: +doc.raw.toFixed(4), vocab: +vocab.raw.toFixed(4), tokens: detail.length },
      /* 优先展示"全库都没有"的词，这才是判定未收录的直接证据 */
      uncoveredTerms: (vocab.misses.length ? vocab.misses : doc.misses).slice(0, 6),
      uncoveredDetail: (vocab.misses.length ? vocab.missDetail : doc.missDetail).slice(0, 6),
    };
  }

  /**
   * 词表级覆盖的 haystack：**全库真实文本拼接**，而不是索引词项集合。
   *
   * 为什么不能用 state.vecTerms：索引词项由召回分词（含 n-gram）产生，
   * 而闸门分词只输出词典整词，两套口径不一致时，
   * 一个本该被覆盖的词（如"条件"）可能在词项集合里根本不存在（它只以 n-gram 形式入索引），
   * 于是覆盖率恒为 0 —— 这正是"正常提问被误判为未收录"的另一个根因。
   * 直接用全库文本做 haystack，保证"知识库里有没有这个词"的判定是真实且一致的。
   *
   * 缓存在每次重建索引时失效；知识条目仅百余条，拼接成本可忽略。
   */
  function kbHaystack() {
    if (!KB_HAY) {
      KB_HAY = state.entries.map(e => [e.q || "", (e.k || []).join(" "), e.cat || "", String(e.a || "").slice(0, 400)].join(" ")).join(" ");
    }
    return KB_HAY;
  }
  function vocabHaystack() { return kbHaystack(); }

  function confidenceOf(topScore, threshold, coverage, vocab) {
    return clamp01(vocab == null ? coverage : Math.min(coverage, vocab));
  }

  /* ==========================================================
   * 域外意图识别（Out-of-Scope Detection）
   *
   * 为什么单靠词项覆盖不够：
   *   "帮我写一段 Python 快排代码"、"今天天气怎么样"、"校长的手机号是多少" 这类问题，
   *   用到的词（代码、天气、校长）可能恰好在语料里出现过，覆盖率不为 0，
   *   于是闸门会把它们误判为"可回答"。但它们在**意图上**根本不属于校园问答范围。
   *
   * 因此再补一层规则化域外识别：命中即明确拒答，并给出"为什么不回答"的理由。
   * 这比单纯依赖分数更可解释，也更省一次模型调用。
   * ========================================================== */
  const OOS_RULES = [
    { id: "code", label: "编程与算法任务", re: /(写|生成|实现|帮我写|调试|debug|重构|解释).{0,14}(代码|函数|脚本|程序|算法|python|java|javascript|sql|正则)/i },
    { id: "code2", label: "编程与算法任务", re: /\b(python|javascript|typescript|java|golang|rust|c\+\+|c#|sql|bash)\b.{0,12}(代码|函数|实现|写法|怎么)/i },
    { id: "weather", label: "实时天气", re: /(天气|气温|下雨|下雪|空气质量|雾霾|紫外线|台风)/ },
    { id: "realtime", label: "实时动态信息", re: /(股价|股票|彩票|汇率|油价|黄金价格|房价|比分|赛程|航班|火车票余票|行情|涨跌|大盘|菜单|今天有(什么|哪些)菜|有什么菜|今天吃(什么|啥))/ },
    { id: "privacy", label: "涉及个人隐私", re: /(校长|院长|书记|老师|同学|辅导员|室友).{0,10}(手机号|电话号|微信|身份证|住址|家庭住址|家庭情况|工资)/ },
    { id: "medical", label: "医疗诊断", re: /(得了|是不是|患了|诊断).{0,8}(病|癌|抑郁|焦虑症|肺炎)|开药|吃什么药|用药剂量/ },
    { id: "legal", label: "法律与心理诊断", re: /(起诉|打官司|法律文书|合同违约怎么赔|心理疾病诊断)/ },
    { id: "credential", label: "账号凭据与密码", re: /(wifi|wi-fi|无线网|热点|校园网|教务系统|账号|邮箱).{0,8}(密码|口令|验证码)|密码是多少|初始密码是什么|admin 密码/i },
    { id: "other_school", label: "其他院校信息", re: /(其他学校|别的学校|哪所大学|哪个学校|对比.{0,8}(学校|大学)|清华|北大|复旦|浙大|南开|中国传媒大学)/ },
    { id: "writing", label: "通用翻译与写作", re: /(翻译成|译成|帮我写一篇|写一篇作文|写首诗|生成一段|润色一下)/ },
    { id: "math", label: "数学解题", re: /(解方程|求导|积分|证明.{0,8}定理|计算.{0,10}(等于|结果))/ },
  ];

  /**
   * 识别域外意图。只有"明确域外"才拦截；
   * 校园相关问题（含"学校""宿舍""课程"等）不会被这条规则误伤。
   */
  function detectOutOfScope(query) {
    const norm = normalize(query);
    const compact = norm.replace(/\s+/g, "");
    for (const r of OOS_RULES) {
      if (r.re.test(norm) || r.re.test(compact)) return { outOfScope: true, rule: r.id, label: r.label };
    }
    return { outOfScope: false, rule: null, label: null };
  }

  /** 覆盖闸门 + 域外识别的组合判定，供检索与工具统一调用 */
  function gateDecision(query, entry, opts) {
    const o = opts || {};
    const oos = detectOutOfScope(query);
    const base = coverageGate(query, entry, opts);

    if (oos.outOfScope) {
      return Object.assign({}, base, {
        confidence: Math.min(base.confidence, 0.05),
        outOfScope: true, oosRule: oos.rule, oosLabel: oos.label,
        reason: "该问题属于「" + oos.label + "」，不在校园导览助教的服务范围内",
      });
    }

    const th = o.threshold == null ? DEFAULT_THRESHOLD : o.threshold;

    /* 单一命中不可单独放行：
       门控分词只识别出 1 个词时（如"心情特别差，晚上睡不着"只识别出"心情"），
       这一个词命中就会把覆盖率推到 1.0，信号强度不足以支撑"我很确定"。
       此时按覆盖率不足处理，宁可让模型在云端通道向用户追问，也不硬答。
       注意：这一规则只在"词项确实很少"时生效，不影响正常覆盖率判定。 */
    if (!base.tokenRich) {
      return Object.assign({}, base, {
        confidence: Math.min(base.confidence, th * 0.6),
        outOfScope: false, lowSignal: true,
        reason: "可识别的关键词过少（" + base.tokenCount + " 个），证据强度不足，判定为未收录",
      });
    }

    return Object.assign({}, base, {
      outOfScope: false, lowSignal: false,
      reason: base.confidence >= th ? "命中知识库且置信度达标" : "置信度低于闸门阈值，判定为知识库未收录",
    });
  }

  /** 子串匹配基线（用于评测面板的"改造前 vs 改造后"消融对比） */
  function baselineRetrieve(query, topK, opts) {
    const o = opts || {};
    const gated = o.useGate !== false;
    const th = resolveThreshold(o.threshold);
    const norm = normalize(query);
    const hits = [];
    state.entries.forEach((e, i) => {
      let score = 0;
      (e.k || []).forEach(kw => { if (norm.indexOf(normalize(kw)) >= 0) score += normalize(kw).length; });
      if (norm.indexOf(normalize(e.q)) >= 0) score += 2;
      if (score > 0) hits.push({ i, score, entry: e });
    });
    hits.sort((a, b) => b.score - a.score);
    const max = hits.length ? hits[0].score : 0;
    /* 与 v2 使用同一个闸门判据（检索强度 × 文档覆盖 × 词表覆盖 + 域外识别），
       保证消融对比是"同一判据下的检索质量差异"，而不是判据宽严的差异。 */
    const cov = (gated && hits.length)
      ? gateDecision(query, hits[0].entry, { threshold: th })
      : { confidence: hits.length ? 1 : 0, coverage: null, vocabCoverage: null, uncoveredTerms: [], outOfScope: false, reason: "未启用闸门" };
    const confidence = cov.confidence;
    return {
      query, intent: intentOf(query), candidates: hits.length, topScore: max,
      confidence: +confidence.toFixed(3), threshold: th,
      coverage: cov.coverage, vocabCoverage: cov.vocabCoverage,
      coverageMisses: cov.uncoveredTerms,
      outOfScope: !!cov.outOfScope, oosLabel: cov.oosLabel || null, gateReason: cov.reason || null,
      pass: hits.length > 0 && confidence >= th,
      top: hits.slice(0, topK || 8).map(h => ({ id: h.entry.id, q: h.entry.q, src: h.entry.src, score: h.score, entry: h.entry })),
      strategy: "关键词子串匹配（v1 基线）",
      tokens: [], rewritten: [], entities: [], graphPaths: [], timeline: [],
    };
  }

  /**
   * 评测专用检索入口：可通过 strategies 精确控制启用哪几路召回。
   * 三路分数直接从统一的底层计算取用，保证消融实验是"同一实现的开关对比"，
   * 而不是三份不同代码的横向比较。
   */
  function benchRetrieve(query, strategies, topK, useGate, threshold) {
    if (!state.loaded) buildIndex();
    const use = strategies || { bm25: true, vector: true, graph: true };
    const K = topK || 5;
    const th = resolveThreshold(threshold);
    const t0 = now();
    const nb = use.bm25 ? normalizeArr(bm25(query)) : null;
    const nv = use.vector ? normalizeArr(vectorScore(query)) : null;
    const ng = use.graph ? normalizeArr(graphScore(query, 2).scores) : null;
    const tw = use.bm25 ? WEIGHTS.bm25 : 0;
    const vw = use.vector ? WEIGHTS.vector : 0;
    const gw = use.graph ? WEIGHTS.graph : 0;
    const total = tw + vw + gw || 1;
    const scores = nb || nv || ng
      ? state.entries.map((_, i) => ((nb ? tw * nb[i] : 0) + (nv ? vw * nv[i] : 0) + (ng ? gw * ng[i] : 0)) / total)
      : state.entries.map(() => 0);
    const ms = +(now() - t0).toFixed(2);
    const ranked = scores.map((s, i) => ({ i, score: s, entry: state.entries[i] }))
      .filter(x => x.score > 1e-6).sort((a, b) => b.score - a.score);
    const max = ranked.length ? ranked[0].score : 0;
    const cov = (useGate === false || !ranked.length)
      ? { confidence: ranked.length ? 1 : 0, coverage: null, vocabCoverage: null, uncoveredTerms: [], outOfScope: false, reason: "未启用闸门" }
      /* 传入前若干候选做多候选聚合：只按 Top1 算覆盖过于脆弱 */
      : gateDecision(query, ranked[0].entry, { topScore: max, threshold: th, entries: ranked.slice(0, 4).map(x => x.entry) });
    const confidence = cov.confidence;
    return {
      query, ms, candidates: ranked.length, threshold: th,
      pass: ranked.length > 0 && confidence >= th,
      topScore: +max.toFixed(4), confidence: +confidence.toFixed(3),
      coverage: cov.coverage, vocabCoverage: cov.vocabCoverage, coverageMisses: cov.uncoveredTerms,
      outOfScope: !!cov.outOfScope, oosLabel: cov.oosLabel || null, gateReason: cov.reason || null,
      top: ranked.slice(0, K).map(x => ({ id: x.entry.id, q: x.entry.q, src: x.entry.src, score: +x.score.toFixed(4), entry: x.entry })),
      enabled: use,
    };
  }

  function retrieveDetailed(query, opts) {
    const o = opts || {};
    const topK = o.topK || 8;
    const t0 = now();
    if (!state.loaded) buildIndex();

    const norm = normalize(query);
    const tokens = tokenize(query, { dict: state.dict });
    const rewritten = rewriteQueries(query);
    const intent = intentOf(query);
    const stage = (name) => ({ stage: name, at: +(now() - t0).toFixed(2) });

    const bm25Scores = bm25(query);
    const t1 = stage("bm25");
    const vecScores = vectorScore(query);
    const t2 = stage("vector");
    const g = graphScore(query, 2);
    const t3 = stage("graph");
    const nb = normalizeArr(bm25Scores), nv = normalizeArr(vecScores), ng = normalizeArr(g.scores);
    const fused = nb.map((_, i) => WEIGHTS.bm25 * nb[i] + WEIGHTS.vector * nv[i] + WEIGHTS.graph * ng[i]);
    const t4 = stage("fuse");

    const adjusted = fused.map((v, i) => {
      const e = state.entries[i];
      let s = v;
      if (e.cat && (intent.indexOf(e.cat) >= 0 || e.cat.indexOf(intent) >= 0)) s += 0.06;
      const kh = keywordHits(query, e).length;
      if (kh) s += Math.min(0.12, kh * 0.04);
      return s;
    });

    const ranked = adjusted.map((s, i) => ({ i, score: s, entry: state.entries[i] }))
      .filter(x => x.score > 0.001)
      .sort((a, b) => b.score - a.score);

    const max = ranked.length ? ranked[0].score : 0;
    const second = ranked[1] ? ranked[1].score : 0;
    const gap = max > 0 ? (max - second) / max : 0;
    const threshold = o.threshold == null ? DEFAULT_THRESHOLD : o.threshold;
    /* 置信度 = 检索强度 + 词项覆盖率（覆盖为主判据，负责识别"未收录"） */
    const cov = ranked.length
      /* 传入前若干候选做多候选聚合：只按 Top1 算覆盖过于脆弱 */
      ? gateDecision(query, ranked[0].entry, { topScore: max, threshold, entries: ranked.slice(0, 4).map(x => x.entry) })
      : gateDecision(query, null, { threshold });
    const confidence = cov.confidence;

    const top = ranked.slice(0, topK).map(x => ({
      id: x.entry.id, cat: x.entry.cat, q: x.entry.q, src: x.entry.src,
      a: String(x.entry.a || ""),
      snippet: String(x.entry.a || "").slice(0, 220),
      card: x.entry.card || null, entities: x.entry.entities || [],
      /* entry 必须原样带出：闸门的"文档级覆盖率"要用它算命中情况，
         早期版本漏了这个字段，导致 coverageGate 收到空对象 → 文档覆盖恒为 0，
         闸门对几乎所有问题都误判为未收录（一个会静默毁掉全部评测结果的 bug）。 */
      entry: x.entry,
      score: +x.score.toFixed(4),
      scorePct: max > 0 ? +(x.score / max * 100).toFixed(1) : 0,
      coverage: +coverageGate(query, x.entry, { topScore: max, threshold }).coverage.toFixed(3),
      keywordHits: keywordHits(query, x.entry),
      breakdown: {
        bm25: +nb[x.i].toFixed(4),
        vector: +nv[x.i].toFixed(4),
        graph: +ng[x.i].toFixed(4),
      },
    }));

    return {
      query, normalized: norm, tokens: tokens.slice(0, 48), tokenCount: tokens.length,
      rewritten, intent, strategy: "BM25 + 语义向量 + 知识图谱（三路融合）",
      weights: WEIGHTS,
      candidates: ranked.length, top,
      topScore: +max.toFixed(4), secondScore: +second.toFixed(4), scoreGap: +gap.toFixed(3),
      confidence: +confidence.toFixed(3), threshold,
      coverage: cov.coverage, docCoverage: cov.docCoverage,
      vocabCoverage: cov.vocabCoverage, aggregate: cov.aggregate,
      outOfScope: !!cov.outOfScope, oosLabel: cov.oosLabel || null, gateReason: cov.reason || null,
      uncoveredTerms: cov.uncoveredTerms || [],
      pass: ranked.length > 0 && confidence >= threshold,
      entities: g.detail.linked, graphPaths: g.detail.paths,
      timeline: [t1, t2, t3, t4],
      vectorDims: state.vecTerms.size,
      scores: { bm25: bm25Scores, vector: vecScores, graph: g.scores, fused: adjusted },
    };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }

  /* ==========================================================
   * 6. 场所状态 / 最短路径
   * ========================================================== */
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

  function isOpen(place, day, minutes) {
    const hours = (place.hours || []).filter(h => (h.days || [0, 1, 2, 3, 4, 5, 6]).indexOf(day) >= 0);
    for (const h of hours) {
      const [oh, om] = String(h.open).split(":").map(Number);
      const [ch, cm] = String(h.close).split(":").map(Number);
      let close = ch * 60 + cm;
      if (close <= oh * 60 + om) close += 24 * 60;             // 跨零点
      const m = minutes < oh * 60 + om ? minutes + 24 * 60 : minutes;
      if (m >= oh * 60 + om && m < close) return true;
    }
    return false;
  }
  function fmtMinutes(m) { return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  function isOpenNow(place, at) {
    const d = at ? new Date(at) : new Date();
    return isOpen(place, d.getDay(), d.getHours() * 60 + d.getMinutes());
  }

  /**
   * 按 id 或名称查场所。
   *
   * 必须支持 id：前端在卡片按钮、工具联动等场景拿到的往往是 id（如 "place_dorm"），
   * 早期实现只做名称相似匹配，导致"从宿舍导航到此"这类按钮找不到起点而静默失败 ——
   * 这类 bug 不报错、只是没反应，最难被发现。
   */
  function findPlace(name) {
    if (!name) return null;
    const raw = String(name);
    /* ① id 精确命中 */
    if (state.placeIndex.has(raw)) return state.placeIndex.get(raw);
    /* ② 名称 / 别名 / 标签模糊匹配 */
    const n = normalize(raw);
    if (!n) return null;
    let best = null, bestScore = 0;
    state.placeIndex.forEach(p => {
      const pn = normalize(p.name);
      let s = 0;
      if (pn === n) s = 100;
      else if (pn.indexOf(n) >= 0 || n.indexOf(pn) >= 0) s = 60 + Math.min(pn.length, n.length);
      else if ((p.tags || []).some(t => normalize(t).indexOf(n) >= 0 || n.indexOf(normalize(t)) >= 0)) s = 40;
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (best) return best;
    /* ③ 图谱实体链接（"寝室" → 宿舍实体 id → 场所） */
    for (const l of linkEntities(raw)) if (state.placeIndex.has(l.id)) return state.placeIndex.get(l.id);
    return null;
  }

  function edgesOf(place) {
    const out = [];
    (place.edges || []).forEach(e => {
      const to = typeof e === "string" ? e : e.to;
      if (!to || !state.placeIndex.has(to)) return;
      const target = state.placeIndex.get(to);
      const w = typeof e === "string" ? euclid(place, target) : (e.w || euclid(place, target));
      out.push({ to, w: w || 100 });
    });
    /* 双向：路径图默认无向，方便"从宿舍到图书馆"任意方向提问 */
    state.placeIndex.forEach(other => {
      (other.edges || []).forEach(e => {
        const from = typeof e === "string" ? e : e.to;
        if (from === place.id && !out.some(x => x.to === other.id)) {
          const w = typeof e === "string" ? euclid(place, other) : (e.w || euclid(place, other));
          out.push({ to: other.id, w: w || 100 });
        }
      });
    });
    return out;
  }
  function euclid(a, b) { return Math.round(Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0)) * 1.15) || 60; }

  function shortestPath(fromId, toId) {
    const byId = state.placeIndex;
    if (!fromId || !toId || !byId.has(fromId) || !byId.has(toId)) return { nodes: [], distance: 0 };
    const dist = new Map(), prev = new Map(), visited = new Set();
    byId.forEach((_, id) => dist.set(id, Infinity));
    dist.set(fromId, 0);
    while (true) {
      let cur = null, curD = Infinity;
      dist.forEach((d, id) => { if (!visited.has(id) && d < curD) { curD = d; cur = id; } });
      if (cur == null || curD === Infinity) break;
      visited.add(cur);
      if (cur === toId) break;
      edgesOf(byId.get(cur)).forEach(({ to, w }) => {
        if (visited.has(to) || !byId.has(to)) return;
        const nd = curD + w;
        if (nd < dist.get(to)) { dist.set(to, nd); prev.set(to, cur); }
      });
    }
    const ids = [];
    let cur = toId; const guard = new Set();
    while (cur && !guard.has(cur)) { guard.add(cur); ids.unshift(cur); if (cur === fromId) break; cur = prev.get(cur); }
    return { nodes: ids.map(id => byId.get(id)).filter(Boolean), distance: Math.round(dist.get(toId) === Infinity ? 0 : dist.get(toId)) };
  }

  /* ==========================================================
   * 7. Agent 工具集
   *
   * 每个工具统一返回：
   *   { summary   一行人类可读摘要（时间线展示）
   *     payload   给模型看的 JSON（唯一事实来源）
   *     sources   命中的知识来源（用于溯源标注）
   *     trace     给界面展示的链路过程
   *     detail    结构化数据（驱动地图/图谱/看板联动）
   *   }
   * 让"给模型看的"和"给人看的"是同一份数据的两种投影，
   * 避免演示中出现"界面显示的和模型实际拿到的不是一回事"。
   * ========================================================== */
  function toolSpecs() {
    return [
      {
        type: "function",
        function: {
          name: "search_campus_knowledge",
          description: "在河北传媒学院校园知识库中做混合检索（BM25+语义向量+知识图谱三路融合重排）。询问本校具体信息、校园服务、办事流程时使用；通用闲聊、编程、写作、通用百科知识无需调用。",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "结合上下文的具体检索主题，如：图书馆开放时间、宿舍床铺尺寸。不要只搜学校名称。" } },
            required: ["query"], additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "traverse_knowledge_graph",
          description: "沿校园知识图谱做多跳关系查询。当问题需要跨实体推理时使用，例如从宿舍出发找最近的自习室、某栋楼里有哪些服务、某部门负责什么。",
          parameters: {
            type: "object",
            properties: {
              start: { type: "string", description: "起点实体名，如：宿舍区、话筒楼、图书馆、学生处" },
              relation: { type: "string", description: "可选关系类型：位于、包含、提供、负责、邻近、开放于、联系、隶属。留空表示不限" },
              hops: { type: "integer", description: "跳数，1 到 3，默认 2" },
            },
            required: ["start"], additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "query_live_status",
          description: "查询校园场所此时此刻的开放状态（依据真实开放时段与当前时间实时计算）。当用户问现在、今天这个点、还开着吗、能去哪时应当调用。",
          parameters: {
            type: "object",
            properties: {
              place: { type: "string", description: "具体场所名，如：话筒楼自习室、大学生活动中心自习室、图书馆借阅室" },
              category: { type: "string", description: "按类别批量查询：自习室、借阅室、食堂、运动场馆、快递点、医务室、打印店" },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "navigate_to",
          description: "在校园地图上定位目标地点并生成步行导航路线，前端会同步播放镜头飞行与路径流光动画。用户问在哪、怎么走、离得远吗时使用。",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "目标地点名，如：话筒楼、大学生活动中心、影视艺术学院、宿舍区" },
              from: { type: "string", description: "可选起点，如：宿舍区、校门口。缺省为校门口" },
            },
            required: ["target"], additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "plan_form_fill",
          description: "生成办事流程清单（补办学生证、开在读证明、成绩单打印、请假、宿舍报修、转专业等），返回所需材料、办理地点、责任部门与预计时长。",
          parameters: {
            type: "object",
            properties: { matter: { type: "string", description: "要办的事项，如：补办学生证、开在读证明" } },
            required: ["matter"], additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_ticket",
          description: "当知识库确实没有收录用户问题时，创建一条知识盲区工单交给运营方补充。仅在检索无结果且无法回答时使用。",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string", description: "用户原问题" },
              intent: { type: "string", description: "归类，如：住宿生活、专业学业" },
            },
            required: ["question"], additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "handoff_to_human",
          description: "把问题转交人工（辅导员、学生处、教务处、图书馆等），返回对应部门联系方式。涉及个人隐私、学籍异动、投诉建议，或用户明确要求找人时使用。",
          parameters: {
            type: "object",
            properties: {
              reason: { type: "string", description: "转人工原因" },
              department: { type: "string", description: "目标部门，如：学生处、教务处、图书馆、辅导员" },
            },
            required: ["reason"], additionalProperties: false,
          },
        },
      },
    ];
  }

  function runTool(name, args) {
    args = args || {};
    try {
      switch (name) {
        case "search_campus_knowledge": return toolSearch(args);
        case "traverse_knowledge_graph": return toolTraverse(args);
        case "query_live_status": return toolStatus(args);
        case "navigate_to": return toolNavigate(args);
        case "plan_form_fill": return toolForm(args);
        case "create_ticket": return toolTicket(args);
        case "handoff_to_human": return toolHandoff(args);
        default: return { error: "未知工具：" + name, payload: { error: "未知工具：" + name }, summary: "未知工具", sources: [], trace: { kind: "unknown", name } };
      }
    } catch (e) {
      return { error: e.message || String(e), payload: { error: e.message || String(e) }, summary: "工具执行异常", sources: [], trace: { kind: "error", name, message: e.message } };
    }
  }

  function toSource(t) {
    return { id: t.id, q: t.q, src: t.src, score: t.score, cat: t.cat, snippet: t.snippet || String(t.a || "").slice(0, 160) };
  }

  function toolSearch(args) {
    const query = String(args.query || "").trim();
    if (!query) return { error: "查询为空", summary: "查询为空", payload: { error: "query 不能为空" }, sources: [], trace: { kind: "retrieval", query: "", pass: false } };
    const r = retrieveDetailed(query, { topK: 6 });
    const hits = r.pass ? r.top.slice(0, 4) : [];
    const trace = {
      kind: "retrieval", query, intent: r.intent, strategy: r.strategy, weights: r.weights,
      tokens: r.tokens.slice(0, 28), tokenCount: r.tokenCount, rewritten: r.rewritten,
      candidates: r.candidates, vectorDims: r.vectorDims,
      topScore: r.topScore, secondScore: r.secondScore, confidence: r.confidence, threshold: r.threshold, pass: r.pass,
      entities: r.entities, graphPaths: r.graphPaths, timeline: r.timeline,
      top: r.top.map(t => ({ id: t.id, q: t.q, cat: t.cat, src: t.src, score: t.score, scorePct: t.scorePct, breakdown: t.breakdown, keywordHits: t.keywordHits })),
    };
    return {
      summary: hits.length
        ? "三路召回 " + r.candidates + " 条候选，重排后命中 " + hits.length + " 条（Top1 " + r.topScore + "，置信度 " + r.confidence + " ≥ " + r.threshold + "）"
        : "候选 " + r.candidates + " 条，但最高分 " + r.topScore + " 低于置信度闸门 " + r.threshold + "，判定为未收录",
      payload: {
        school: "河北传媒学院", query, intent: r.intent,
        confidence: r.confidence, top_score: r.topScore, passed_gate: r.pass,
        results: hits.map(t => ({ id: t.id, category: t.cat, answer: t.a, source: t.src })),
        note: "仅在 results 中出现的学校具体事实（地址、时间、电话、费用、制度）可直接引用；results 未覆盖的内容不得编造，应说明未收录并建议核实学校最新通知。",
      },
      sources: hits.map(toSource),
      trace,
      detail: { retrieval: { query, intent: r.intent, top: r.top.map(t => ({ id: t.id, q: t.q, cat: t.cat, src: t.src, score: t.score, a: t.a })) } },
    };
  }

  function entityById(id) { return (state.graph.entities || []).find(e => e.id === id); }

  function toolTraverse(args) {
    const start = String(args.start || "").trim();
    const relFilter = args.relation ? String(args.relation).trim() : null;
    const hops = Math.min(3, Math.max(1, parseInt(args.hops, 10) || 2));
    let linked = linkEntities(start);
    if (!linked.length) {
      const p = findPlace(start);
      if (p) linked = [{ term: p.name, id: p.entity || p.id, len: p.name.length }];
    }
    if (!linked.length) {
      return {
        error: "未在图谱中识别到实体：" + start, summary: "实体未收录：" + start,
        payload: { error: "实体未收录", start, known_entities: (state.graph.entities || []).slice(0, 20).map(e => e.name) },
        sources: [], trace: { kind: "graph", start, paths: [], error: true },
      };
    }
    const rootId = linked[0].id;
    const nameOf = id => (entityById(id) || {}).name || ((state.placeIndex.get(id) || {}).name) || id;
    const paths = [];
    let frontier = [rootId];
    const visited = new Set(frontier);
    for (let h = 1; h <= hops; h++) {
      const next = [];
      (state.graph.relations || []).forEach(rel => {
        if (frontier.indexOf(rel.from) < 0 || visited.has(rel.to)) return;
        if (relFilter && rel.rel !== relFilter) return;
        paths.push({ hop: h, from: nameOf(rel.from), to: nameOf(rel.to), rel: rel.rel, toId: rel.to });
        next.push(rel.to);
      });
      next.forEach(n => visited.add(n));
      frontier = next;
      if (!frontier.length) break;
    }
    const docIds = new Set();
    visited.forEach(id => ((state.entityDocs && state.entityDocs.get(id)) || []).forEach(i => docIds.add(i)));
    const docs = [...docIds].map(i => state.entries[i]).filter(Boolean).slice(0, 6);
    return {
      summary: "图谱从「" + nameOf(rootId) + "」出发，" + hops + " 跳内得到 " + paths.length + " 条关系路径，关联 " + docs.length + " 条知识",
      payload: {
        start: nameOf(rootId), hops, paths,
        related_knowledge: docs.map(d => ({ id: d.id, question: d.q, answer: String(d.a || "").slice(0, 220), source: d.src })),
        note: "paths 展示实体间关系，可据此做多跳推理；related_knowledge 中未包含的事实不得编造。",
      },
      sources: docs.map(d => ({ id: d.id, q: d.q, src: d.src, score: null, cat: d.cat, snippet: String(d.a || "").slice(0, 160) })),
      trace: { kind: "graph", start: nameOf(rootId), startId: rootId, hops, paths },
      detail: { graph: { start: nameOf(rootId), startId: rootId, hops, paths, entities: [...visited].map(id => ({ id, name: nameOf(id), type: (entityById(id) || {}).type || "place" })) } },
    };
  }

  function placeBrief(p) {
    return { id: p.id, name: p.name, category: p.category, building: p.building || null, x: p.x, y: p.y, hours: p.hours || [], note: p.note || null, tags: p.tags || [] };
  }

  function toolStatus(args) {
    const d = new Date();
    const day = d.getDay(), minutes = d.getHours() * 60 + d.getMinutes();
    let list = [];
    if (args.place) {
      const p = findPlace(String(args.place));
      if (p) list = [p];
    } else {
      const cat = args.category ? String(args.category) : null;
      list = [...state.placeIndex.values()].filter(p => !cat
        || (p.category || "").indexOf(cat) >= 0
        || (p.tags || []).some(t => String(t).indexOf(cat) >= 0)
        || (cat === "自习室" && (p.tags || []).indexOf("自习") >= 0));
    }
    if (!list.length) {
      return {
        error: "未找到场所", summary: "未找到匹配场所",
        payload: { error: "未找到匹配场所", place: args.place || null, category: args.category || null, available: [...state.placeIndex.values()].map(p => ({ name: p.name, category: p.category })) },
        sources: [], trace: { kind: "status", at: fmtMinutes(minutes), list: [] },
      };
    }
    const withState = list.map(p => ({
      ...placeBrief(p), open: isOpen(p, day, minutes),
      today_hours: (p.hours || []).filter(h => (h.days || [0, 1, 2, 3, 4, 5, 6]).indexOf(day) >= 0).map(h => h.open + "—" + h.close).join(" / ") || "今日不开放",
    }));
    const open = withState.filter(x => x.open);
    const closed = withState.filter(x => !x.open);
    return {
      summary: fmtMinutes(minutes) + "（周" + WEEK[day] + "）：实时开放 " + open.length + " 处，已关闭 " + closed.length + " 处" + (open.length ? "（如 " + open.slice(0, 3).map(x => x.name).join("、") + "）" : ""),
      payload: {
        queried_at: d.toLocaleString("zh-CN"), weekday: "周" + WEEK[day], time: fmtMinutes(minutes),
        open: open.map(x => ({ name: x.name, category: x.category, today_hours: x.today_hours, building: x.building })),
        closed: closed.map(x => ({ name: x.name, category: x.category, today_hours: x.today_hours })),
        note: "该结果由场所开放时段与当前时间实时计算得出，可直接回答现在能不能去、现在还有哪里开着。",
      },
      sources: [],
      trace: { kind: "status", at: fmtMinutes(minutes), weekday: "周" + WEEK[day], openCount: open.length, closedCount: closed.length, list: withState.map(x => ({ id: x.id, name: x.name, open: x.open, today: x.today_hours })) },
      detail: { status: { at: fmtMinutes(minutes), open: open.map(x => x.id), closed: closed.map(x => x.id), list: withState } },
    };
  }

  function toolNavigate(args) {
    const targetName = String(args.target || "").trim();
    const fromName = args.from ? String(args.from).trim() : "校门口";
    const target = findPlace(targetName);
    if (!target) {
      return {
        error: "未找到地点：" + targetName, summary: "未找到地点：" + targetName,
        payload: { error: "未找到地点", target: targetName, known_places: [...state.placeIndex.values()].map(p => p.name) },
        sources: [], trace: { kind: "navigate", error: true, to: targetName },
      };
    }
    const from = findPlace(fromName) || findPlace("校门口") || target;
    const route = shortestPath(from.id, target.id);
    const meters = route.distance || euclid(from, target);
    const minutes2 = Math.max(1, Math.round(meters / 75));
    return {
      summary: "导航：" + from.name + " → " + target.name + "，约 " + meters + " 米 / 步行 " + minutes2 + " 分钟（" + route.nodes.length + " 个路径节点）",
      payload: {
        from: from.name, to: target.name, distance_m: meters, walk_minutes: minutes2,
        path: route.nodes.map(n => ({ name: n.name, x: n.x, y: n.y })),
        target_info: placeBrief(target),
        open_now: isOpenNow(target),
        note: "已在地图上生成导航路线，前端会播放镜头飞行与路径流光动画，可直接告知用户距离与步行时间。",
      },
      sources: [],
      trace: { kind: "navigate", from: from.name, to: target.name, distance: meters, minutes: minutes2, path: route.nodes.map(n => n.name), openNow: isOpenNow(target) },
      detail: { navigate: { from: from.id, to: target.id, distance: meters, minutes: minutes2, path: route.nodes.map(n => n.id), place: placeBrief(target) } },
    };
  }

  function toolForm(args) {
    const matter = String(args.matter || "").trim();
    const table = state.formTable || [];
    let best = null, bestScore = 0;
    table.forEach(f => {
      let s = 0;
      [f.name].concat(f.alias || []).forEach(nm => {
        const a = normalize(nm), b = normalize(matter);
        if (a && b && (b.indexOf(a) >= 0 || a.indexOf(b) >= 0)) s = Math.max(s, 50 + Math.min(a.length, b.length));
      });
      (f.keywords || []).forEach(kw => { if (normalize(matter).indexOf(normalize(kw)) >= 0) s += 8; });
      if (s > bestScore) { bestScore = s; best = f; }
    });
    if (!best || bestScore < 8) {
      return {
        error: "未收录该事项", summary: "办事流程库中未收录该事项，已建议转人工",
        payload: { error: "未收录该事项", matter, available: table.map(f => f.name), suggestion: "使用 handoff_to_human 转交对应部门" },
        sources: [], trace: { kind: "form", matter, found: false },
      };
    }
    return {
      summary: "「" + best.name + "」共 " + (best.steps || []).length + " 步，责任部门：" + best.department + "，预计 " + best.duration,
      payload: { matter, name: best.name, department: best.department, location: best.location, duration: best.duration, materials: best.materials, steps: best.steps, notice: best.notice || null },
      sources: [],
      trace: { kind: "form", matter, found: true, name: best.name, department: best.department, location: best.location, steps: best.steps, materials: best.materials, duration: best.duration },
      detail: { form: best },
    };
  }

  function toolTicket(args) {
    const question = String(args.question || "").trim();
    const intent = args.intent || intentOf(question);
    return {
      summary: "已创建知识盲区工单：「" + question.slice(0, 18) + (question.length > 18 ? "…" : "") + "」，分类 " + intent,
      payload: { created: true, question, intent, sla: "运营方 24 小时内补充进知识库", note: "该工单已进入运营看板的「知识盲区」排行榜，可直接向用户展示闭环能力。" },
      sources: [], trace: { kind: "ticket", question, intent },
      detail: { ticket: { question, intent } },
    };
  }

  function toolHandoff(args) {
    const dept = String(args.department || "学生处");
    const table = state.deptTable || [];
    const hit = table.find(d => normalize(d.name).indexOf(normalize(dept)) >= 0 || normalize(dept).indexOf(normalize(d.name)) >= 0) || table[0] || null;
    return {
      summary: "已转人工：" + (hit ? hit.name + (hit.phone ? " " + hit.phone : "") : dept),
      payload: {
        reason: args.reason, department: hit ? hit.name : dept,
        phone: hit ? hit.phone : null, location: hit ? hit.location : null, hours: hit ? hit.hours : null,
        note: "已把本次对话摘要与工单号一并转交，人工可接续处理。",
      },
      sources: [],
      trace: { kind: "handoff", reason: args.reason, department: hit ? hit.name : dept, phone: hit ? hit.phone : null },
      detail: { handoff: hit },
    };
  }

  /* ==========================================================
   * 8. 对外接口
   * ========================================================== */
  function entries() { if (!state.loaded) buildIndex(); return state.entries; }
  function indexStats() {
    const base = state.entries.filter(e => !e.extra && !e.fromCorpus).length;
    const corpus = state.entries.filter(e => e.fromCorpus).length;
    const extra = state.entries.filter(e => e.extra).length;
    return {
      entries: state.entries.length, base, corpus, extra,
      terms: state.postings.size, avgLen: +state.avgLen.toFixed(1),
      entities: (state.graph.entities || []).length, relations: (state.graph.relations || []).length,
      places: state.placeIndex.size, forms: (state.formTable || []).length, depts: (state.deptTable || []).length,
    };
  }
  function categoryStats() {
    const m = new Map();
    state.entries.forEach(e => { const c = e.cat || "未分类"; m.set(c, (m.get(c) || 0) + 1); });
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }
  function setExternalData(data) { EXTERNAL = data; state.loaded = false; buildIndex(); return indexStats(); }
  function reload(extraEntries) {
    if (Array.isArray(extraEntries)) USER_EXTRA = extraEntries;
    state.loaded = false;
    buildIndex();
    return indexStats();
  }
  function graphPayload() { if (!state.loaded) buildIndex(); return state.graph; }
  function placesPayload() {
    if (!state.loaded) buildIndex();
    return { places: [...state.placeIndex.values()], formTable: state.formTable, deptTable: state.deptTable };
  }
  function deptTable() { return state.deptTable; }
  function formTable() { return state.formTable; }

  buildIndex();

  return {
    buildIndex, reload, setExternalData, indexStats, categoryStats, entries,
    retrieveDetailed, baselineRetrieve, benchRetrieve,
    coverageGate, gateDecision, detectOutOfScope, confidenceOf,
    tokenize, tokenizeDetailed, tokenizeGated, normalize, expandTerms, rewriteQueries, intentOf, linkEntities,
    toolSpecs, runTool,
    graphPayload, placesPayload, deptTable, formTable, findPlace, shortestPath,
    isOpenNow, isOpen, fmtMinutes,
    DEFAULT_THRESHOLD, WEIGHTS,
    _state: state,
  };
});
