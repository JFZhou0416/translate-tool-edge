/* 屏幕翻译（Edge 扩展）· 行为自检（第 3 轮那 46 项回归 + 第 5 轮「一键翻完剩余」那一组） —— 不依赖浏览器、不引依赖，纯 node 跑【真代码】
 *
 * 干什么：
 *   ① 搭一个最小 DOM + chrome 桩，把【真的】src/content.js 加载进来（IIFE 末尾挂个导出钩子），
 *      喂任务单里那 6 条自检 HTML，断言"能不能选中 / 能不能翻"；
 *   ② 再用同样方式加载【真的】src/popup.js（DOM 直接解析 src/popup.html），
 *      断言 T3 的"陈旧脚本"红条：版本一致 / 页面跑旧脚本 / 页面没注入 三种情况；
 *   ③ 第 5 轮：跑真的 content.js，验「一键翻完剩余」自己会把剩下的翻完、以及点了「停止」能停在中间。
 *
 * 跑法：node edge-translate/tools/selfcheck.js   （在仓库根执行；不启动浏览器、不联网）
 */
"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");  // 仓库根 = tools/ 的上一级（脚本自定位，换目录也能跑）
const out = [];
const log = (s) => { out.push(s); console.log(s); };
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) pass++; else fail++;
  log("    " + (ok ? "PASS" : "FAIL") + "  " + label + (detail !== undefined ? "   -> " + detail : ""));
}

// =============================================================== 一/二、迷你 DOM + 加载【真】content.js
// 桩（迷你 DOM / chrome 桩 / canvas / Image）都在 tools/stub-dom.js 里 ——
// 第 4 轮起与 tools/region-check.js 共用一份，这里只把它拿来用。
const { Doc, parseHTML, setBody, tagOf, loadContent, send, tick, EXT_VERSION } = require("./stub-dom.js");

// =============================================================== 三、T1 自检用例
const doc = new Doc();
const CONTENT = loadContent(doc);
const st = CONTENT.st;

log("");
log("=== 一、T1 自检用例（喂 HTML，跑【真】src/content.js） ===");
log("加载到的常量：PI = " + st.PI + "，SCRIPT_VERSION = " + st.SCRIPT_VERSION + "（manifest 版本 " + EXT_VERSION + "）");
log("CAND = " + st.CAND);
log("LEAF = " + st.LEAF);
log("");

function leafInfo(el) {
  const text = st.candidateText(el, false);
  if (text === null) return "candidateText=null（可见性/已翻/文本太短/已是中文）";
  const reason = st.leafExcluded(el, text);
  return "文本=" + JSON.stringify(text) + (reason ? "；被排除：" + reason : "；可翻");
}

function runCase(n, title, html, probeSel, expect) {
  setBody(doc, html);
  const node = doc.querySelector(probeSel);
  const target = st.resolveTarget(node);
  const sel = target ? st.selectableFrom(target) : [];
  const segs = st.collectSegments();
  const gotSelect = !!target;
  const gotTranslate = sel.length > 0;
  const gotPage = segs.length > 0;
  const ok = gotSelect === expect.select && gotTranslate === expect.translate && gotPage === expect.translate;
  check(ok, "用例 " + n + "：" + title,
    "框选可选中=" + gotSelect + "（期望 " + expect.select + "）｜框选可翻=" + gotTranslate + "（期望 " + expect.translate + "）｜整页可翻=" + gotPage);
  log("      输入 HTML        : " + html);
  log("      resolveTarget()  : " + tagOf(target));
  log("      selectableFrom() : " + sel.length + " 段" + (sel.length ? " [" + sel.map(tagOf).join(" ") + "]" : ""));
  log("      整页 collectSegments() : " + segs.length + " 段" + (segs.length ? " " + segs.map((s) => "#" + s.id + " " + tagOf(s.el) + " " + JSON.stringify(s.text)).join(" | ") : ""));
  log("      该元素判据       : " + leafInfo(node));
  log("");
  return { target, sel, segs };
}

runCase(1, "<a href=\"/x\">Damage Meter</a> → 可选中、可翻",
  "<a href=\"/x\">Damage Meter</a>", "a", { select: true, translate: true });

