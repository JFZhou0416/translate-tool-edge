/* 屏幕翻译（Edge 扩展）· 自检用的【迷你 DOM + chrome 桩】
 *
 * 为什么有这一份：自检要在 node 里跑【真的】src/content.js，但不能启动浏览器。
 * 所以这里手搓一个刚够用的 DOM（元素 / 文本节点 / 选择器 / 事件 / 几何 / canvas 桩），
 * 把真代码加载进来跑，断言它的行为。
 *
 * ⚠️ 第 3 轮的 tools/selfcheck.js 与第 4 轮的 tools/region-check.js 共用这一份 ——
 *    第 4 轮在原来基础上加了：元素的矩形（getBoundingClientRect / rect）、
 *    document.elementsFromPoint()、元素级事件（addEventListener/fire）、canvas 与 Image 桩。
 *    断言、用例、判定标准都是**照旧**的，只是换了个放桩的地方。
 */
"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");   // 仓库根 = tools/ 的上一级（脚本自定位，换目录也能跑）
const EXT_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const CONTENT_SRC = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");

// ---------------------------------------------------------------- 迷你 DOM
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source", "area", "base", "col", "embed", "track", "wbr"]);

function parseSelectorList(sel) {
  return String(sel).split(",").map((s) => s.trim()).filter(Boolean).map((compound) => {
    const tokens = [];
    const re = /\[[^\]]*\]|[.#]?[\w-]+/g;
    let m;
    while ((m = re.exec(compound))) tokens.push(m[0]);
    return tokens.map((t) => {
      if (t[0] === ".") return { cls: t.slice(1) };
      if (t[0] === "#") return { id: t.slice(1) };
      if (t[0] === "[") {
        const inner = t.slice(1, -1);
        const eq = inner.indexOf("=");
        if (eq < 0) return { attr: inner };
        let val = inner.slice(eq + 1).trim();
        if (val.length > 1 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1);
        return { attr: inner.slice(0, eq), val };
      }
      return { tag: t.toLowerCase() };
    });
  });
}

function matchesTokens(el, tokens) {
  for (const t of tokens) {
    if (t.tag && el.tagName.toLowerCase() !== t.tag) return false;
    if (t.cls && !el.classList.contains(t.cls)) return false;
    if (t.id && el.getAttribute("id") !== t.id) return false;
    if (t.attr) {
      const v = el.getAttribute(t.attr);
      if (v === null) return false;
      if (t.val !== undefined && v !== t.val) return false;
    }
  }
  return true;
}

class TextNode {
  constructor(text, doc) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; this.ownerDocument = doc; }
}

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) { const on = force === undefined ? !this.set.has(n) : !!force; if (on) this.set.add(n); else this.set.delete(n); return on; }
  toString() { return Array.from(this.set).join(" "); }
}

class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.attrs = new Map();
    this.classList = new ClassList();
    this.rect = null;                       // 第 4 轮：几何（getBoundingClientRect / elementsFromPoint 用）
    this.style = {
      setProperty: (k, v) => { this.style[k] = v; },
      getPropertyValue: (k) => this.style[k] || "",
      removeProperty: (k) => { delete this.style[k]; },
    };
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.hiddenRects = false;
    this._ev = new Map();                   // 第 4 轮：元素级事件（卡片/遮罩上的监听）
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList.set = new Set(String(v || "").split(/\s+/).filter(Boolean)); }
  get innerText() { return this.textContent; }
  get textContent() {
    let s = "";
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (String(v) !== "") this.appendChild(new TextNode(v, this.ownerDocument));
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentElement(pos, node) {
    const p = this.parentNode;
    if (!p || (pos !== "afterend" && pos !== "beforebegin")) return null;
    const i = p.childNodes.indexOf(this);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = p;
    p.childNodes.splice(pos === "afterend" ? i + 1 : i, 0, node);
    return node;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel) {
    const list = parseSelectorList(sel);
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (list.some((t) => matchesTokens(x, t))) return x;
    return null;
  }
  matches(sel) { return parseSelectorList(sel).some((t) => matchesTokens(this, t)); }
  querySelectorAll(sel) {
    const list = parseSelectorList(sel);
    const found = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        if (list.some((t) => matchesTokens(c, t))) found.push(c);
        walk(c);
      }
    };
    walk(this);
    return found;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getClientRects() { return this.hiddenRects ? [] : [{ width: 10, height: 10 }]; }
  getBoundingClientRect() {
    const r = this.rect || { x: 0, y: 0, w: 0, h: 0 };
    return { x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h };
  }
  // 第 4 轮：元素级事件（stub 版；只在 el.fire(...) 时触发）
  addEventListener(type, fn) { if (!this._ev.has(type)) this._ev.set(type, []); this._ev.get(type).push(fn); }
  removeEventListener(type, fn) { const a = this._ev.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  fire(type, ev) { for (const fn of (this._ev.get(type) || []).slice()) fn(ev); }
  setAttribute(name, v) {
    const n = String(name).toLowerCase();
    if (n === "class") { this.className = v; return; }
    this.attrs.set(n, String(v));
  }
  getAttribute(name) {
    const n = String(name).toLowerCase();
    if (n === "class") return this.className || null;
    return this.attrs.has(n) ? this.attrs.get(n) : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    const n = String(name).toLowerCase();
    if (n === "class") { this.className = ""; return; }
    this.attrs.delete(n);
  }
  select() { this.__selected = true; }
}

