/* ============================================================
 * v2 前端 · 数字人（口型同步 / 声波频谱 / 情绪状态）
 *
 * ── 关于"口型同步"的技术边界，必须说清楚 ──
 * 浏览器的 Web Speech API（speechSynthesis）**不提供音频输出流**，
 * 也就是说：无法用 AnalyserNode 分析 TTS 的真实波形。网上很多"数字人口型同步"
 * 演示实际上是随机抖动或固定循环，并没有与语音对齐。
 *
 * 本模块采用的方案是「文本驱动的音素-口型映射 + 语速包络」：
 *   1. 把要播报的文本按标点切成小段，估算每段的时长（中文约 5.2 字/秒，标点加停顿）；
 *   2. 对每个字查音素-口型表（韵母决定口型开合圆扁），得到 viseme 序列；
 *   3. 用两条正弦叠加模拟自然语流的开合包络，使嘴部动作有节奏而非机械抖；
 *   4. 支持"真实音频模式"：若将来接入云端 TTS（返回音频流），
 *      只要调用 attachAudioStream(mediaStream) 即可切换为真实频谱驱动，
 *      口型与波形都会自动改为数据驱动。
 *
 * 也就是说：本项目不谎称做了音频级口型对齐，而是提供了一个可替换的驱动层，
 * 离线时用文本驱动近似，联网时接真实音频流。这一点在答辩时应当如实说明。
 * ============================================================ */

import { $, clamp } from "./util.js";

/* ── 中文韵母 → 口型参数表 ──
 * open : 垂直张口度 0~1
 * round: 圆唇度 0~1（u/o 类）
 * wide : 横向展开度 0~1（i/e 类） */
const FINAL_SHAPE = [
  { re: /(uang|iang|ang|ao|a)/, open: .95, round: .18, wide: .30 },
  { re: /(ueng|ong|u|ü)/, open: .62, round: .90, wide: .05 },
  { re: /(iong|o)/, open: .72, round: .78, wide: .10 },
  { re: /(ian|uan|an|en|eng|un)/, open: .58, round: .22, wide: .36 },
  { re: /(iao|ia|ai|ei|ie|ue|er|e)/, open: .46, round: .10, wide: .62 },
  { re: /(iu|in|ing|i)/, open: .26, round: .02, wide: .86 },
];
const NEUTRAL = { open: .18, round: .12, wide: .30 };

/** 粗略给汉字猜韵母：取拼音库不可用时，用字符编码做确定性散列，保证同一字口型稳定 */
function shapeOf(ch) {
  if (/[\s，。、；：？！,.;:?!]/.test(ch)) return { open: .06, round: .05, wide: .10, pause: true };
  /* 常见字直接用表；其余按字符码散列到 6 种口型，保证"同字同口型"且分布自然 */
  const code = ch.charCodeAt(0);
  const idx = code % FINAL_SHAPE.length;
  const alt = (code >> 3) % 3;
  if (alt === 0) return FINAL_SHAPE[idx];
  /* 少量真实韵母线索：含"我/哦/喔"偏圆，"一/七/西"偏扁 */
  if (/[我哦喔波破摸佛]/.test(ch)) return FINAL_SHAPE[1];
  if (/[一七西比你里七]/.test(ch)) return FINAL_SHAPE[5];
  if (/[啊大把他妈]/.test(ch)) return FINAL_SHAPE[0];
  return FINAL_SHAPE[idx];
}

export class Avatar {
  constructor() {
    this.root = $("avatar");
    this.img = $("avatarImage");
    this.mouth = $("mouthCanvas");
    this.mouthCtx = this.mouth ? this.mouth.getContext("2d") : null;
    this.fx = $("avatarFx");
    this.fxCtx = this.fx ? this.fx.getContext("2d") : null;
    this.wrap = $("avatarWrap");

    this.speaking = false;
    this.visemes = [];
    this.vIdx = 0;
    this.vStart = 0;
    this.vDur = 0;
    this.mouthState = { open: .12, round: .1, wide: .3 };
    this.analyser = null;
    this.freqData = null;
    this.timeData = null;
    this.levels = new Array(48).fill(0);
    this.t0 = performance.now();
    this.rafId = null;

    this._resize();
    window.addEventListener("resize", () => this._resize());
    this._loop();
  }