runCase(2, "<div><a>Introducing Health Check…</a></div> → 选中 <a>（不是整个 div）",
  "<div class=\"wrap\"><a href=\"/news/1\">Introducing Health Check in Vortex 2.6</a></div>", "a", { select: true, translate: true });

const c3 = runCase(3, "<nav><a>Home</a></nav> → 不可选（导航区）",
  "<nav><a href=\"/\">Home</a></nav>", "a", { select: false, translate: false });

const c4 = runCase(4, "<button>Download</button> → 不可翻",
  "<button class=\"dl\">Download</button>", "button", { select: false, translate: false });

const c5 = runCase(5, "<a href=\"/x\">Open</a>（命中 UI 词）→ 不翻",
  "<a href=\"/x\">Open</a>", "a", { select: false, translate: false });

runCase(6, "普通 <p> → 行为不变（回归）",
  "<p>This is an ordinary paragraph on the page. Nothing special here.</p>", "p", { select: true, translate: true });

// 用例 2 断言"选中的是 <a>，不是外层 div"
setBody(doc, "<div class=\"wrap\"><a href=\"/news/1\">Introducing Health Check in Vortex 2.6</a></div>");
const c2anchor = doc.querySelector("a");
const c2target = st.resolveTarget(c2anchor);
const c2segs = st.collectSegments();
check(c2target === c2anchor && c2target.tagName === "A", "用例 2 补断言：选中的是 <a> 本身（不是外层 div）", tagOf(c2target));
check(c2segs.length === 1 && c2segs[0].el === c2anchor, "用例 2 补断言：整页只收 <a> 一段（外层 div 不入列）", c2segs.map((x) => tagOf(x.el)).join(" "));

// 用例 3 补断言：导航区里 CAND 段落也照样跳过（老行为回归）
setBody(doc, "<nav><a href=\"/\">Home</a><div>Skip me please</div></nav>");
check(st.collectSegments().length === 0, "用例 3 补断言：<nav> 里的 <div> 也不翻", st.collectSegments().length + " 段");

// 用例 4/5 的"为什么"要能说出来
setBody(doc, "<button class=\"dl\">Download</button>");
check(st.leafExcluded(doc.querySelector("button"), "Download").indexOf("UI 词") >= 0, "用例 4 原因：命中『常见 UI 词』", st.leafExcluded(doc.querySelector("button"), "Download"));
setBody(doc, "<a href=\"/x\">Open</a>");
check(st.leafExcluded(doc.querySelector("a"), "Open").indexOf("UI 词") >= 0, "用例 5 原因：命中『常见 UI 词』", st.leafExcluded(doc.querySelector("a"), "Open"));
setBody(doc, "<a href=\"https://ex.com/x\" title=\"Damage Meter\">Damage Meter</a>");
check(st.leafExcluded(doc.querySelector("a"), "Damage Meter").length > 0, "补充：文本与 title 完全相同 → 排除", st.leafExcluded(doc.querySelector("a"), "Damage Meter"));
setBody(doc, "<div>12.5%</div>");
check(st.leafExcluded(doc.querySelector("div"), "12.5%").length > 0, "补充：纯数字/符号 → 排除", st.leafExcluded(doc.querySelector("div"), "12.5%"));
setBody(doc, "<span>v1.2.3</span>");
check(st.leafExcluded(doc.querySelector("span"), "v1.2.3").length > 0, "补充：版本号 v1.2.3 → 排除", st.leafExcluded(doc.querySelector("span"), "v1.2.3"));
setBody(doc, "<div role=\"button\">Launch</div>");
check(st.leafExcluded(doc.querySelector("div"), "Launch").indexOf("按钮") >= 0, "补充：[role=button] 里的文本 → 排除", st.leafExcluded(doc.querySelector("div"), "Launch"));