/** 第 4 轮：canvas 桩 —— toDataURL 造一段"长度可控"的假 JPEG，够验证 400KB 那档降质量 */
function makeCanvas(doc) {
  const el = new El("canvas", doc);
  el.width = 300;
  el.height = 150;
  el.__draw = null;
  el.getContext = () => ({ drawImage: (...a) => { el.__draw = a; } });
  el.toDataURL = (type, q) => {
    const quality = (q == null ? 1 : q);
    const bytes = Math.max(1, Math.round(el.width * el.height * quality));
    return "data:" + (type || "image/png") + ";base64," + "A".repeat(Math.ceil(bytes * 4 / 3));
  };
  return el;
}

class Doc {
  constructor() {
    this.events = new Map();
    this.documentElement = new El("html", this);
    this.head = new El("head", this);
    this.body = new El("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.execCommand = (cmd) => cmd === "copy";   // 复制兜底路径用
    this.canvases = [];                           // 第 4 轮：记下建过的 canvas（自检要验裁剪参数）
  }
  createElement(tag) {
    if (String(tag).toLowerCase() !== "canvas") return new El(tag, this);
    const c = makeCanvas(this);
    this.canvases.push(c);
    return c;
  }
  createTextNode(t) { return new TextNode(t, this); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementById(id) { return this.querySelector("#" + id); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(fn); }
  removeEventListener(type, fn) { const a = this.events.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatch(type, ev) { for (const fn of (this.events.get(type) || []).slice()) fn(ev); }
  /** 命中点上的元素（后代先、同层后出现的在上）——等价于浏览器的 elementsFromPoint。
   *  和浏览器一样：display:none / visibility:hidden / pointer-events:none 的元素不算。 */
  elementsFromPoint(x, y) {
    const out = [];
    const collect = (node) => {
      const kids = node.childNodes.filter((c) => c.nodeType === 1);
      for (let i = kids.length - 1; i >= 0; i--) collect(kids[i]);
      const st = node.style || {};
      if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return;
      const r = node.rect;
      if (!r) return;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) out.push(node);
    };
    collect(this.documentElement);
    return out;
  }
}

function parseHTML(html, doc, parent) {
  const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:.-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const stack = [parent];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) {
      if (m[5].trim()) stack[stack.length - 1].appendChild(new TextNode(m[5], doc));
      continue;
    }
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const tag = String(m[2] || "").toLowerCase();
    if (!tag) continue;
    const el = new El(tag, doc);
    const attrRe = /([\w:.-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[3] || "")) !== null) el.setAttribute(a[1], a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : "");
    stack[stack.length - 1].appendChild(el);
    if (m[4] === "/" || VOID_TAGS.has(tag)) continue;
    stack.push(el);
  }
  return parent;
}

function setBody(doc, html) {
  for (const c of doc.body.childNodes) c.parentNode = null;
  doc.body.childNodes = [];
  parseHTML(html, doc, doc.body);
}

function tagOf(el) {
  if (!el) return "(null)";
  if (el.nodeType === 3) return "#text";
  const id = el.getAttribute("id"), cls = el.getAttribute("class");
  return "<" + el.tagName.toLowerCase() + (id ? " id=" + id : "") + (cls ? " class=" + cls.replace(/\s+/g, ".") : "") + ">";
}

// ---------------------------------------------------------------- 假截图（Image 桩）
const IMG_DIMS = new Map();
function setImageDims(dataUrl, w, h) { IMG_DIMS.set(dataUrl, { w, h }); }
class ImageStub {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; this._src = ""; }
  set src(v) {
    this._src = v;
    const d = IMG_DIMS.get(v) || { w: 800, h: 600 };
    this.naturalWidth = d.w;
    this.naturalHeight = d.h;
    if (this.onload) setTimeout(() => { try { this.onload(); } catch { /* 忽略 */ } }, 0);
  }
  get src() { return this._src; }
}

