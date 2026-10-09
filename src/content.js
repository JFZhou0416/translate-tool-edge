/**
 * 屏幕翻译 · content script
 * 只负责 DOM：找段落 → 编号分块 → 交给 background 翻译 → 把译文插到原文下方 → 支持还原
 * （⚠️ 绝不在这里 fetch —— CORS 会拦，见计划书 §3.2）
 *
 * 段落识别规则照抄计划书 §3.4：
 *   可见 / 有内容 / 不是已译 / 去嵌套重复 / 跳过代码 / 跳过已是中文
 */
(() => {
  const CLS = "st-trans";
  const DONE = "data-st-done";
  const CAND = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption";

  // ---------------------------------------------------------------- T1（第 3 轮）叶级文本容器
  // 病根：卡片标题常写成 <a>/<div>/<span>（NexusMods 的新闻卡、mod 卡都是这样），
  //       一条 CAND 都命不中 → 框选时既没有虚线、点了也没反应，整页翻译同样整片漏掉。
  // 修法：CAND 之外再认一类"叶级文本容器"——**自己有直接文本** + **不含块级子元素**，
  //       这样命中的是标题本身，不会一选就选中整张卡片。
  //       整页模式照样收录它们，但额外过一遍 leafExcluded()（不翻按钮 / UI 标签）。
  const LEAF = "a, span, div, strong, em, b, i, small, label, button, figcaption";
  const LEAF_BLOCK = "div, p, ul, ol, table, section, article, h1, h2, h3, h4, h5, h6";
  const LEAF_ZONE = "nav, header, footer, aside, [role=menu], [role=navigation]";
  const ALL_CAND = CAND + ", " + LEAF;

  // 常见 UI 词（叶级候选的排除项之一）：整段文本**一字不差**命中才算，
  // 所以「Damage Meter」这类标题不受影响，只有「Download」「View all」这种标签被挡。
  const UI_WORDS = new Set([
    "login", "log in", "sign in", "signin", "sign up", "signup", "sign out", "logout", "log out", "register",
    "search", "menu", "more", "view all", "see all", "show all", "load more", "view more", "read more", "learn more", "show more",
    "share", "download", "upload", "submit", "cancel", "close", "open", "back", "next", "previous", "prev",
    "save", "edit", "delete", "remove", "skip", "continue", "confirm", "apply", "reset", "clear", "accept", "decline",
    "ok", "yes", "no", "home", "help", "settings", "profile", "account", "cart", "buy now", "add to cart",
    "follow", "unfollow", "like", "reply", "subscribe", "unsubscribe", "install",
    "filter", "filters", "sort", "browse", "explore", "loading", "please wait", "copy", "paste", "print",
  ]);

  // ---------------------------------------------------------------- T3（第 3 轮）脚本版本
  // 扩展更新后，**已经打开的页面还跑着旧 content script**（解压扩展不会自动重载，页面更不会自己换脚本）。
  // 下面两个值是**编进脚本里的常量**：旧页面跑的是旧代码，回上来的自然是旧值 → popup 一比对就知道"本页需刷新"。
  const PI = 2;                    // 消息协议版本：以后协议不兼容就 +1（popup.js 里的 NEED_PI 要跟着改）
  const SCRIPT_VERSION = "0.3.1";  // ⚠️ 每轮交付跟 manifest.json 的 version 一起升（见 README 的交付约定）

  const state = {
    running: false, done: 0, total: 0, errors: [], lastSummary: "",
    pending: 0,        // T3：本页还剩多少段没翻
    replayed: 0,       // T3：刷新后从进度缓存里补回来的段数
    selecting: false,  // T4：是否在框选模式
    selectedCount: 0,  // T4：已选段数
    region: false,     // 第 4 轮：是否在区域模式（拖框翻译）
    auto: false,       // 第 5 轮：是否正在「一键翻完剩余」（popup 轮询 status 就看这个字段）
    autoStop: false,   // 第 5 轮：点「停止」→ 置 true，手里这一块收尾就停（不打断已经在飞的那次请求）
    theme: null,       // T2：本页实际用的配色（诊断用，status 里能看到）
    regionDebug: null, // 第 4 轮：上一次区域翻译的关键数字（矩形 / 裁剪 / 送出去的图尺寸 / 模型 / 耗时）—— status 里能看到，方便 CDP 复验
  };
  const MAX_BLOCK_CHARS = 200;   // 单段超过它 → 单独成块

  // =============================================================== T2 译文配色
  // 判据优先级：① 页面实际背景亮度（主） ② prefers-color-scheme（只兜底）
  // ⚠️ 只看 media query 是上一版的病根：深色网站 + 浅色系统 → 判反 → 字看不清。

  const LIGHT_THEME = { fg: "#4a5878", border: "#7aa2f7", bg: "transparent" };
  const DARK_THEME = { fg: "#b9c6e6", border: "#4f7bd9", bg: "transparent" };
  const MIN_CONTRAST = 4.5;        // 验收要求：文字与背景对比度 ≥ 4.5:1
  const DARK_BG_THRESHOLD = 0.5;   // 相对亮度 L < 0.5 视为深色底

  function parseCssColor(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    m = s.match(/^rgba?\(([^)]*)\)$/i);
    if (!m) return null;
    const parts = m[1].split(/[,\s\/]+/).filter((x) => x !== "");
    if (parts.length < 3) return null;
    const num = (v) => (v.endsWith("%") ? Number(v.slice(0, -1)) * 2.55 : Number(v));
    const r = num(parts[0]), g = num(parts[1]), b = num(parts[2]);
    if (![r, g, b].every(Number.isFinite)) return null;
    let a = 1;
    if (parts[3] != null) a = parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
    if (!Number.isFinite(a)) a = 1;
    return { r, g, b, a };
  }

  function srgbLinear(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function relLuminance(c) {
    return 0.2126 * srgbLinear(c.r) + 0.7152 * srgbLinear(c.g) + 0.0722 * srgbLinear(c.b);
  }
  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function toHex(c) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  /** 页面实际背景：body → html；都没有不透明底色时，才退回 prefers-color-scheme */
  function autoDetect() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      let style = null;
      try { style = getComputedStyle(el); } catch { continue; }
      const c = parseCssColor(style && style.backgroundColor);
      if (c && c.a >= 0.9) return { bgLum: relLuminance(c), source: "page" };
    }
    let dark = false;
    try { dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); } catch { /* 拿不到就当浅色 */ }
    return { bgLum: dark ? 0 : 1, source: "media-query" };
  }

  /** 对比度不够时，把文字色往能拉开差距的那一侧挪，直到 ≥ 4.5:1（最多挪 40 步）。
   *  方向先算「纯黑/纯白哪个更亮得开」——中灰底(#808080 一类)上这一步很关键：
   *  按"深色方案"给的白字在那种底上最多 3.95:1，只有压暗才够 4.5。 */
  function ensureContrast(hex, bgLum) {
    let c = parseCssColor(hex);
    if (!c) return { fg: hex, contrast: null, adjusted: false };
    const goDarker = contrastRatio(0, bgLum) >= contrastRatio(1, bgLum);
    let guard = 0;
    while (contrastRatio(relLuminance(c), bgLum) < MIN_CONTRAST && guard++ < 40) {
      // 每一步就取整：这样"判达标用的颜色"和"最终写进 CSS 的颜色"是同一个，
      // 不会出现"内部算 4.51、落到路上变 4.49"的擦边情况
      c = goDarker
        ? { r: Math.round(c.r * 0.92), g: Math.round(c.g * 0.92), b: Math.round(c.b * 0.92), a: 1 }
        : { r: Math.round(c.r + (255 - c.r) * 0.08), g: Math.round(c.g + (255 - c.g) * 0.08), b: Math.round(c.b + (255 - c.b) * 0.08), a: 1 };
    }
    let contrast = contrastRatio(relLuminance(c), bgLum);
    if (contrast < MIN_CONTRAST) {          // 兜底：直接取极值（这个底色上能做到的最好）
      c = goDarker ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
      contrast = contrastRatio(relLuminance(c), bgLum);
    }
    return { fg: toHex(c), contrast, adjusted: guard > 0 };
  }

  function resolveTheme(settings) {
    const s = settings || {};
    const mode = ["auto", "light", "dark", "custom"].includes(s.colorMode) ? s.colorMode : "auto";
    if (mode === "light") return { mode, ...LIGHT_THEME, source: "forced" };
    if (mode === "dark") return { mode, ...DARK_THEME, source: "forced" };
    if (mode === "custom") {
      return {
        mode, source: "custom",
        fg: s.stFg || LIGHT_THEME.fg,
        border: s.stBorder || LIGHT_THEME.border,
        bg: s.stBgOn ? (s.stBg || "transparent") : "transparent",
      };
    }
    const det = autoDetect();
    const dark = det.bgLum < DARK_BG_THRESHOLD;
    const preset = dark ? DARK_THEME : LIGHT_THEME;
    const guard = ensureContrast(preset.fg, det.bgLum);
    return {
      mode, source: det.source, bgLum: det.bgLum, dark,
      fg: guard.fg, contrast: guard.contrast, adjusted: guard.adjusted,
      border: preset.border,
      bg: preset.bg,
    };
  }

  /** 注入 :root 的 CSS 变量。用 CSSOM（style.setProperty）而不是 <style> 元素：
   *  <style> 会被页面 CSP 拦，CSSOM 不会，而且落在 :root 上就是规格要的那三个变量。 */
  function applyTheme(settings) {
    const theme = resolveTheme(settings);
    try {
      const root = document.documentElement;
      if (root) {
        root.style.setProperty("--st-fg", theme.fg);
        root.style.setProperty("--st-border", theme.border);
        root.style.setProperty("--st-bg", theme.bg);
      }
    } catch { /* 极少数页面结构怪，就当没主题，别让翻译挂掉 */ }
    state.theme = theme;
    return theme;
  }

  // ---------------------------------------------------------------- 设置读取

  let cachedSettings = null;
  async function getSettings(force) {
    if (cachedSettings && !force) return cachedSettings;
    let s = {};
    try {
      const cfg = await chrome.runtime.sendMessage({ type: "getSettings" });
      s = (cfg && cfg.settings) || {};
    } catch { /* service worker 没醒/扩展刚重载 → 用默认值兜底，别抛 */ }
    cachedSettings = s;
    return s;
  }

  // 设置改了 → 立刻作废缓存；已打开的页面下次交互（或马上）就能用上新配色
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    cachedSettings = null;
    getSettings().then(applyTheme).catch(() => { /* 忽略 */ });
  });

  const hasCJK = (s) => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
  const cjkRatio = (s) => {
    const t = s.replace(/\s/g, "");
    if (!t) return 0;
    return (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length / t.length;
  };

  function visible(el) {
    try { return el.getClientRects().length > 0; } catch { return false; }
  }
  function inCode(el) {
    return !!el.closest("pre, code, kbd, samp");
  }
  function alreadyTranslated(el) {
    return el.classList.contains(CLS) || el.hasAttribute(DONE) ||
           !!el.querySelector("." + CLS) || el.closest("." + CLS) !== null;
  }

  const cleanText = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  /** 这段够不够格翻？够就给出它的文本，不够给 null。
   *  ⭐ 整页翻译和 T4 框选共用这一套规则，避免两边判得不一样。 */
  function candidateText(el, allowDone) {
    if (!el || el.nodeType !== 1) return null;
    if (!visible(el) || inCode(el)) return null;
    if (el.closest && el.closest("." + CLS)) return null;    // 我们插的译文节点内部不算
    if (!allowDone && alreadyTranslated(el)) return null;    // 已翻过的跳过（T4 也不重复插）
    const text = cleanText(el);
    if (text.length < 2) return null;
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return null;
    if (cjkRatio(text) > 0.5) return null;                   // 已经是中文 → 不翻（防误翻：中文再过一遍会翻成乱码）
    return text;
  }

  // =============================================================== T1 叶级文本容器的判据

  /** 元素**自己**的直接文本（只拼文本节点，不含子元素里的字） */
  function directText(el) {
    let s = "";
    for (const n of el.childNodes || []) if (n.nodeType === 3) s += n.textContent;
    return s.replace(/\s+/g, " ").trim();
  }

  /** 在不该翻的区域里？导航 / 页眉 / 页脚 / 侧栏 / 菜单 */
  function inChromeZone(el) {
    try { return !!el.closest(LEAF_ZONE); } catch { return true; }   // 选择器跑不了就当"在不该翻的区域"→ 宁可少翻
  }

  /** 叶级文本容器：自己有直接文本（≥2 字）+ 不含块级子元素 + 不在译文里 + 不在导航区 */
  function leafTextContainer(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return false;
    try { if (!el.matches(LEAF)) return false; } catch { return false; }
    if (el.closest && el.closest("." + CLS)) return false;     // 我们插的译文节点内部不算
    if (inChromeZone(el)) return false;
    if (directText(el).length < 2) return false;               // 自己没有直接文本 ⇒ 只是个壳子
    let block = null;
    try { block = el.querySelector(LEAF_BLOCK); } catch { return false; }
    return !block;                                             // 含块级子元素 ⇒ 是卡片/容器，不是标题
  }

  /** 叶级候选的"防误翻"排除（整页模式与框选共用，两边判断保持一致）。
   *  返回非空字符串 = 排除原因（自检脚本会把这个原因打出来），空串 = 可以翻。 */
  function leafExcluded(el, text) {
    const t = String(text || "").trim();
    if (t.length < 2) return "太短";
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff]/.test(t)) return "没有可翻的字（纯数字/纯符号）";
    if (/^[vV]?\d+(\.\d+)*$/.test(t)) return "版本号/编号（纯数字/纯符号）";
    if (UI_WORDS.has(t.toLowerCase())) return "常见 UI 词（多半是按钮/导航标签）";
    const same = (v) => !!v && v.replace(/\s+/g, " ").trim().toLowerCase() === t.toLowerCase();
    try {
      if (same(el.getAttribute("href")) || same(el.getAttribute("title")) || same(el.getAttribute("aria-label"))) {
        return "文本与 href/title/aria-label 相同（按钮/链接标签）";
      }
    } catch { /* 拿不到属性就当没命中 */ }
    try { if (el.closest("button, [role=button], input")) return "在按钮/输入控件内"; } catch { /* 忽略 */ }
    return "";
  }

  /** 页面里的"段落清单"（含已翻过的，占着同一个编号 → 编号跨批次/跨刷新都稳定） */
  function collectAll() {
    const kept = [];
    for (const el of Array.from(document.querySelectorAll(ALL_CAND))) {  // 文档顺序 → 祖先先出现（含 T1 的叶级文本容器）
      const plain = el.matches(CAND);                        // CAND 里的走老规矩，一个字不变
      if (!plain && !leafTextContainer(el)) continue;         // T1：叶级容器先过自己的判据（直接文本 + 无块级子元素 + 不在导航区）
      const text = candidateText(el, true);
      if (text === null) continue;
      if (!plain && leafExcluded(el, text)) continue;         // T1：叶级候选再过一遍"防误翻"（按钮/UI 标签/与 href 同名）
      // 去嵌套：跟已选中的互为祖先/后代 → 跳过（同一张卡片里收了标题就不再收它的碎片）
      if (kept.some((k) => k.el === el || k.el.contains(el) || el.contains(k.el))) continue;
      kept.push({ el, text, done: alreadyTranslated(el) });
    }
    return kept.map((it, i) => ({ el: it.el, id: i + 1, text: it.text, done: it.done }));
  }

  /** 还没翻的段落（T1 的"去重跳过已翻"就靠这里） */
  function collectSegments() {
    return collectAll().filter((it) => !it.done);
  }

  /** 按字符数分块（编号协议 §3.3） */
  function chunk(items, limit) {
    const chunks = [];
    let cur = [], curLen = 0;
    for (const it of items) {
      const t = `[[${it.id}]] ${it.text}\n`;
      if (it.text.length > MAX_BLOCK_CHARS) {        // 超长段单独成块
        if (cur.length) { chunks.push(cur); cur = []; curLen = 0; }
        chunks.push([it]);
        continue;
      }
      if (curLen + t.length > limit && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
      cur.push(it); curLen += t.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  function insertAfter(item, translated) {
    try {
      const node = document.createElement("div");
      node.className = CLS;
      node.setAttribute("data-st-for", String(item.id));
      node.textContent = translated;
      const tag = item.el.tagName.toLowerCase();
      if (tag === "td" || tag === "th") {
        item.el.appendChild(node);               // 表格单元里往里塞，别破坏表格结构
      } else {
        item.el.insertAdjacentElement("afterend", node);
      }
      item.el.setAttribute(DONE, "1");
      return true;
    } catch { return false; }
  }

  function restoreDom() {
    document.querySelectorAll("." + CLS).forEach((n) => n.remove());
    document.querySelectorAll("[" + DONE + "]").forEach((n) => n.removeAttribute(DONE));
    state.errors = [];
    state.done = 0; state.total = 0; state.pending = 0; state.replayed = 0;
    return true;
  }

  // =============================================================== T3 分批续翻
  // 病根：老版本按 maxBlocksPerPage 硬砍（超出的段静默不翻），且单块失败整页停摆。
  // 现在：
  //   · 点一次「翻译」＝翻一批（默认 300 段），没翻完不硬砍，popup 出「一键翻完剩余 n 段」
  //     第 5 轮：点那个按钮 = 自动接着往下翻（每批之间不停，随时能停）—— 单批逻辑一个字没动
  //   · 单块 25s 超时（必须 < MV3 service worker 的 30s 回收窗口）+ 失败自动重试 1 次，
  //     仍失败只记一条 error 继续下一块 —— 一块坏不影响其它块
  //   · 每块的译文 + 进度写 chrome.storage.session（按 URL 记，local 兜底）
  //     → 刷新页面后先按缓存把翻过的补回来，再从断点接着翻，同一段不会翻第二遍

  const REQUEST_TIMEOUT_MS = 25000;    // 与 background.js 里的 fetch 超时对齐
  const RETRY_TIMES = 1;
  const DEFAULT_MAX_BLOCKS = 300;
  const PROGRESS_PREFIX = "st:progress:";

  function progressKey() {
    let href = "";
    try { href = String(location.href || "").split("#")[0]; } catch { /* file:// 等怪情况 */ }
    return PROGRESS_PREFIX + href;
  }

  /** 段落指纹：只用来判断"这一段还是不是原来那一段"，页面变了就不乱补译文 */
  function textHash(s) {
    const t = String(s || "");
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return h;
  }

  // content script 默认读不到 storage.session（要 background 开 access level），所以各自兜底到 local
  const store = {
    async get(key) {
      try { const got = await chrome.storage.session.get(key); if (got && got[key]) return got[key]; } catch { /* 往下走 */ }
      try { const got = await chrome.storage.local.get(key); return (got && got[key]) || null; } catch { return null; }
    },
    async set(key, val) {
      try { await chrome.storage.session.set({ [key]: val }); return true; } catch { /* 往下走 */ }
      try { await chrome.storage.local.set({ [key]: val }); return true; } catch { return false; }
    },
    async remove(key) {
      try { await chrome.storage.session.remove(key); } catch { /* 忽略 */ }
      try { await chrome.storage.local.remove(key); } catch { /* 忽略 */ }
    },
  };

  async function readProgress() { return await store.get(progressKey()); }
  async function writeProgress(rec) { rec.updatedAt = Date.now(); await store.set(progressKey(), rec); }
  async function clearProgress() { await store.remove(progressKey()); }

  /**
   * 当前页进度快照。
   * fresh（刷新过的页面 ⇒ DOM 里没有译文了）时按缓存数出"能补回来的前缀长度" replayed。
   */
  async function snapshot() {
    const all = collectAll();
    const items = all.filter((it) => !it.done);
    const rec = await readProgress();
    const fresh = !!(rec && rec.items) && !document.querySelector("." + CLS);
    let replayed = 0;
    if (fresh) {
      for (const it of items) {
        const c = rec.items[String(it.id)];
        if (!c || c.h !== textHash(it.text)) break;   // 页面变了/缓存断了 → 从这一段重新开始
        replayed++;
      }
    }
    const total = all.length;
    // 没刷新时：DOM 里现成的译文数（含框选翻的那些）也算数，别把进度显示成 0
    const domDone = Math.max(0, total - items.length);
    const done = fresh ? replayed : Math.max(Math.min((rec && rec.done) || 0, total), domDone);
    return { items, rec, fresh, replayed, done, total, remaining: Math.max(0, total - done) };
  }

  /** 刷新过的页面：把上一次已翻好的段落按序补回页面（防重复请求同一段） */
  function replayCached(items, rec) {
    let n = 0;
    for (const it of items) {
      const c = rec.items[String(it.id)];
      if (!c || c.h !== textHash(it.text)) break;
      if (!insertAfter(it, c.t)) break;
      n++;
    }
    state.replayed = n;
    return n;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 给 sendMessage 套自己的超时：万一后台被回收、消息通道断了，别永久挂着 */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** 一块一次请求；失败自动重试 RETRY_TIMES 次，仍失败返回 null（调用方记 error 继续下一块） */
  async function requestChunk(items, errors) {
    const payload = items.map(({ id, text }) => ({ id, text }));
    let lastErr = "";
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
      try {
        const res = await withTimeout(
          chrome.runtime.sendMessage({ type: "translate", items: payload }),
          REQUEST_TIMEOUT_MS + 5000,
          `请求超过 ${(REQUEST_TIMEOUT_MS + 5000) / 1000} 秒没回来（后台可能被回收了）`,
        );
        if (res && res.ok) return res;
        lastErr = (res && res.error) || "后台没返回结果";
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
      if (attempt < RETRY_TIMES) await sleep(800);   // 退避一下再重试
    }
    errors.push(lastErr || "未知错误");
    return null;
  }

  // ---------------------------------------------------------------- 主流程

  async function translatePage(limit) {
    if (state.running) return { ok: false, error: "正在翻译中" };
    if (!state.auto) state.autoStop = false;   // 第 5 轮：手动翻一批＝先清掉上一次的「停止」标记（自动翻时由 translateAll 自己管）

    if (state.selecting) await exitSelectMode({ translate: false });   // T4：整页翻译＝先退出框选
    if (state.region) exitRegionMode();                                // 第 4 轮：整页翻译＝先退出区域模式

    const snap = await snapshot();
    if (!snap.items.length) {
      // ⚠️ T1：早退分支也必须带全 done/total/summary，
      //    否则 popup 的兜底模板会拼出「翻完 undefined/undefined 段」
      //    判定：页面里存在 .st-trans ⇒ 是"已经翻过"，否则是"本来就没得翻"
      state.lastSummary = document.querySelector("." + CLS)
        ? "本页已翻译过；再点是跳过已翻段落。要重来先点『还原』"
        : "这页没有可翻译的段落（可能已经是中文）";
      state.done = 0; state.total = 0; state.pending = 0;
      return { ok: true, done: 0, total: 0, remaining: 0, errors: [], summary: state.lastSummary };
    }

    const settings = await getSettings(true);   // T2：每次开翻前刷新一次设置
    applyTheme(settings);                      // T2：配色跟着设置走（已打开的页面也能生效）

    const maxBlocks = Math.max(1, Number(settings.maxBlocksPerPage) || DEFAULT_MAX_BLOCKS);
    const batchSize = limit ? Math.min(Math.max(1, Number(limit) || 1), maxBlocks) : maxBlocks;
    const chunkChars = Math.max(200, Number(settings.chunkChars) || 2000);

    // T3：刷新过的页面先把缓存里的译文补回来，再从断点接着翻
    const replayed = (snap.fresh && snap.replayed) ? replayCached(snap.items, snap.rec) : 0;
    const queue = snap.items.slice(replayed, replayed + batchSize);

    const rec = {
      href: progressKey(),
      pageTotal: snap.total,
      done: snap.done,
      blocks: (snap.rec && snap.rec.blocks) || 0,
      items: Object.assign({}, (snap.rec && snap.rec.items) || {}),
    };
    let doneTotal = snap.done;

    const chunks = chunk(queue, chunkChars);
    state.running = true; state.errors = []; state.replayed = replayed;

    try {
      for (const c of chunks) {
        // 第 5 轮：翻的过程中点了「停止」→ 手里这块已经开出去的请求不打断，下一块不再开（= 停在当前批）
        if (state.autoStop) break;
        const res = await requestChunk(c, state.errors);
        if (!res) continue;                       // 这块失败：记过 error 了，继续下一块
        for (const it of c) {
          const translated = res.out && res.out[it.id];
          if (!translated) { state.errors.push(`第 ${it.id} 段没返译文`); continue; }
          if (!insertAfter(it, translated)) { state.errors.push(`第 ${it.id} 段插不进去`); continue; }
          const key = String(it.id);
          if (!(key in rec.items)) doneTotal++;   // 之前没记过才累加，避免重试时重复计数
          rec.items[key] = { h: textHash(it.text), t: translated };
        }
        rec.done = doneTotal;
        rec.blocks = (rec.blocks || 0) + 1;
        await writeProgress(rec);                 // 每块落一次盘 → 中途断了也不白翻
      }
    } finally {
      state.running = false;
      state.done = doneTotal;
      state.total = snap.total;
      state.pending = Math.max(0, snap.total - doneTotal);
      state.lastSummary =
        `已翻 ${doneTotal}/${snap.total} 段` +
        (state.pending ? `；还剩 ${state.pending} 段（点「一键翻完剩余」自动接着翻）` : "") +
        (state.errors.length ? `；${state.errors.length} 处没成（${state.errors[0]}）` : "");
      await writeProgress(rec);
    }

    return {
      ok: true,
      done: state.done, total: state.total, remaining: state.pending,
      batch: replayed + queue.length, replayed,
      errors: state.errors, summary: state.lastSummary,
    };
  }

  // =============================================================== 第 5 轮：一键翻完剩余
  // 以前：点一次「继续翻译剩余 n 段」＝再翻一批，没翻完还得再点一次。
  // 现在：点一次 = 自动接着往下翻（每批之间不停），直到全翻完 / 连着 2 批一点进展都没有。
  //   · 单批还是上面那个 translatePage()（默认 300 段一批 / 25s 超时 / 失败重试 1 次 / 每块落盘）—— 一个字没动
  //   · 「停止」= state.autoStop：批内每块开头、每批开头各看一次 → 手里这块收尾就收
  //     （停下来时译文和进度都已经落盘 → popup 会把「一键翻完剩余」按钮亮出来，点了接着翻，不会重翻已经翻过的段）
  const AUTO_FAIL_BATCHES = 2;   // 连着 2 批一段都没翻成 → 收手（防死循环、防白等）

  async function translateAll() {
    if (state.auto) return { ok: false, error: "正在翻完剩余中" };
    if (state.running) return { ok: false, error: "正在翻译中（等这一批完了再点）" };

    const first = await snapshot();
    if (!first.items.length) return await translatePage(0);   // 没得翻 → 交给老分支出同一句人话

    state.auto = true;
    state.autoStop = false;
    state.lastSummary = `一键翻完剩余：一共 ${first.total} 段，已翻 ${first.done} 段，接着往下翻…`;
    runAutoDrain(first.done, first.total, first.remaining).catch((e) => {
      state.auto = false;
      state.lastSummary = "一键翻完中断了：" + String((e && e.message) || e);
      state.errors = (state.errors || []).concat([state.lastSummary]);
    });
    // ⚠️ 立刻回话（不然 popup 要等整页翻完才拿到响应）；进度 / 收工话术靠 popup 轮询 status
    return {
      ok: true, all: true, started: true, auto: true,
      done: first.done, total: first.total, remaining: first.remaining,
      summary: state.lastSummary,
    };
  }

  /** 「一键翻完剩余」的循环本体：一批一批地调 translatePage（单批逻辑原样） */
  async function runAutoDrain(done, total, remaining) {
    let batches = 0, failStreak = 0, stopped = false;
    try {
      for (;;) {
        const res = await translatePage(0);        // ← 一批（老逻辑）
        batches++;
        if (!res || !res.ok) {
          failStreak++;                            // 这批连正常结果都没回来 → 记一次
        } else {
          if (res.done > done) failStreak = 0;     // 有进展 → 清零
          else failStreak++;                       // 一段都没翻成 → 记一次
          done = res.done; total = res.total; remaining = res.remaining;
        }
        stopped = state.autoStop;
        if (stopped || failStreak >= AUTO_FAIL_BATCHES || !remaining) break;
        await sleep(0);                            // 让出一次事件循环（popup 轮询能刷到进度）
      }
    } finally {
      state.auto = false;
    }
    state.pending = Math.max(0, remaining || 0);
    state.lastSummary =
      `一键翻完：已翻 ${done}/${total} 段` +
      (remaining
        ? (stopped ? `；停在还剩 ${remaining} 段（点「一键翻完剩余」接着翻）`
                   : `；还剩 ${remaining} 段（连着 ${AUTO_FAIL_BATCHES} 批没进展，先收手）`)
        : "；全翻完了") +
      (state.errors && state.errors.length ? `；${state.errors.length} 处没成（${state.errors[0]}）` : "");
    return state.lastSummary;
  }

  // =============================================================== T4 框选翻译
  // 交互（任务单 A 方案）：popup 点「框选翻译」进选择模式 →
  //   · 鼠标经过：虚线高亮鼠标下的候选块
  //   · 点击：把该块【及其内部符合规则的段落】加入待翻集合（实线描边 + 右下角「已选 n 段」）
  //   · 可以连点多个；ESC（或 popup 再点一次按钮）→ 退出选择模式并开翻
  // 翻译完全复用上面那套：同一份 CAND 规则 / 同样 chunkChars 分块 / 同样 [[n]] 协议 /
  // 同样插入 .st-trans、同样「还原」。已翻过的段不会再翻、不会重复插。

  const SEL_CLS = "st-selected";
  const HOV_CLS = "st-hover";
  const SELECTING_CLS = "st-selecting";

  const selected = new Set();
  let hovered = null;
  let pill = null;

  /** 点击/悬停落在哪个块上：① 最近的候选块 ② T1：向上找最近的"叶级文本容器" ③ 内部有候选段落的包裹元素 */
  function resolveTarget(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.closest && node.closest("." + CLS)) return null;      // 译文节点本身不给选
    const cand = node.closest ? node.closest(CAND) : null;
    if (cand) return cand;
    // T1 退化匹配：卡片标题那种 <a>/<div>/<span> —— 从鼠标下的节点往上找最近的叶级文本容器。
    // 往上找（而不是往下）⇒ 点在 <div><a>标题</a></div> 的 <a> 上，选中的就是 <a> 本身，不会圈进整张卡片。
    for (let el = node; el && el.nodeType === 1; el = el.parentNode) {
      // 只认"真能翻"的叶级容器：按钮 / UI 标签 / 与 href 同名的那些连虚线都不给，
      // 免得"框看着能点、点下去却翻不了"（排除项与整页模式共用 leafExcluded）。
      if (leafTextContainer(el) && !leafExcluded(el, cleanText(el))) return el;
    }
    try { return node.querySelector(CAND) ? node : null; } catch { return null; }
  }

  /** 这个元素里有哪些"够格被翻"的段落（含它自己），用的是 candidateText 同一套规则；
   *  T1：<a>/<div>/<span> 这类叶级文本容器也算（与整页模式共用 leafExcluded 的排除项）。 */
  function selectableFrom(root) {
    const out = [];
    const push = (el) => {
      if (!candidateText(el, false)) return;
      if (out.some((o) => o === el || (o.contains && o.contains(el)) || (el.contains && el.contains(o)))) return;
      out.push(el);
    };
    const pushLeaf = (el) => {
      if (!leafTextContainer(el)) return;
      if (leafExcluded(el, cleanText(el))) return;      // 按钮 / UI 标签 / 与 href 同名 → 不翻
      push(el);
    };
    if (root && root.matches) {
      if (root.matches(CAND)) push(root);
      else pushLeaf(root);
    }
    if (root && root.querySelectorAll) {
      root.querySelectorAll(CAND).forEach((el) => {
        if (el.closest && el.closest("." + CLS)) return;
        push(el);
      });
      root.querySelectorAll(LEAF).forEach((el) => {
        if (el.closest && el.closest("." + CLS)) return;
        pushLeaf(el);
      });
    }
    return out;
  }

  function ensurePill() {
    if (pill) return pill;
    try {
      pill = document.createElement("div");
      pill.id = "st-pill";
      pill.className = "st-pill";
      document.documentElement.appendChild(pill);
    } catch { pill = null; }
    return pill;
  }

  function updatePill() {
    const p = ensurePill();
    if (!p) return;
    p.textContent = selected.size
      ? `已选 ${selected.size} 段　按 ESC 开始翻译`
      : "框选中：点要翻的段落，ESC 开始翻译";
  }

  function onHover(e) {
    if (!state.selecting) return;
    const el = resolveTarget(e.target);
    if (el === hovered) return;
    if (hovered) { try { hovered.classList.remove(HOV_CLS); } catch { /* 忽略 */ } }
    hovered = el;
    if (hovered && !selected.has(hovered)) {
      try { hovered.classList.add(HOV_CLS); } catch { /* 忽略 */ }
    }
  }

  function onPick(e) {
    if (!state.selecting) return;
    const el = resolveTarget(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();                 // 选择模式下别让页面跳走（链接、按钮都拦下）
    let added = 0;
    for (const n of selectableFrom(el)) {
      if (selected.has(n)) continue;
      selected.add(n);
      try { n.classList.remove(HOV_CLS); } catch { /* 忽略 */ }
      try { n.classList.add(SEL_CLS); } catch { /* 忽略 */ }
      added++;
    }
    state.selectedCount = selected.size;
    updatePill();
    if (!added) state.lastSummary = "这一段里没有可翻的内容（可能已翻过或已是中文）";
    return added;
  }

  function onSelectKey(e) {
    if (!state.selecting) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitSelectMode({ translate: true }).catch(() => { /* 忽略 */ });
    }
  }

  function enterSelectMode() {
    if (state.selecting) return state;
    state.selecting = true;
    selected.clear();
    state.selectedCount = 0;
    try { document.documentElement.classList.add(SELECTING_CLS); } catch { /* 忽略 */ }
    document.addEventListener("mousemove", onHover, true);
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onSelectKey, true);
    ensurePill();
    updatePill();
    state.lastSummary = "框选模式：点选要翻的段落（可多选），ESC 开始翻译";
    return state;
  }

  /** 退出选择模式。opts.translate !== false 时，直接把选中的段落翻掉。 */
  async function exitSelectMode(opts) {
    const o = opts || {};
    const wasSelecting = state.selecting;
    state.selecting = false;
    try { document.documentElement.classList.remove(SELECTING_CLS); } catch { /* 忽略 */ }
    document.removeEventListener("mousemove", onHover, true);
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onSelectKey, true);
    if (hovered) { try { hovered.classList.remove(HOV_CLS); } catch { /* 忽略 */ } }
    hovered = null;
    if (pill) { try { pill.remove(); } catch { /* 忽略 */ } pill = null; }

    const picked = Array.from(selected);
    selected.clear();
    state.selectedCount = 0;

    // 收集要翻的段落（同一个元素可能被多次点到 → 去重；已翻过的会被 candidateText 挡掉）
    const els = [];
    for (const el of picked) {
      for (const n of selectableFrom(el)) {
        if (!els.includes(n)) els.push(n);
        try { n.classList.remove(SEL_CLS); } catch { /* 忽略 */ }
      }
    }
    if (!els.length) {
      if (wasSelecting) state.lastSummary = "没选到可翻的段落（可能已翻过或已是中文）";
      return {
        ok: true, done: 0, total: 0, remaining: 0, selected: 0, translated: false,
        summary: wasSelecting ? state.lastSummary : "已退出框选",
      };
    }
    if (o.translate === false) {
      return { ok: true, done: 0, total: els.length, remaining: 0, selected: els.length, translated: false, summary: `已选 ${els.length} 段（未翻译）` };
    }
    return await translateSelected(els);
  }

  /** 只翻指定的这些段落（不走整页的批次/进度，但同一套分块与协议） */
  async function translateSelected(els) {
    if (state.running) return { ok: false, error: "正在翻译中" };
    const settings = await getSettings(true);
    applyTheme(settings);
    const list = els.map((el, i) => ({ el, id: i + 1, text: cleanText(el) }));
    if (!list.length) return { ok: true, done: 0, total: 0, remaining: 0, summary: "没选到可翻的段落" };

    const chunks = chunk(list, Math.max(200, Number(settings.chunkChars) || 2000));
    const pairs = [];   // 第 4 轮：{id, el, src, dst, inserted} —— 给区域翻译的结果卡片用（不动 AI 逻辑）
    state.running = true; state.errors = [];
    let done = 0;
    try {
      for (const c of chunks) {
        const res = await requestChunk(c, state.errors);
        if (!res) continue;
        for (const it of c) {
          const translated = res.out && res.out[it.id];
          if (!translated) { state.errors.push(`第 ${it.id} 段没返译文`); continue; }
          const inserted = insertAfter(it, translated);
          if (inserted) done++;
          pairs.push({ id: it.id, el: it.el, src: it.text, dst: translated, inserted });
        }
      }
    } finally {
      state.running = false;
      state.done = done; state.total = list.length; state.pending = 0;
      state.lastSummary = `框选翻译：翻了 ${done}/${list.length} 段` +
        (state.errors.length ? `；${state.errors.length} 处没成（${state.errors[0]}）` : "");
    }
    return { ok: true, done, total: list.length, remaining: 0, errors: state.errors, summary: state.lastSummary, source: "select", pairs };
  }

  // =============================================================== 第 4 轮 T1：区域翻译（拖框，万能）
  // 病根（老板在 X/推特上实测）：SPA 站点整页 DOM 路线只能选到碎片 ⇒ 需要"拖一个框"。
  // 用户的动作永远只有"拖一个框"，剩下自动挑最合适的那条路：
  //   ① 框内有足够 DOM 文本 → 文字路（复用现有分段 / 术语表 / 插入逻辑）
  //   ② 图片 / Canvas / SPA 烂结构 → 截图 → 识图 → 结果卡片
  // 判定结果会在提示条上短暂显示（「文字路」/「截图路」），方便排障。

  const REGION_MIN_JOINED = 12;                // 拼起来的文本 ≥ 12 字（中英合计，不数空白）
  const REGION_MIN_PARA = 12;                  // ≥ 1 个"够格段落"：单个候选元素自己的文本 ≥ 12 字（碎片不算）
  const REGION_MIN_DRAG = 8;                   // 拖拽小于这个尺寸（多半只是点了一下）→ 不算框，继续等
  const REGION_BIG_RATIO = 0.4;                // 框选面积 > 视口 40% → 提醒"框小一点更准（小字放大会更清楚）"（不禁止）
  const REGION_CACHE_KEY = "st:region-cache";
  const REGION_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 分钟内
  const REGION_CACHE_TOL = 4;                  // 同 URL + 同矩形（±4px）
  const REGION_CACHE_MAX = 20;                 // 缓存的条数上限（在 session 里，浏览器关掉就没了）
  const VISION_MAX_SIDE = 1280;                // 长边 ≤ 1280
  const VISION_JPEG_QUALITY = 0.85;            // JPEG q85
  const VISION_QUALITY_FLOOR = 0.5;            // 还超 400KB 就降到这档为止（再低字就糊了）
  const VISION_MAX_BYTES = 400 * 1024;         // 目标：单次 < 400KB（安卓端同尺寸实测 ~403 tokens）
  const CAPTURE_TIMEOUT_MS = 6000;             // 截图本身很快：6 秒不回来就是出问题了

  let regionNodes = null;    // { overlay, rect, pill }
  let regionDrag = null;     // { x0, y0, x1, y1 }
  let regionPillTimer = null;
  let cardNodes = null;      // { card, body, foot, toggleBtn, copyBtn, insertBtn }
  let cardInfo = null;       // { info, pairs, zh, src, showSrc }
  let cardDrag = null;
  let cardDocClick = null;

  const now = () => Date.now();
  const countChars = (s) => String(s || "").replace(/\s/g, "").length;
  const dataUrlBase64 = (u) => { const i = String(u || "").indexOf(","); return i >= 0 ? String(u).slice(i + 1) : ""; };
  const bytesOfBase64 = (b64) => Math.round(String(b64 || "").length * 3 / 4);

  function pageHref() {
    let href = "";
    try { href = String(location.href || "").split("#")[0]; } catch { /* file:// 等怪情况 */ }
    return href;
  }

  function viewSize() {
    return { w: Number(window.innerWidth) || 0, h: Number(window.innerHeight) || 0 };
  }

  // ---------------------------------------------------------------- 纯函数（自检脚本直接喂数据断言）

  /** 框内的采样点：3×3（1/4、1/2、3/4 三档）+ 中心点（与上面重复时自动去重）。
   *  坐标夹在视口内 —— elementsFromPoint 只认视口里的点，框贴边时点跑到视口外就取不到元素。 */
  function regionSamplePoints(rect, viewW, viewH) {
    const pts = [];
    const seen = new Set();
    const push = (x, y) => {
      const cx = Math.min(Math.max(x, 0), Math.max(0, (Number(viewW) || 0) - 1));
      const cy = Math.min(Math.max(y, 0), Math.max(0, (Number(viewH) || 0) - 1));
      const key = Math.round(cx) + "," + Math.round(cy);
      if (seen.has(key)) return;
      seen.add(key);
      pts.push({ x: cx, y: cy });
    };
    for (const fx of [0.25, 0.5, 0.75]) {
      for (const fy of [0.25, 0.5, 0.75]) push(rect.x + rect.w * fx, rect.y + rect.h * fy);
    }
    push(rect.x + rect.w / 2, rect.y + rect.h / 2);
    return pts;
  }

  /** ⭐ 坐标换算（必须准）：截图是【设备像素】、拖框是【CSS 像素】。
   *  k = 截图宽度 / window.innerWidth —— 这一项天然把 devicePixelRatio 与页面缩放一起算了进去。
   *  裁剪区 = (rect.x*k, rect.y*k, rect.w*k, rect.h*k)，四舍五入，再夹紧在图片边界内。 */
  function computeCrop(rect, imgW, imgH, viewW, viewH) {
    const k = (Number(viewW) > 0 && Number(imgW) > 0) ? Number(imgW) / Number(viewW) : 1;
    let x = Math.round(Number(rect.x || 0) * k);
    let y = Math.round(Number(rect.y || 0) * k);
    let w = Math.round(Number(rect.w || 0) * k);
    let h = Math.round(Number(rect.h || 0) * k);
    // 夹紧：往左/往上越界时把切掉的那部分从宽高里减掉（右边/下边保持不动）
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.min(w, Number(imgW) - x);
    h = Math.min(h, Number(imgH) - y);
    if (x > Number(imgW)) { x = Number(imgW); w = 0; }   // 框整个跑到图片外面：坐标也夹回来，宽高就是 0
    if (y > Number(imgH)) { y = Number(imgH); h = 0; }
    return { x, y, w: Math.max(0, w), h: Math.max(0, h), k };
  }

  /** 长边 ≤ max（只缩不放，保持长宽比） */
  function fitSize(w, h, max) {
    const ww = Math.max(1, Math.round(Number(w) || 0));
    const hh = Math.max(1, Math.round(Number(h) || 0));
    const long = Math.max(ww, hh);
    if (!(long > max)) return { w: ww, h: hh };
    const r = max / long;
    return { w: Math.max(1, Math.round(ww * r)), h: Math.max(1, Math.round(hh * r)) };
  }

  // ---------------------------------------------------------------- 命中判定：这条框走哪条路

  /** 框内候选元素：3×3 采样 + 中心点 → elementsFromPoint → 过滤 → 去重（互为祖先/后代只留一个）。
   *  过滤：.st-trans 里的不给、nav/header/footer/aside/[role=menu] 不给；
   *  文本判据沿用 candidateText 那一套（可见 / 非代码 / ≥2 字 / 非中文），叶级容器再过 leafExcluded。 */
  function regionCandidates(rect) {
    const v = viewSize();
    const pts = regionSamplePoints(rect, v.w, v.h);
    const seenEls = [];
    for (const p of pts) {
      let els = [];
      try { els = document.elementsFromPoint(p.x, p.y) || []; } catch { els = []; }
      for (const el of els) {
        if (!el || el.nodeType !== 1) continue;
        if (el.closest && el.closest("." + CLS)) continue;    // 我们插的译文不给
        if (inChromeZone(el)) continue;                        // 导航/页眉/页脚/侧栏/菜单不给
        if (seenEls.indexOf(el) >= 0) continue;
        seenEls.push(el);
      }
    }
    const cands = [];
    for (const el of seenEls) {
      const text = candidateText(el, false);
      if (text === null) continue;
      const plain = el.matches && el.matches(CAND);
      if (!plain) {
        if (!leafTextContainer(el)) continue;   // 不是叶级容器（多半是卡片壳子 / body）→ 跳过
        if (leafExcluded(el, text)) continue;   // 按钮 / UI 标签 / 与 href 同名 → 跳过
      }
      cands.push({ el, text });
    }
    const kept = [];
    for (const c of cands) {
      if (kept.some((k) => k.el === c.el || k.el.contains(c.el) || c.el.contains(k.el))) continue;
      kept.push(c);
    }
    return kept;
  }

  /** 走哪条路？拼起来的文本 ≥ 12 字（中英合计）且 ≥ 1 个"够格段落" → 文字路；否则截图路。
   *  ⚠️ "够格段落" = 单个候选元素自己的文本 ≥ 12 字 —— 一堆小碎片（SPA 那种 <span> 拼出来的）
   *     合起来虽然超过 12 字，但没有一段够格 ⇒ 自动走截图路（这正是老板在 X 上遇到的问题）。 */
  function regionDecide(cands) {
    const list = Array.isArray(cands) ? cands : [];
    const joined = countChars(list.map((c) => c.text).join(" "));
    const paras = list.filter((c) => countChars(c.text) >= REGION_MIN_PARA);
    const road = (joined >= REGION_MIN_JOINED && paras.length >= 1) ? "text" : "image";
    return { road, joined, paras: paras.length, cands: list };
  }

  // ---------------------------------------------------------------- 提示条 / 遮罩 / 实时矩形

  function buildRegionUi() {
    if (regionNodes && regionNodes.overlay) return regionNodes;
    if (regionNodes && regionNodes.pill) { try { regionNodes.pill.remove(); } catch { /* 忽略 */ } }
    if (regionPillTimer) { clearTimeout(regionPillTimer); regionPillTimer = null; }
    let nodes = { overlay: null, rect: null, pill: null };
    try {
      const root = document.documentElement || document.body;
      const overlay = document.createElement("div");
      overlay.className = "st-region-overlay";
      overlay.setAttribute("id", "st-region-overlay");
      const rect = document.createElement("div");
      rect.className = "st-region-rect";
      rect.style.display = "none";
      const pill = document.createElement("div");
      pill.className = "st-region-pill";
      pill.setAttribute("id", "st-region-pill");
      root.appendChild(overlay);
      root.appendChild(rect);
      root.appendChild(pill);
      nodes = { overlay, rect, pill };
    } catch { nodes = { overlay: null, rect: null, pill: null }; }
    regionNodes = nodes;
    return nodes;
  }

  /** 提示条：ms > 0 ⇒ 过一会儿自动藏起来（判定结果要"短暂显示"） */
  function setRegionPill(text, ms) {
    const n = regionNodes;
    if (!n || !n.pill) return;
    n.pill.textContent = text;
    n.pill.style.display = "block";
    if (regionPillTimer) { clearTimeout(regionPillTimer); regionPillTimer = null; }
    if (ms) {
      regionPillTimer = setTimeout(() => {
        try { if (regionNodes && regionNodes.pill) regionNodes.pill.style.display = "none"; } catch { /* 忽略 */ }
      }, ms);
    }
  }

  /** 命中判定之前先把遮罩藏起来：elementsFromPoint 必须看不到我们自己的遮罩 */
  function hideRegionShade() {
    const n = regionNodes;
    if (n && n.overlay) { try { n.overlay.style.display = "none"; } catch { /* 忽略 */ } }
    if (n && n.rect) { try { n.rect.style.display = "none"; } catch { /* 忽略 */ } }
    if (n && n.pill) { try { n.pill.style.display = "none"; } catch { /* 忽略 */ } }   // 提示条也别被采到（下一次 setRegionPill 会再打开）
  }

  /** 拖拽矩形（标准化 + 夹在视口内） */
  function dragRectFrom(d) {
    const v = viewSize();
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    const x0 = Math.min(Math.max(x, 0), Math.max(0, v.w));
    const y0 = Math.min(Math.max(y, 0), Math.max(0, v.h));
    return { x: x0, y: y0, w: Math.min(w, Math.max(0, v.w - x0)), h: Math.min(h, Math.max(0, v.h - y0)) };
  }

  function updateRegionRect() {
    const n = regionNodes;
    if (!n || !n.rect) return;
    if (!regionDrag) { n.rect.style.display = "none"; return; }
    const r = dragRectFrom(regionDrag);
    if (r.w < 1 && r.h < 1) { n.rect.style.display = "none"; return; }
    n.rect.style.display = "block";
    n.rect.style.left = r.x + "px";
    n.rect.style.top = r.y + "px";
    n.rect.style.width = r.w + "px";
    n.rect.style.height = r.h + "px";
  }

  // ---------------------------------------------------------------- 进入 / 退出 / 拖拽

  function onRegionDown(e) {
    if (!state.region) return;
    if (e.button === 2) return;                       // 右键交给 onRegionContext（退出）
    if (e.preventDefault) e.preventDefault();          // 别让页面选中文字
    if (e.stopPropagation) e.stopPropagation();
    const x = Number(e.clientX) || 0, y = Number(e.clientY) || 0;
    regionDrag = { x0: x, y0: y, x1: x, y1: y };
    updateRegionRect();
  }

  function onRegionMove(e) {
    if (!state.region || !regionDrag) return;
    if (e.preventDefault) e.preventDefault();
    regionDrag.x1 = Number(e.clientX) || 0;
    regionDrag.y1 = Number(e.clientY) || 0;
    updateRegionRect();
  }

  function onRegionUp(e) {
    if (!state.region || !regionDrag) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    regionDrag.x1 = Number.isFinite(e.clientX) ? Number(e.clientX) : regionDrag.x0;
    regionDrag.y1 = Number.isFinite(e.clientY) ? Number(e.clientY) : regionDrag.y0;
    const rect = dragRectFrom(regionDrag);
    regionDrag = null;
    if (rect.w < REGION_MIN_DRAG || rect.h < REGION_MIN_DRAG) {
      updateRegionRect();                              // 只是点了一下 → 当没框，继续等
      return;
    }
    finishRegion(rect).catch((err) => {
      setRegionPill("区域翻译出错：" + String((err && err.message) || err), 6000);
      teardownRegion(6000);
    });
  }

  function onRegionKey(e) {
    if (!state.region) return;
    if (e.key === "Escape") {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      exitRegionMode();
    }
  }

  function onRegionContext(e) {
    if (!state.region) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    exitRegionMode();
  }

  async function enterRegionMode() {
    if (state.region) return state;
    if (state.selecting) await exitSelectMode({ translate: false });   // 两个模式不叠加
    state.region = true;
    regionDrag = null;
    closeResultCard();       // 上一张卡片收掉，免得它挡住/被采到
    buildRegionUi();
    setRegionPill("拖拽框选要翻译的区域　ESC 取消", 0);
    document.addEventListener("mousedown", onRegionDown, true);
    document.addEventListener("mousemove", onRegionMove, true);
    document.addEventListener("mouseup", onRegionUp, true);
    document.addEventListener("contextmenu", onRegionContext, true);
    document.addEventListener("keydown", onRegionKey, true);
    state.lastSummary = "区域模式：拖一个框（ESC 取消）";
    return state;
  }

  /** 退出：不改页面（ESC / 右键 / popup 再点一次按钮） */
  function exitRegionMode() {
    const was = state.region;
    state.region = false;
    teardownRegion(0);
    if (was) state.lastSummary = "已退出区域模式（没改页面）";
    return { ok: true, region: false, summary: state.lastSummary };
  }

  /** 收摊。keepPillMs > 0 ⇒ 提示条再多留一会儿（判定结果要让用户看见） */
  function teardownRegion(keepPillMs) {
    state.region = false;      // 兜底：不管从哪条路收摊，状态都归位
    document.removeEventListener("mousedown", onRegionDown, true);
    document.removeEventListener("mousemove", onRegionMove, true);
    document.removeEventListener("mouseup", onRegionUp, true);
    document.removeEventListener("contextmenu", onRegionContext, true);
    document.removeEventListener("keydown", onRegionKey, true);
    regionDrag = null;
    const n = regionNodes;
    if (!n) { regionNodes = null; return; }
    try { if (n.overlay) n.overlay.remove(); } catch { /* 忽略 */ }
    try { if (n.rect) n.rect.remove(); } catch { /* 忽略 */ }
    if (n.pill && keepPillMs) {
      if (regionPillTimer) { clearTimeout(regionPillTimer); regionPillTimer = null; }
      regionPillTimer = setTimeout(() => { try { n.pill.remove(); } catch { /* 忽略 */ } }, keepPillMs);
      regionNodes = { overlay: null, rect: null, pill: n.pill };
      return;
    }
    try { if (n.pill) n.pill.remove(); } catch { /* 忽略 */ }
    regionNodes = null;
  }

  // ---------------------------------------------------------------- T2：截图 → 裁剪 → 压缩

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      try {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("截图解码失败"));
        img.src = src;
      } catch (e) { reject(e); }
    });
  }

  /** 裁剪 + 压缩：长边 ≤ 1280、JPEG q85；仍 > 400KB 就逐档降质量（到 0.5 为止） */
  async function cropShot(dataUrl, rect) {
    const img = await loadImage(dataUrl);
    const iw = Number(img.naturalWidth) || Number(img.width) || 0;
    const ih = Number(img.naturalHeight) || Number(img.height) || 0;
    const v = viewSize();
    const crop = computeCrop(rect, iw, ih, v.w, v.h);
    if (!(crop.w > 0) || !(crop.h > 0)) throw new Error("裁剪区是空的（框可能落在截图外面）");
    const fit = fitSize(crop.w, crop.h, VISION_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = fit.w;
    canvas.height = fit.h;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) throw new Error("拿不到画布（2d 上下文）");
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, fit.w, fit.h);
    let q = VISION_JPEG_QUALITY;
    let out = canvas.toDataURL("image/jpeg", q);
    while (bytesOfBase64(dataUrlBase64(out)) > VISION_MAX_BYTES && q > VISION_QUALITY_FLOOR) {
      q = Math.max(VISION_QUALITY_FLOOR, Math.round((q - 0.1) * 100) / 100);   // 降档，但停在 0.5
      out = canvas.toDataURL("image/jpeg", q);
    }
    const b64 = dataUrlBase64(out);
    return { base64: b64, bytes: bytesOfBase64(b64), quality: q, crop, fit, imgW: iw, imgH: ih };
  }

  /** 识图请求：失败自动重试 1 次（超时沿用现有的 25s） */
  async function requestVision(base64) {
    let lastErr = "";
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
      try {
        const res = await withTimeout(
          chrome.runtime.sendMessage({ type: "vision", image: base64 }),
          REQUEST_TIMEOUT_MS + 5000,
          `识图超过 ${(REQUEST_TIMEOUT_MS + 5000) / 1000} 秒没回来（后台可能被回收了）`,
        );
        if (res && res.ok) return res;
        lastErr = (res && res.error) || "识图没返回结果";
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
      if (attempt < RETRY_TIMES) await sleep(800);
    }
    return { ok: false, error: lastErr || "未知错误" };
  }

  /** 识图返回解析：【原文】…【译文】…（卡片与正文都靠它；模型没按格式来就整段当译文） */
  function parseVisionPairs(text) {
    const t = String(text || "");
    const pairs = [];
    const re = /【原文】\s*([\s\S]*?)\s*【译文】\s*([\s\S]*?)(?=\s*【原文】|$)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const src = String(m[1] || "").trim();
      const dst = String(m[2] || "").trim();
      if (src || dst) pairs.push({ src, dst });
    }
    if (!pairs.length && t.trim()) pairs.push({ src: "", dst: t.trim() });
    return pairs;
  }

  // ---------------------------------------------------------------- T4：缓存（同 URL + 同矩形 ±4px + 5 分钟）

  async function regionCacheLookup(rect) {
    let list = null;
    try { list = await store.get(REGION_CACHE_KEY); } catch { list = null; }
    if (!Array.isArray(list)) return null;
    const href = pageHref();
    const t = now();
    for (const it of list) {
      if (!it || it.href !== href || !it.rect) continue;
      if (t - (it.ts || 0) > REGION_CACHE_TTL_MS) continue;
      if (Math.abs((it.rect.x || 0) - rect.x) > REGION_CACHE_TOL) continue;
      if (Math.abs((it.rect.y || 0) - rect.y) > REGION_CACHE_TOL) continue;
      if (Math.abs((it.rect.w || 0) - rect.w) > REGION_CACHE_TOL) continue;
      if (Math.abs((it.rect.h || 0) - rect.h) > REGION_CACHE_TOL) continue;
      return it;
    }
    return null;
  }

  async function regionCacheSave(rect, payload) {
    let list = null;
    try { list = await store.get(REGION_CACHE_KEY); } catch { list = null; }
    const keep = (Array.isArray(list) ? list : []).filter((it) => it && (now() - (it.ts || 0)) <= REGION_CACHE_TTL_MS);
    keep.unshift({
      href: pageHref(),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
      pairs: (payload && payload.pairs) || [],
      model: (payload && payload.model) || "",
      elapsedMs: (payload && payload.elapsedMs) || 0,
      ts: now(),
    });
    try { await store.set(REGION_CACHE_KEY, keep.slice(0, REGION_CACHE_MAX)); } catch { /* 存不进去也不影响这次翻译 */ }
  }

  // ---------------------------------------------------------------- T1+ T2：松手之后（选路 → 干活）

  async function finishRegion(rect) {
    state.region = false;      // 松手＝这一次框选结束了（遮罩/监听在下面撤）
    const t0 = now();
    const v = viewSize();
    const big = (rect.w * rect.h) > (v.w * v.h) * REGION_BIG_RATIO;
    const bigTip = big ? "　框小一点更准（小字放大会更清楚）" : "";
    hideRegionShade();                                   // 先让 elementsFromPoint 看不到遮罩
    const cands = regionCandidates(rect);
    const hit = regionDecide(cands);

    if (hit.road === "text") {
      // ① 文字路：直接在框内选中的段落上插译文（复用现有插入与术语表逻辑）
      const els = [];
      for (const c of hit.cands) {
        for (const n of selectableFrom(c.el)) if (els.indexOf(n) < 0) els.push(n);
      }
      setRegionPill(`判定：文字路（框内 ${hit.paras} 段可翻文字，共 ${hit.joined} 字）${bigTip}`, 0);
      const res = await translateSelected(els);
      const elapsed = now() - t0;
      let model = "";
      try { model = (await getSettings()).model || ""; } catch { model = ""; }
      state.regionDebug = { road: "text", rect, paras: hit.paras, joined: hit.joined, model, elapsedMs: elapsed, done: res.done, total: res.total };
      state.lastSummary = `区域翻译·文字路：翻了 ${res.done}/${res.total} 段` +
        (res.errors && res.errors.length ? `；${res.errors.length} 处没成（${res.errors[0]}）` : "") + bigTip;
      showResultCard({
        road: "text", cached: false, rect, pairs: res.pairs || [], model, elapsedMs: elapsed, big,
        note: res.errors && res.errors.length ? `${res.errors.length} 处没成` : "",
      });
      teardownRegion(4000);
      return {
        ok: true, road: "text", done: res.done, total: res.total, remaining: 0,
        errors: res.errors, paras: hit.paras, summary: state.lastSummary,
      };
    }

    // ② 截图路
    const cached = await regionCacheLookup(rect);
    if (cached) {
      setRegionPill(`判定：截图路（5 分钟内同位置翻过，直接用缓存）${bigTip}`, 0);
      state.regionDebug = { road: "image", cached: true, rect, model: cached.model, elapsedMs: cached.elapsedMs };
      state.lastSummary = "区域翻译·截图路：缓存命中（这次没花钱）";
      showResultCard({
        road: "image", cached: true, rect, pairs: cached.pairs || [],
        model: cached.model, elapsedMs: cached.elapsedMs, big,
      });
      teardownRegion(4000);
      return { ok: true, road: "image", cached: true, remaining: 0, summary: state.lastSummary };
    }

    setRegionPill(`判定：截图路（框内取不到足够文字 → 截图识图）${bigTip}　识别中…`, 0);
    let cap = null;
    try {
      cap = await withTimeout(chrome.runtime.sendMessage({ type: "capture" }), CAPTURE_TIMEOUT_MS, "截图超时（没拿到授权？）");
    } catch (e) {
      cap = { ok: false, error: String((e && e.message) || e) };
    }
    if (!cap || !cap.ok) {
      const why = (cap && cap.error) || "截图没成功";
      setRegionPill("截图失败：" + why + "　→ 这页只能走文字路（DOM 取不到就翻不了）", 0);
      state.lastSummary = "区域翻译：截图失败，已退化为仅文字路（" + why + "）";
      teardownRegion(6000);
      return { ok: false, road: "image", degraded: true, error: state.lastSummary, summary: state.lastSummary };
    }

    let shot = null;
    try {
      shot = await cropShot(cap.dataUrl, rect);
    } catch (e) {
      const why = String((e && e.message) || e);
      setRegionPill("截图处理失败：" + why + "　→ 这页只能走文字路", 0);
      state.lastSummary = "区域翻译：截图处理失败（" + why + "）";
      teardownRegion(6000);
      return { ok: false, road: "image", degraded: true, error: state.lastSummary, summary: state.lastSummary };
    }

    const vis = await requestVision(shot.base64);
    if (!vis.ok) {
      setRegionPill("识图失败：" + vis.error + "（已重试 1 次）", 0);
      state.lastSummary = "区域翻译：识图失败（" + vis.error + "）";
      teardownRegion(6000);
      return { ok: false, road: "image", error: state.lastSummary, summary: state.lastSummary };
    }

    const pairs = parseVisionPairs(vis.text);
    const elapsed = now() - t0;
    await regionCacheSave(rect, { pairs, model: vis.model, elapsedMs: elapsed });
    state.regionDebug = {
      road: "image", cached: false, rect, crop: shot.crop, fit: shot.fit,
      sentW: shot.fit.w, sentH: shot.fit.h, imgW: shot.imgW, imgH: shot.imgH,
      bytes: shot.bytes, quality: shot.quality, model: vis.model, elapsedMs: elapsed,
    };
    setRegionPill(`判定：截图路（识别完成，${pairs.length} 条，用了 ${(elapsed / 1000).toFixed(1)}s）${bigTip}`, 0);
    state.lastSummary = `区域翻译·截图路：识别完成（${pairs.length} 条），耗时 ${(elapsed / 1000).toFixed(1)}s`;
    showResultCard({
      road: "image", cached: false, rect, pairs, model: vis.model, elapsedMs: elapsed, big,
      bytes: shot.bytes, quality: shot.quality,
    });
    teardownRegion(4000);
    return {
      ok: true, road: "image", pairs: pairs.length, bytes: shot.bytes, quality: shot.quality,
      elapsedMs: elapsed, remaining: 0, summary: state.lastSummary,
    };
  }

  // ---------------------------------------------------------------- T3：结果卡片

  function closeResultCard() {
    onCardUp();
    if (cardDocClick) { document.removeEventListener("click", cardDocClick, true); cardDocClick = null; }
    if (cardNodes && cardNodes.card) { try { cardNodes.card.remove(); } catch { /* 忽略 */ } }
    cardNodes = null;
    cardInfo = null;
  }

  function showResultCard(info) {
    closeResultCard();
    const pairs = (info && info.pairs) || [];
    const zh = pairs.map((p) => p.dst).filter(Boolean).join("\n") || "（识图没返回可用的【译文】）";
    const src = pairs.map((p) => p.src).filter(Boolean).join("\n") || "（模型没给【原文】）";
    cardInfo = { info, pairs, zh, src, showSrc: false };

    let nodes = null;
    try {
      const root = document.documentElement || document.body;
      const v = viewSize();
      const card = document.createElement("div");
      card.className = "st-card";
      card.setAttribute("id", "st-card");
      const width = Math.min(360, Math.max(220, v.w - 24));
      card.style.width = width + "px";
      const r = (info && info.rect) || { x: 24, y: 24, w: 0, h: 0 };
      card.style.left = Math.min(Math.max(r.x, 8), Math.max(8, v.w - width - 8)) + "px";
      card.style.top = Math.min(Math.max(r.y + 12, 8), Math.max(8, v.h - 160)) + "px";

      const head = document.createElement("div");
      head.className = "st-card-head";
      const title = document.createElement("span");
      title.className = "st-card-title";
      title.textContent = info.cached ? "🔎 区域翻译（缓存）" : "🔎 区域翻译";
      const tag = document.createElement("span");
      tag.className = "st-card-tag";
      tag.textContent = (info.road === "text" ? "文字路" : "截图路") + (info.cached ? "（缓存）" : "") + (info.big ? "·大框" : "");
      const xBtn = document.createElement("button");
      xBtn.className = "st-card-x";
      xBtn.setAttribute("data-act", "close");
      xBtn.textContent = "✕";
      head.appendChild(title);
      head.appendChild(tag);
      head.appendChild(xBtn);

      const body = document.createElement("div");
      body.className = "st-card-body";
      body.textContent = zh;

      const foot = document.createElement("div");
      foot.className = "st-card-foot";
      foot.textContent = "模型 " + (info.model || "-") + " · 耗时 " + ((info.elapsedMs || 0) / 1000).toFixed(1) + "s" +
        (info.cached ? " · 命中缓存（同位置 5 分钟内翻过，这次没花钱）" : "") +
        (info.bytes ? " · " + Math.round(info.bytes / 1024) + "KB q" + info.quality : "") +
        (info.note ? " · " + info.note : "");

      const bar = document.createElement("div");
      bar.className = "st-card-bar";
      const mkBtn = (act, label) => {
        const b = document.createElement("button");
        b.className = "st-card-btn";
        b.setAttribute("data-act", act);
        b.textContent = label;
        bar.appendChild(b);
        return b;
      };
      const toggleBtn = mkBtn("toggle", "看原文");
      const copyBtn = mkBtn("copy", "复制");
      const insertBtn = info.road === "text" ? mkBtn("insert", "插入到原文下方") : null;

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(foot);
      card.appendChild(bar);
      root.appendChild(card);

      nodes = { card, body, foot, toggleBtn, copyBtn, insertBtn };
      card.addEventListener("click", onCardClick);
      head.addEventListener("mousedown", onCardDown);
      card.addEventListener("mousedown", onCardDown);
      armCardOutsideClose();
    } catch { nodes = null; }
    cardNodes = nodes;
    return nodes;
  }

  function armCardOutsideClose() {
    if (cardDocClick) { document.removeEventListener("click", cardDocClick, true); cardDocClick = null; }
    cardDocClick = (e) => {
      if (!cardNodes || !cardNodes.card) return;
      const t = e && e.target;
      if (t && (t === cardNodes.card || (cardNodes.card.contains && cardNodes.card.contains(t)))) return;
      closeResultCard();                                  // 点空白 → 关掉卡片
    };
    setTimeout(() => { if (cardDocClick) document.addEventListener("click", cardDocClick, true); }, 0);
  }

  function onCardClick(e) {
    let node = e && e.target;
    let act = "";
    while (node && node.nodeType === 1) {
      const a = node.getAttribute && node.getAttribute("data-act");
      if (a) { act = a; break; }
      node = node.parentNode;
    }
    if (!act) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (act === "close") { closeResultCard(); return; }
    if (act === "toggle") {
      if (!cardInfo || !cardNodes) return;
      cardInfo.showSrc = !cardInfo.showSrc;
      if (cardNodes.body) cardNodes.body.textContent = cardInfo.showSrc ? cardInfo.src : cardInfo.zh;
      if (cardNodes.toggleBtn) cardNodes.toggleBtn.textContent = cardInfo.showSrc ? "看译文" : "看原文";
      return;
    }
    if (act === "copy") { copyCardText(); return; }
    if (act === "insert") { insertCardBelow(); return; }
  }

  function copyCardText() {
    if (!cardInfo) return "";
    const text = cardInfo.showSrc ? cardInfo.src : cardInfo.zh;
    const done = () => {
      if (cardNodes && cardNodes.copyBtn) {
        cardNodes.copyBtn.textContent = "已复制 ✓";
        setTimeout(() => { try { if (cardNodes && cardNodes.copyBtn) cardNodes.copyBtn.textContent = "复制"; } catch { /* 忽略 */ } }, 1500);
      }
    };
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
        return text;
      }
    } catch { /* 往下走 */ }
    fallbackCopy(text, done);
    return text;
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      const root = document.documentElement || document.body;
      root.appendChild(ta);
      if (ta.select) ta.select();
      const good = document.execCommand && document.execCommand("copy");
      ta.remove();
      if (good && done) done();
    } catch { /* 复制失败：按钮文字不动，用户还能手动选 */ }
  }

  /** 文字路专用：把还没插进去的译文补插到原文下方（已经插过的跳过） */
  function insertCardBelow() {
    if (!cardInfo) return 0;
    let n = 0;
    for (const p of cardInfo.pairs) {
      if (p.inserted) continue;
      if (insertAfter({ el: p.el, id: p.id }, p.dst)) { p.inserted = true; n++; }
    }
    if (cardNodes && cardNodes.insertBtn) {
      cardNodes.insertBtn.textContent = n ? `又插入 ${n} 段 ✓` : "已在原文下方";
      cardNodes.insertBtn.disabled = true;
    }
    if (cardInfo.info) cardInfo.info.note = n ? `补插 ${n} 段` : "已全部在原文下方";
    return n;
  }

  function onCardDown(e) {
    if (!cardNodes || !cardNodes.card) return;
    const t = e && e.target;
    if (t && t.getAttribute && t.getAttribute("data-act")) return;   // 点按钮不拖卡片
    if (e.preventDefault) e.preventDefault();
    const v = viewSize();
    cardDrag = {
      dx: Number(e.clientX) || 0, dy: Number(e.clientY) || 0,
      x: parseFloat(cardNodes.card.style.left) || 0,
      y: parseFloat(cardNodes.card.style.top) || 0,
      vw: v.w, vh: v.h,
    };
    document.addEventListener("mousemove", onCardMove, true);
    document.addEventListener("mouseup", onCardUp, true);
  }

  function onCardMove(e) {
    if (!cardDrag || !cardNodes || !cardNodes.card) return;
    if (e.preventDefault) e.preventDefault();
    const nx = Math.min(Math.max(cardDrag.x + ((Number(e.clientX) || 0) - cardDrag.dx), 0), Math.max(0, cardDrag.vw - 60));
    const ny = Math.min(Math.max(cardDrag.y + ((Number(e.clientY) || 0) - cardDrag.dy), 0), Math.max(0, cardDrag.vh - 30));
    cardNodes.card.style.left = nx + "px";
    cardNodes.card.style.top = ny + "px";
  }

  function onCardUp() {
    cardDrag = null;
    document.removeEventListener("mousemove", onCardMove, true);
    document.removeEventListener("mouseup", onCardUp, true);
  }
  // 页面一进来就把配色变量铺好（不翻译也能先看到正确颜色）
  getSettings().then(applyTheme).catch(() => { /* 忽略 */ });

  // ---------------------------------------------------------------- 消息

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "translate") sendResponse(await translatePage(msg.limit || 0));
        else if (msg?.type === "translateAll") sendResponse(await translateAll());
        else if (msg?.type === "translateStop") {
          // 第 5 轮：只置一个标记 —— 手里正在飞的那一块不打断，批内每块 / 每批开头各看一次
          const was = state.auto;
          if (was) state.autoStop = true;
          sendResponse({ ok: true, auto: state.auto, stopping: was,
            summary: was ? "收到停止：手里这一块收尾就停" : "现在没在翻" });
        }
        else if (msg?.type === "restore") {
          restoreDom();
          closeResultCard();                      // 第 4 轮：还原时顺手把结果卡片收掉
          await clearProgress();                  // T3：「还原」把进度一起清掉
          state.lastSummary = "已还原（译文和进度都清了）";
          sendResponse({ ok: true, done: 0, total: 0, remaining: 0, summary: state.lastSummary });
        } else if (msg?.type === "status") {
          const snap = await snapshot();
          state.total = snap.total; state.done = snap.done; state.pending = snap.remaining;
          sendResponse({
            ok: true, state,
            script: { pi: PI, version: SCRIPT_VERSION },   // T3：popup 拿它跟扩展版本比对 ⇒ 不一致就是"本页跑着旧脚本"
            progress: { done: snap.done, total: snap.total, remaining: snap.remaining, hasProgress: !!snap.rec },
          });
        } else if (msg?.type === "selectMode") {
          if (msg.on) {
            enterSelectMode();
            sendResponse({ ok: true, selecting: true, selected: 0, summary: state.lastSummary });
          } else {
            sendResponse(await exitSelectMode({ translate: msg.translate !== false }));
          }
        } else if (msg?.type === "regionMode") {
          if (msg.on) {
            await enterRegionMode();
            sendResponse({ ok: true, region: true, summary: state.lastSummary });
          } else {
            sendResponse(exitRegionMode());
          }
        } else sendResponse({ ok: false, error: "未知类型" });
      } catch (e) {
        state.running = false;
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  });
})();