// =============================================================== 四、端到端：模拟 NexusMods 卡片结构
(async () => {
log("=== 二、端到端：模拟 NexusMods 卡片结构（框选 → 悬停 → 点选 → ESC 翻译）===");
const CARD = [
  "<div class=\"card\">",
  "  <div class=\"thumb\"><img src=\"a.png\"></div>",
  "  <div class=\"body\">",
  "    <a class=\"title\" href=\"/mods/123\">Damage Meter</a>",
  "    <p class=\"desc\">Shows the damage numbers over every enemy in the fight.</p>",
  "    <button class=\"dl\">Download</button>",
  "  </div>",
  "</div>",
].join("\n");
setBody(doc, CARD);

const cardEl = doc.querySelector("div.card");
const titleA = doc.querySelector("a.title");
const descP = doc.querySelector("p.desc");
const dlBtn = doc.querySelector("button.dl");

const segs0 = st.collectSegments();
check(segs0.length === 2, "整页识别：这张卡片正好收 2 段（标题 + 描述）", segs0.map((s) => tagOf(s.el) + " " + JSON.stringify(s.text)).join(" | "));
check(segs0.some((s) => s.el === titleA) && segs0.some((s) => s.el === descP), "整页识别：收的是 <a.title> 与 <p.desc> 本身", segs0.map((s) => tagOf(s.el)).join(" "));
check(!segs0.some((s) => s.el === cardEl || s.el === dlBtn), "整页识别：卡片容器 / Download 按钮都没进清单（不会把整张卡片翻一遍）");

const enterMsg = await send(CONTENT.listeners, { type: "selectMode", on: true });
check(enterMsg.selecting === true, "进入框选模式", JSON.stringify(enterMsg.summary));

doc.dispatch("mouseover", { target: titleA, preventDefault() {}, stopPropagation() {} });
check(titleA.classList.contains("st-hover"), "悬停卡片标题 → 有虚线反馈（.st-hover）", titleA.getAttribute("class"));

doc.dispatch("mouseover", { target: dlBtn, preventDefault() {}, stopPropagation() {} });
check(!dlBtn.classList.contains("st-hover"), "悬停 Download 按钮 → 不给虚线（反正翻不了，别骗人点）", dlBtn.getAttribute("class") || "(无 class)");
check(!titleA.classList.contains("st-hover"), "换悬停目标后，标题上的虚线自动撤掉", titleA.getAttribute("class"));

doc.dispatch("click", { target: titleA, preventDefault() {}, stopPropagation() {} });
doc.dispatch("click", { target: descP, preventDefault() {}, stopPropagation() {} });
check(titleA.classList.contains("st-selected") && descP.classList.contains("st-selected"), "点标题 + 点描述 → 两段都描边选中", titleA.getAttribute("class") + " / " + descP.getAttribute("class"));
check(!!doc.getElementById("st-pill"), "右下角出现『已选 n 段』角标", doc.getElementById("st-pill") ? JSON.stringify(doc.getElementById("st-pill").textContent) : "(没有)");

doc.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
await tick();

const trans = doc.querySelectorAll(".st-trans");
check(trans.length === 2, "ESC 之后：页面里正好插了 2 条译文", trans.map((n) => JSON.stringify(n.textContent)).join(" | "));
check(trans.every((n) => n.textContent.indexOf("【译】") === 0), "译文内容来自（桩）后台返回，插在原文下方");
check(doc.querySelectorAll("[data-st-done]").length === 2, "两段都打上了 data-st-done（重复点不会再翻）", String(doc.querySelectorAll("[data-st-done]").length));
check(!doc.getElementById("st-pill"), "退出框选后角标已清理");

// 已翻过的段不会再入选
const afterSegs = st.collectSegments();
check(afterSegs.length === 0, "翻完之后再扫整页：只剩已翻过的段，没有新的可翻段", String(afterSegs.length));

// =============================================================== 五、T3：popup 的"陈旧脚本"红条
log("");
log("=== 三、T3 自检：popup 打开时怎么判断『本页需刷新』 ===");
const POPUP_HTML = fs.readFileSync(ROOT + "\\src\\popup.html", "utf8");
const POPUP_JS = fs.readFileSync(ROOT + "\\src\\popup.js", "utf8");

function loadPopup(reply) {
  const pd = new Doc();
  const bodyHtml = (POPUP_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, POPUP_HTML])[1];
  parseHTML(bodyHtml, pd, pd.body);
  const calls = { reload: [], closed: 0, opened: 0 };
  const chromeStub = {
    runtime: {
      getManifest: () => ({ version: EXT_VERSION }),
      sendMessage: async () => ({ ok: true }),
      openOptionsPage: async () => { calls.opened++; },
    },
    tabs: {
      query: async () => [{ id: 7, url: "https://www.nexusmods.com/" }],
      sendMessage: async () => {
        if (reply.error) throw new Error(reply.error);
        return reply.value;
      },
      reload: async (id) => { calls.reload.push(id); },
    },
  };
  const win = { close: () => { calls.closed++; } };
  const ctx = { document: pd, chrome: chromeStub, window: win, setTimeout, clearTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(POPUP_JS, ctx, { filename: "src/popup.js" });
  return { pd, calls, ctx };
}

async function popupCase(title, reply, expect) {
  const { pd, calls } = loadPopup(reply);
  await tick(); await tick();
  const stale = pd.getElementById("stale");
  const text = pd.getElementById("staleText").textContent;
  const shown = stale.style.display === "block";
  const ver = pd.getElementById("ver").textContent;
  check(shown === expect.shown, title + " → 红条" + (expect.shown ? "出现 ✅" : "不出现 ✅"), shown ? JSON.stringify(text) : "(没有红条)");
  check(ver === "v" + EXT_VERSION, title + " → 底部版本号", JSON.stringify(ver));
  if (expect.textHas) check(text.indexOf(expect.textHas) >= 0, title + " → 红条文案含：『" + expect.textHas + "』", JSON.stringify(text));
  if (expect.shown) {
    await pd.getElementById("reload").onclick();
    await tick();
    check(calls.reload.length === 1 && calls.reload[0] === 7, title + " → 点『刷新本页』调用 chrome.tabs.reload(7)", JSON.stringify(calls.reload));
    check(calls.closed === 1, title + " → 刷新后关掉 popup", "window.close() x" + calls.closed);
  }
  log("");
  return { pd, calls };
}

await popupCase("场景 A：页面脚本就是这一版（" + EXT_VERSION + " / 协议 2）",
  { value: { ok: true, state: { selecting: false }, progress: { done: 0, total: 0, remaining: 0 }, script: { pi: 2, version: EXT_VERSION } } },
  { shown: false });

await popupCase("场景 B：页面还在跑旧脚本（0.1.0 / 协议 1）",
  { value: { ok: true, state: {}, progress: { done: 0, total: 0, remaining: 0 }, script: { pi: 1, version: "0.1.0" } } },
  { shown: true, textHas: "本页需刷新一次（F5）" });

await popupCase("场景 C：更老的脚本，status 里连 script 字段都没有（＝今天老板机器上的状态）",
  { value: { ok: true, state: {}, progress: { done: 0, total: 0, remaining: 0 } } },
  { shown: true, textHas: "本页需刷新一次（F5）" });

await popupCase("场景 D：sendMessage 直接失败（页面根本没注入，如 edge:// 内部页）",
  { error: "Could not establish connection. Receiving end does not exist." },
  { shown: true, textHas: "本页无法使用扩展" });

// =============================================================== 七、第 5 轮：一键翻完剩余
log("");
log("=== 四、第 5 轮：一键翻完剩余（点一次自动接着翻完；点了「停止」就停在当前那一批） ===");
{
  // 把一批调小（默认 300），好在一个小页面上就能翻出"批与批之间"；每次 translate 慢一点，才来得及按停止
  const slow = (ms) => async (msg) => { if (msg && msg.type === "translate") await tick(ms); return undefined; };
  const waitAuto = async (C) => {
    for (let i = 0; i < 600; i++) {
      const r = await send(C.listeners, { type: "status" });
      if (!r?.state?.auto) return true;
      await tick(5);
    }
    return false;
  };

  // ---------- ① 12 段 / 一批 5 段 → 点一次就自己翻完 ----------
  const d1 = new Doc();
  const C1 = loadContent(d1, { settings: { maxBlocksPerPage: 5 }, sendMessage: slow(4) });
  setBody(d1, Array.from({ length: 12 }, (_, i) => '<p class="a' + i + '">Auto drain paragraph ' + i + ' with enough text to be translated.</p>').join(""));
  const started = await send(C1.listeners, { type: "translateAll" });
  check(started.ok === true && started.started === true && started.auto === true,
    "点「一键翻完剩余」→ 立刻回话（不等整页翻完），并说明已经开始",
    "ok=" + started.ok + " started=" + started.started + " summary=" + JSON.stringify(started.summary));
  check(await waitAuto(C1), "翻完自己收工（state.auto 回到 false，不用谁再点一下）");
  const s1 = await send(C1.listeners, { type: "status" });
  check(d1.querySelectorAll(".st-trans").length === 12,
    "12 段全翻完（一批 5 段 → 3 批，中间不需要用户再点）", ".st-trans=" + d1.querySelectorAll(".st-trans").length);
  check(C1.calls.translate === 3, "真的是一批一批发的（12 ÷ 5 = 3 次请求），单批协议没变", "translate 次数=" + C1.calls.translate);
  check(s1.progress.remaining === 0 && s1.state.lastSummary.indexOf("全翻完了") >= 0,
    "收工话术：全翻完了 + 剩余 0", JSON.stringify(s1.state.lastSummary));

  // ---------- ② 40 段 / 一批 5 段 → 翻到一半点「停止」 ----------
  const d2 = new Doc();
  const C2 = loadContent(d2, { settings: { maxBlocksPerPage: 5 }, sendMessage: slow(25) });
  setBody(d2, Array.from({ length: 40 }, (_, i) => '<p class="b' + i + '">Stop test paragraph ' + i + ' with enough text to be translated.</p>').join(""));
  await send(C2.listeners, { type: "translateAll" });
  for (let i = 0; i < 400; i++) {                       // 等第一批落地（先有进展，再按停止）
    const r = await send(C2.listeners, { type: "status" });
    if (r.progress.done > 0) break;
    await tick(2);
  }
  const stopRes = await send(C2.listeners, { type: "translateStop" });
  check(stopRes.ok === true && stopRes.stopping === true,
    "「停止」只是置个标记（手里正在飞的那一块不打断），回话说明收尾就停", JSON.stringify(stopRes.summary));
  check(await waitAuto(C2), "停止之后自己收工（不打断、不卡住）");
  const s2 = await send(C2.listeners, { type: "status" });
  const n2 = d2.querySelectorAll(".st-trans").length;
  check(n2 > 0 && n2 < 40, "真的停在中间（不是一段没翻，也没硬翻完 40 段）", "已翻 " + n2 + "/40（请求 " + C2.calls.translate + " 次）");
  check(s2.progress.remaining > 0 && s2.state.lastSummary.indexOf("停在还剩") >= 0,
    "停下来后进度留着 → popup 会再亮出「一键翻完剩余」（就靠 remaining）", JSON.stringify(s2.state.lastSummary));

  // ---------- ③ 停完再点一次 → 把剩下的翻完，且不重翻 ----------
  const again = await send(C2.listeners, { type: "translateAll" });
  check(again.ok === true, "再点一次＝当成新一轮继续翻（上一次的「停止」标记先被清掉）", JSON.stringify(again.summary));
  await waitAuto(C2);
  check(d2.querySelectorAll(".st-trans").length === 40, "剩下的翻完了（没漏段、没重翻）", ".st-trans=" + d2.querySelectorAll(".st-trans").length);
  check(C2.calls.translate === 8, "两轮加起来正好 8 次请求 = 40 ÷ 5（每一段只翻一次）", "translate 次数=" + C2.calls.translate);
}

// =============================================================== 六、收尾
log("=== 汇总 ===");
log("通过 " + pass + " 项，失败 " + fail + " 项" + (fail ? "  ❌" : "  ✅"));
fs.writeFileSync(path.join(__dirname, "selfcheck-output.txt"), out.join("\r\n") + "\r\n", "utf8");
process.exit(fail ? 1 : 0);
})();