// ---------------------------------------------------------------- 加载【真】src/content.js
const DEFAULT_SETTINGS = {
  chunkChars: 2000, maxBlocksPerPage: 300, colorMode: "auto",
  model: "stub-model", visionModel: "stub-vision-model", glossary: "",
};

function loadContent(doc, opts) {
  const o = opts || {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, o.settings || {});
  const listeners = {};
  const calls = { capture: 0, vision: 0, translate: 0, types: [] };
  const session = o.session || null;
  const local = o.local || null;
  const bag = (map, key) => (map && Object.prototype.hasOwnProperty.call(map, key) ? { [key]: map[key] } : {});
  const chromeStub = {
    runtime: {
      getManifest: () => ({ version: EXT_VERSION }),
      sendMessage: async (msg) => {
        calls.types.push(msg && msg.type);
        if (o.sendMessage) {
          const r = await o.sendMessage(msg, calls);
          if (r !== undefined) return r;
        }
        if (!msg) return { ok: false, error: "empty" };
        if (msg.type === "getSettings") return { ok: true, settings };
        if (msg.type === "ping") return { ok: true, hasKey: true, model: settings.model };
        if (msg.type === "translate") {
          calls.translate++;
          const out = {};
          for (const it of msg.items) out[it.id] = "【译】" + it.text;
          return { ok: true, out };
        }
        if (msg.type === "capture") {
          calls.capture++;
          if (o.captureError) return { ok: false, error: o.captureError };
          return { ok: true, dataUrl: o.captureDataUrl || "data:image/png;base64,PNGSTUB" };
        }
        if (msg.type === "vision") {
          calls.vision++;
          if (o.visionError) return { ok: false, error: o.visionError };
          return { ok: true, text: o.visionText || "【原文】Hello world\n【译文】你好，世界", model: settings.visionModel };
        }
        return { ok: false, error: "unknown " + msg.type };
      },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
    },
    storage: {
      onChanged: { addListener: () => {} },
      session: {
        get: async (k) => bag(session, k),
        set: async (obj) => { if (session) Object.assign(session, obj); },
        remove: async (k) => { if (session) delete session[k]; },
      },
      local: {
        get: async (k) => bag(local, k),
        set: async (obj) => { if (local) Object.assign(local, obj); },
        remove: async (k) => { if (local) delete local[k]; },
      },
    },
  };
  const win = {
    innerWidth: o.innerWidth || 1200,
    innerHeight: o.innerHeight || 800,
    matchMedia: () => ({ matches: false }),
    setTimeout, clearTimeout,
  };
  const clipboard = [];
  const ctx = {
    document: doc,
    chrome: chromeStub,
    window: win,
    Image: ImageStub,
    navigator: { clipboard: { writeText: async (t) => { clipboard.push(t); } } },
    getComputedStyle: () => ({ backgroundColor: "rgba(0, 0, 0, 0)" }),
    location: { href: o.href || "https://example.com/page" },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(ctx);
  const patched = CONTENT_SRC.replace(/\}\)\(\);\s*$/, [
    "  globalThis.__st = {",
    "    resolveTarget, selectableFrom, collectAll, collectSegments, candidateText,",
    "    leafTextContainer, leafExcluded, directText, CAND, LEAF, PI, SCRIPT_VERSION,",
    "    regionSamplePoints, computeCrop, fitSize, regionCandidates, regionDecide,",
    "    parseVisionPairs, regionCacheLookup, cropShot, enterRegionMode, exitRegionMode,",
    "    finishRegion, showResultCard, closeResultCard, insertCardBelow, copyCardText,",
    "    countChars, pageHref,",
    "    REGION_MIN_JOINED, REGION_MIN_PARA, REGION_BIG_RATIO, REGION_CACHE_TOL, REGION_CACHE_TTL_MS,",
    "    VISION_MAX_SIDE, VISION_JPEG_QUALITY, VISION_MAX_BYTES,",
    "  };",
    "})();",
    "",
  ].join("\r\n"));
  vm.runInContext(patched, ctx, { filename: "src/content.js" });
  return { ctx, st: ctx.__st, listeners, calls, win, settings, clipboard };
}

function send(listeners, msg) {
  return new Promise((resolve) => { listeners.message(msg, {}, resolve); });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

module.exports = {
  ROOT, EXT_VERSION, CONTENT_SRC, DEFAULT_SETTINGS,
  TextNode, ClassList, El, Doc, ImageStub, setImageDims,
  parseSelectorList, matchesTokens, parseHTML, setBody, tagOf,
  loadContent, send, tick,
};