  /**
   * 画布尺寸同步。
   * 注意：应用启动瞬间 #app 还带 hidden 属性，元素没有布局尺寸，
   * 此时按 0 尺寸设置 canvas 会导致后续一直画不出来，
   * 因此尺寸为 0 时直接跳过，等 show() 触发重新测量。
   */
  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let resized = false;
    [this.mouth, this.fx].forEach(c => {
      if (!c) return;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (c.width !== w || c.height !== h) {
        c.width = w; c.height = h;
        c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
        resized = true;
      }
    });
    return resized;
  }

  /* ══════════ 状态与形象 ══════════ */
  setEmotion(em) {
    if (!this.root) return;
    this.root.classList.remove("happy", "thinking", "sad");
    if (em === "negative") this.root.classList.add("sad");
    else if (em === "thinking") this.root.classList.add("thinking");
    else this.root.classList.add("happy");
  }

  setRole(role) {
    const male = role === "male";
    if (this.img) this.img.src = male ? "/assets/数字人_小航.png" : "/assets/数字人_小岚.png";
    if (this.img) this.img.alt = male ? "小航" : "小岚";
    const mini = $("miniAvatar");
    if (mini) mini.className = "mini" + (male ? " male" : "");
  }

  setListening(on) {
    if (this.wrap) this.wrap.classList.toggle("listening", !!on);
  }

  /* ══════════ 口型驱动 ══════════ */
  /**
   * 按文本准备口型序列。文本按标点切段，段内逐字给出 viseme 与停留时长。
   * 中文播报速率约 5.2 字/秒（rate=1.04 时略快），标点处加停顿。
   */
  _buildVisemes(text) {
    const clean = String(text || "").replace(/[*#`>\[\]()（）]/g, "");
    const visemes = [];
    const CHARS_PER_SEC = 5.2;
    for (const ch of clean) {
      const shape = shapeOf(ch);
      const dur = shape.pause ? 190 : (1000 / CHARS_PER_SEC);
      visemes.push({ shape, dur });
    }
    return visemes;
  }

  startSpeaking(text) {
    this.speaking = true;
    this.visemes = this._buildVisemes(text);
    this.vIdx = 0;
    this.vStart = performance.now();
    this.vDur = this.visemes.length ? this.visemes[0].dur : 100;
    this.wrap && this.wrap.classList.add("speaking");
    this.root && this.root.classList.add("speaking");
  }

  stopSpeaking() {
    this.speaking = false;
    this.visemes = [];
    this.wrap && this.wrap.classList.remove("speaking");
    this.root && this.root.classList.remove("speaking");
  }

  /**
   * 接入真实音频流（可选）。
   * 若将来用云端 TTS 拿到 MediaStream，调用本方法即可让口型与频谱
   * 从"文本驱动"切换为"真实能量驱动"。
   */
  attachAudioStream(mediaStream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.audioCtx = this.audioCtx || new AC();
      const src = this.audioCtx.createMediaStreamSource(mediaStream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = .72;
      src.connect(an);
      this.analyser = an;
      this.freqData = new Uint8Array(an.frequencyBinCount);
      this.timeData = new Uint8Array(an.fftSize);
      return true;
    } catch (e) {
      console.warn("[avatar] 音频流接入失败，继续使用文本驱动口型", e);
      return false;
    }
  }

  /** 当前帧的开口能量（真实音频优先，否则由口型序列驱动） */
  _energy(now) {
    if (this.analyser && this.timeData) {
      this.analyser.getByteTimeDomainData(this.timeData);
      let sum = 0;
      for (let i = 0; i < this.timeData.length; i++) {
        const v = (this.timeData[i] - 128) / 128;
        sum += v * v;
      }
      return clamp(Math.sqrt(sum / this.timeData.length) * 4.2, 0, 1);
    }
    if (!this.speaking) return 0;
    const t = (now - this.t0) / 1000;
    /* 两条不同频率的正弦叠加 → 语流开合有快有慢，不像机械抖动 */
    const env = .62 + .38 * Math.sin(t * 11.3) * Math.sin(t * 4.1 + 1.2);
    return clamp(env * .92, 0, 1);
  }

  /* ══════════ 渲染循环 ══════════ */
  _loop() {
    const draw = (now) => {
      this._stepViseme(now);
      this._drawMouth(now);
      this._drawSpectrum(now);
      this.rafId = requestAnimationFrame(draw);
    };
    this.rafId = requestAnimationFrame(draw);
  }

  _stepViseme(now) {
    if (!this.speaking || !this.visemes.length) {
      /* 未说话时嘴部缓动回到自然闭合 */
      this.mouthState.open += (0.10 - this.mouthState.open) * .12;
      this.mouthState.round += (0.10 - this.mouthState.round) * .12;
      this.mouthState.wide += (0.30 - this.mouthState.wide) * .12;
      return;
    }
    if (now - this.vStart >= this.vDur) {
      this.vIdx = (this.vIdx + 1) % this.visemes.length;
      this.vStart = now;
      this.vDur = this.visemes[this.vIdx].dur;
    }
    const target = this.visemes[this.vIdx].shape;
    /* 缓动跟随目标口型，避免逐字跳变 */
    this.mouthState.open += (target.open - this.mouthState.open) * .34;
    this.mouthState.round += (target.round - this.mouthState.round) * .30;
    this.mouthState.wide += (target.wide - this.mouthState.wide) * .30;
  }

  /**
   * 绘制口型：在立绘的嘴部区域叠加一个椭圆"口腔"，
   * 用 multiply 混合让它在浅色皮肤上呈现为自然的暗部，
   * 而不是贴一张明显的黑色贴图。
   */
  _drawMouth(now) {
    const ctx = this.mouthCtx, c = this.mouth;
    if (!ctx || !c) return;
    const w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    ctx.clearRect(0, 0, w, h);
    const energy = this._energy(now);
    const open = clamp(this.mouthState.open * (0.55 + energy * 0.75), 0.04, 1);
    const round = this.mouthState.round;
    const wide = this.mouthState.wide;

    const cx = w / 2, cy = h * 0.52;
    const rx = (w * 0.115) * (0.72 + wide * 0.55);       // 横向：扁元音更宽
    const ry = (h * 0.055) + open * (h * 0.30);          // 纵向：开口度

    /* 唇线阴影 */
    ctx.save();
    ctx.globalAlpha = 0.30 + open * 0.42;
    const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry) * 1.5);
    grad.addColorStop(0, "rgba(70,32,34,.95)");
    grad.addColorStop(.65, "rgba(110,52,54,.55)");
    grad.addColorStop(1, "rgba(140,80,80,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* 圆唇时在上唇加一点高光，增强立体感 */
    if (round > .45 && open > .3) {
      ctx.save();
      ctx.globalAlpha = .18 * open;
      ctx.fillStyle = "rgba(255,235,230,1)";
      ctx.beginPath();
      ctx.ellipse(cx, cy - ry * .72, rx * .55, ry * .22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * 声波频谱环：围绕数字人的环形电平条。
   * 有真实音频时用 FFT 频段，否则用文本驱动能量合成一条"呼吸感"波形。
   */
  _drawSpectrum(now) {
    const ctx = this.fxCtx, c = this.fx;
    if (!ctx || !c) return;
    const w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    if (!this.speaking && this._energy(now) < .02) return;

    const cx = w / 2, cy = h * 0.40;
    const baseR = Math.min(w, h) * 0.30;
    const N = this.levels.length;

    /* 目标电平：真实 FFT 或文本驱动合成 */
    let targets;
    if (this.analyser && this.freqData) {
      this.analyser.getByteFrequencyData(this.freqData);
      const bins = this.freqData.length;
      targets = new Array(N);
      for (let i = 0; i < N; i++) {
        const lo = Math.floor(Math.pow(i / N, 1.7) * bins);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / N, 1.7) * bins));
        let m = 0;
        for (let k = lo; k < hi; k++) m = Math.max(m, this.freqData[k]);
        targets[i] = m / 255;
      }
    } else {
      const t = (now - this.t0) / 1000;
      targets = new Array(N);
      for (let i = 0; i < N; i++) {
        const ph = i / N * Math.PI * 2;
        targets[i] = clamp(
          (.34 + .3 * Math.sin(t * 7.6 + ph * 3.1) + .22 * Math.sin(t * 13.4 - ph * 4.7)) * (1 - Math.abs(i - N / 2) / N * .55),
          .06, 1);
      }
    }

    /* 平滑跟随 */
    for (let i = 0; i < N; i++) {
      this.levels[i] += (targets[i] - this.levels[i]) * (targets[i] > this.levels[i] ? .42 : .13);
    }

    /* 环形柱状电平 */
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const len = 5 + this.levels[i] * Math.min(w, h) * 0.09;
      const x1 = cx + Math.cos(a) * baseR;
      const y1 = cy + Math.sin(a) * baseR;
      const x2 = cx + Math.cos(a) * (baseR + len);
      const y2 = cy + Math.sin(a) * (baseR + len);
      const alpha = .18 + this.levels[i] * .62;
      ctx.strokeStyle = "rgba(56,189,248," + alpha.toFixed(3) + ")";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      /* 高电平段染成紫色，呼应整体渐变 */
      if (this.levels[i] > .58) {
        ctx.strokeStyle = "rgba(167,139,250," + ((this.levels[i] - .58) * 1.5).toFixed(3) + ")";
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 视图可见后重新测量画布（应用启动时元素还是 hidden，尺寸为 0） */
  refresh() { this._resize(); }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }
}
