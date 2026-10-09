/* 第 4 轮 · 区域翻译自检（不启动浏览器、不联网、不花钱）
 *
 * 跑什么（照任务单 T4-6 的要求）：
 *   ① 坐标换算（computeCrop / fitSize / 采样点）：含 dpr=1、dpr=2、页面缩放、边界夹紧
 *   ② 命中判定（regionCandidates / regionDecide）：纯文本段 / 图片块 / SPA 碎片 / 导航区 / 译文节点 …
 *   ③ 端到端（在桩环境里跑【真的】src/content.js）：文字路插译文、截图路走 canvas→识图→卡片、
 *      缓存 ±4px/5 分钟、大框护栏、ESC 退出、卡片四个按钮
 *
 * 跑法：node edge-translate/tools/region-check.js   （在仓库根执行）
 * 完整输出会写到 tools/region-check-output.txt（生成物，可删）
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Doc, setBody, tagOf, loadContent, send, tick, setImageDims, EXT_VERSION } = require("./stub-dom.js");

const out = [];
const log = (s) => { out.push(s); console.log(s); };
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) pass++; else fail++;
  log("    " + (ok ? "PASS" : "FAIL") + "  " + label + (detail !== undefined ? "   -> " + detail : ""));
}
const j = (v) => JSON.stringify(v);
const rectOf = (el, x, y, w, h) => { el.rect = { x, y, w, h }; return el; };

function fresh(opts) {
  const doc = new Doc();
  const C = loadContent(doc, opts);
  return { doc, C, st: C.st };
}
async function waitFor(fn, tries) {
  const n = tries || 60;
  for (let i = 0; i < n; i++) { if (fn()) return true; await tick(20); }
  return false;
}
function clickOn(el, target) {
  el.fire("click", { target: target || el, preventDefault() {}, stopPropagation() {} });
}

log("");
log("=== 一、坐标换算（截图是设备像素、拖框是 CSS 像素） ===");
log("依赖同一个纯函数：k = 截图宽度 / window.innerWidth（含 devicePixelRatio 与页面缩放）");
log("");
{
  const { st } = fresh();
  check(typeof st.computeCrop === "function" && typeof st.fitSize === "function", "导出：computeCrop / fitSize 存在", typeof st.computeCrop + " / " + typeof st.fitSize);

  // ① dpr=1、无页面缩放：截图 1200×800，视口 1200×800 ⇒ k=1
  let c = st.computeCrop({ x: 100, y: 50, w: 300, h: 200 }, 1200, 800, 1200, 800);
  check(c.k === 1 && c.x === 100 && c.y === 50 && c.w === 300 && c.h === 200,
    "用例 1：dpr=1 无缩放（k=1）→ 裁剪区 = 拖框", "k=" + c.k + " → " + j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ② dpr=2：截图 2400×1600，视口 1200×800 ⇒ k=2
  c = st.computeCrop({ x: 100, y: 50, w: 300, h: 200 }, 2400, 1600, 1200, 800);
  check(c.k === 2 && c.x === 200 && c.y === 100 && c.w === 600 && c.h === 400,
    "用例 2：dpr=2（k=2）→ 裁剪区翻倍", "k=" + c.k + " → " + j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ③ dpr=2 + 页面缩放 125%：截图 3000×2000，视口 1200×800 ⇒ k=2.5
  c = st.computeCrop({ x: 100, y: 50, w: 300, h: 200 }, 3000, 2000, 1200, 800);
  check(c.k === 2.5 && c.x === 250 && c.y === 125 && c.w === 750 && c.h === 500,
    "用例 3：dpr=2 + 页面缩放 125%（k=2.5）", "k=" + c.k + " → " + j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ④ 页面缩放 80%：截图 960×640，视口 1200×800 ⇒ k=0.8
  c = st.computeCrop({ x: 100, y: 50, w: 300, h: 200 }, 960, 640, 1200, 800);
  check(c.k === 0.8 && c.x === 80 && c.y === 40 && c.w === 240 && c.h === 160,
    "用例 4：页面缩放 80%（k=0.8）→ 裁剪区缩小", "k=" + c.k + " → " + j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑤ 小数四舍五入：k=1.5
  c = st.computeCrop({ x: 10.4, y: 10.5, w: 100.2, h: 50.6 }, 1800, 1200, 1200, 800);
  check(c.x === 16 && c.y === 16 && c.w === 150 && c.h === 76,
    "用例 5：小数四舍五入（round，不 floor 不 ceil）", "k=" + c.k + " → " + j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑥ 左边越界（框拖到视口外）
  c = st.computeCrop({ x: -100, y: 50, w: 300, h: 200 }, 1200, 800, 1200, 800);
  check(c.x === 0 && c.w === 200 && c.y === 50 && c.h === 200,
    "用例 6：左边界越界 → 夹到 0，宽度同步减掉被切的部分", j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑦ 上边界越界
  c = st.computeCrop({ x: 100, y: -40, w: 300, h: 200 }, 1200, 800, 1200, 800);
  check(c.y === 0 && c.h === 160 && c.x === 100 && c.w === 300,
    "用例 7：上边界越界 → 夹到 0，高度同步减", j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑧ 右/下越界（夹在图片边界内）
  c = st.computeCrop({ x: 1100, y: 700, w: 300, h: 200 }, 1200, 800, 1200, 800);
  check(c.x === 1100 && c.w === 100 && c.y === 700 && c.h === 100,
    "用例 8：右/下边界越界 → 裁到图片边界内", j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑨ 完全在图片外
  c = st.computeCrop({ x: 2000, y: 2000, w: 100, h: 100 }, 1200, 800, 1200, 800);
  check(c.x === 1200 && c.y === 800 && c.w === 0 && c.h === 0,
    "用例 9：框完全在截图外 → 宽高夹成 0（上层会拦下来，不会瞎裁）", j({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // ⑩ fitSize：长边 ≤ 1280（只缩不放）
  const f1 = st.fitSize(2400, 1200, 1280);
  const f2 = st.fitSize(800, 600, 1280);
  const f3 = st.fitSize(100, 5000, 1280);
  check(f1.w === 1280 && f1.h === 640, "用例 10：长边 2400 → 缩到 1280（保持比例）", j(f1));
  check(f2.w === 800 && f2.h === 600, "用例 11：本来就没超（800×600）→ 不放大", j(f2));
  check(f3.h === 1280 && f3.w === 26, "用例 12：竖长图（100×5000）→ 长边也压到 1280", j(f3));

  // ⑬ 采样点：3×3 + 中心点，且夹在视口内
  const pts = st.regionSamplePoints({ x: 0, y: 0, w: 400, h: 400 }, 1200, 800);
  const hasCenter = pts.some((p) => p.x === 200 && p.y === 200);
  const inBox = pts.every((p) => p.x >= 0 && p.x <= 400 && p.y >= 0 && p.y <= 400);
  check(pts.length === 9 && hasCenter && inBox, "用例 13：3×3 采样 + 中心点（去重后 9 个，全在框内）", pts.length + " 个点，中心点=" + hasCenter);
  const ptsEdge = st.regionSamplePoints({ x: 1190, y: 790, w: 100, h: 100 }, 1200, 800);
  const inView = ptsEdge.every((p) => p.x <= 1199 && p.y <= 799);
  check(inView, "用例 14：框贴到视口右下角 → 采样点夹在视口内（越界的点取不到元素）", j(ptsEdge.slice(-1)));
}

log("");
log("=== 二、命中判定（拖框 → 走文字路还是截图路） ===");
log("判据：拼起来的文本 ≥ 12 字（中英合计）且 ≥ 1 个\"够格段落\"（单个元素自己的文本 ≥ 12 字）→ 文字路；否则截图路");
log("");
{
  const { doc, st } = fresh();
  const roadOf = (box) => st.regionDecide(st.regionCandidates(box));

  // ① 纯文本段
  setBody(doc, '<p class="para">This is a normal paragraph with plenty of text to translate.</p>');
  rectOf(doc.querySelector("p.para"), 100, 100, 400, 80);
  let d = roadOf({ x: 140, y: 110, w: 300, h: 50 });
  check(d.road === "text" && d.paras === 1, "用例 1：纯文本段（<p> 一句话）→ 文字路", "road=" + d.road + " joined=" + d.joined + " paras=" + d.paras);
  check(d.cands.length === 1 && tagOf(d.cands[0].el) === "<p class=para>", "用例 1 补：选中的就是那个 <p> 本身", tagOf(d.cands[0] && d.cands[0].el));

  // ② 图片块（框里只有图，没有文字）
  setBody(doc, '<div class="pic"><img src="a.png"></div>');
  rectOf(doc.querySelector("div.pic"), 500, 200, 400, 300);
  d = roadOf({ x: 550, y: 250, w: 300, h: 200 });
  check(d.road === "image" && d.cands.length === 0, "用例 2：图片块（取不到 DOM 文本）→ 截图路", "road=" + d.road + " 候选=" + d.cands.length);

  // ③ SPA 式 <div> 套 <span>：碎片拼起来超过 12 字，但没有"够格段落"
  setBody(doc, '<div class="spa"><span>Post</span><span>by</span><span>someone</span></div>');
  rectOf(doc.querySelectorAll("span")[0], 600, 300, 60, 20);
  rectOf(doc.querySelectorAll("span")[1], 670, 300, 30, 20);
  rectOf(doc.querySelectorAll("span")[2], 710, 300, 90, 20);
  d = roadOf({ x: 580, y: 290, w: 240, h: 40 });
  check(d.joined >= 12 && d.paras === 0 && d.road === "image",
    "用例 3：SPA 碎片（3 个 <span>，拼起来 13 字但没一段够格）→ 截图路",
    "joined=" + d.joined + " paras=" + d.paras + " road=" + d.road);

  // ④ 卡片标题写成 <a>（≥12 字）→ 文字路，且选中的是 <a> 而不是卡片壳子
  setBody(doc, '<div class="card"><a class="title" href="/news/1">Introducing Health Check in Vortex</a></div>');
  const a = rectOf(doc.querySelector("a.title"), 100, 400, 400, 30);
  rectOf(doc.querySelector("div.card"), 80, 380, 900, 200);
  d = roadOf({ x: 120, y: 405, w: 300, h: 20 });
  check(d.road === "text" && d.cands.length === 1 && d.cands[0].el === a,
    "用例 4：卡片标题 <a>（≥12 字）→ 文字路，选中 <a> 本身（不是卡片壳子）",
    "road=" + d.road + " → " + d.cands.map((c) => tagOf(c.el)).join(" "));

  // ⑤ 译文节点（.st-trans）里的文字不算
  setBody(doc, '<div class="st-trans">【译】A long enough paragraph for translation.</div>');
  rectOf(doc.querySelector("div.st-trans"), 100, 600, 400, 60);
  d = roadOf({ x: 120, y: 610, w: 300, h: 40 });
  check(d.road === "image" && d.cands.length === 0, "用例 5：框到我们插的译文（.st-trans）→ 不算文字，走截图路", "road=" + d.road + " 候选=" + d.cands.length);

  // ⑥ 导航区（nav/header/footer/aside/[role=menu]）不给
  setBody(doc, '<nav><a href="/">Home page link with long text</a></nav>');
  rectOf(doc.querySelector("a"), 100, 100, 300, 30);
  d = roadOf({ x: 110, y: 105, w: 260, h: 20 });
  check(d.road === "image" && d.cands.length === 0, "用例 6：<nav> 里的链接不给 → 截图路", "road=" + d.road + " 候选=" + d.cands.length);

  setBody(doc, '<aside><p>A long paragraph sitting inside the sidebar area.</p></aside>');
  rectOf(doc.querySelector("p"), 100, 100, 300, 30);
  d = roadOf({ x: 110, y: 105, w: 260, h: 20 });
  check(d.cands.length === 0, "用例 7：<aside> 里的段落也不给", "候选=" + d.cands.length);

  // ⑧ 框外的文字不算（只认框里的采样点）
  setBody(doc, '<p class="in">Inside the box there is a long paragraph of text.</p><p class="out">Outside the box there is another long paragraph.</p>');
  rectOf(doc.querySelector("p.in"), 100, 100, 300, 40);
  rectOf(doc.querySelector("p.out"), 100, 500, 300, 40);
  d = roadOf({ x: 110, y: 105, w: 260, h: 25 });
  check(d.cands.length === 1 && d.cands[0].el === doc.querySelector("p.in"), "用例 8：只认框内的文字（框外那段不算）", d.cands.map((c) => tagOf(c.el)).join(" "));

  // ⑨ 界值：正好 12 字算够格
  setBody(doc, '<div class="twelve">abcdefghijkl</div>');
  rectOf(doc.querySelector("div.twelve"), 100, 100, 300, 40);
  d = roadOf({ x: 110, y: 105, w: 260, h: 25 });
  check(d.paras === 1 && d.road === "text", "用例 9：单元素正好 12 字 → 算够格（≥12）", "joined=" + d.joined + " paras=" + d.paras);
  setBody(doc, '<div class="eleven">abcdefghijk</div>');
  rectOf(doc.querySelector("div.eleven"), 100, 100, 300, 40);
  d = roadOf({ x: 110, y: 105, w: 260, h: 25 });
  check(d.paras === 0 && d.road === "image", "用例 10：只有 11 字 → 不够格，走截图路", "joined=" + d.joined + " paras=" + d.paras);

  // ⑪ 识图返回解析
  const p1 = st.parseVisionPairs("【原文】vault\n【译文】仓库\n【原文】Damage Meter\n【译文】伤害统计");
  check(p1.length === 2 && p1[0].dst === "仓库" && p1[1].src === "Damage Meter", "用例 11：【原文】/【译文】成对解析（卡片依赖它）", j(p1));
  const p2 = st.parseVisionPairs("模型没按格式返回，一大段话");
  check(p2.length === 1 && p2[0].dst.indexOf("模型没按格式") === 0, "用例 12：模型没按格式 → 整段当译文（不吞内容）", j(p2));
}

log("");
log("=== 三、端到端（跑【真】content.js + 桩后台） ===");
log("");
(async () => {
  // ---------- ① 文字路：拖框 → 插译文 + 卡片 ----------
  {
    log("--- ① 文字路：拖一个框，框内是一段正常文字 ---");
    const { doc, C, st } = fresh({ settings: { model: "stub-model" } });
    setBody(doc, '<p class="para">This paragraph is long enough to take the text road.</p>');
    rectOf(doc.querySelector("p.para"), 200, 200, 400, 100);

    const enter = await send(C.listeners, { type: "regionMode", on: true });
    check(enter.region === true, "点「区域翻译」→ 进区域模式", "region=" + enter.region);
    check(!!doc.getElementById("st-region-overlay"), "全屏遮罩出现（下面就是页面，ESC 能退）", tagOf(doc.getElementById("st-region-overlay")));
    const pill = doc.getElementById("st-region-pill");
    check(!!pill && pill.textContent.indexOf("拖拽框选") >= 0, "提示条出现且文案是「拖拽框选要翻译的区域　ESC 取消」", j(pill && pill.textContent));

    doc.dispatch("mousedown", { clientX: 220, clientY: 220, button: 0, preventDefault() {}, stopPropagation() {} });
    doc.dispatch("mousemove", { clientX: 560, clientY: 290, preventDefault() {}, stopPropagation() {} });
    const rbox = doc.querySelector(".st-region-rect");
    check(!!rbox && rbox.style.display === "block" && rbox.style.left === "220px" && rbox.style.top === "220px" &&
      rbox.style.width === "340px" && rbox.style.height === "70px",
      "拖拽时显示实时矩形（半透明蓝底 + 描边，位置/尺寸跟着鼠标）",
      rbox ? j({ l: rbox.style.left, t: rbox.style.top, w: rbox.style.width, h: rbox.style.height }) : "(没有矩形)");

    doc.dispatch("mouseup", { clientX: 560, clientY: 290, preventDefault() {}, stopPropagation() {} });
    const cardOk = await waitFor(() => !!doc.getElementById("st-card"));
    check(cardOk, "松手后出现结果卡片", cardOk ? "" : "（等不到卡片）");
    check(doc.querySelectorAll(".st-trans").length === 1, "文字路：译文直接插在原文下方（复用现有插入逻辑）",
      doc.querySelectorAll(".st-trans").map((n) => j(n.textContent)).join(" | "));
    const tag = doc.querySelector(".st-card-tag");
    check(!!tag && tag.textContent.indexOf("文字路") === 0, "卡片上写明走的是哪条路", j(tag && tag.textContent));
    const foot = doc.querySelector(".st-card-foot");
    check(!!foot && foot.textContent.indexOf("模型 stub-model") >= 0 && foot.textContent.indexOf("耗时") >= 0,
      "卡片上写明模型 + 耗时", j(foot && foot.textContent));
    check(doc.getElementById("st-region-pill").textContent.indexOf("文字路") >= 0,
      "提示条上短暂显示判定结果（给无明/老板排障用）", j(doc.getElementById("st-region-pill").textContent));
    check(!doc.getElementById("st-region-overlay"), "判定完之后遮罩已撤掉（不挡页面）");
    const after = await send(C.listeners, { type: "status" });
    check(after.state.region === false, "松手之后区域模式自己收掉（按钮会回到「🔎 区域翻译」）", "region=" + after.state.region);

    // 卡片按钮：切原文 / 复制 / ✕
    const body = doc.querySelector(".st-card-body");
    const zhText = body.textContent;
    clickOn(doc.getElementById("st-card"), doc.querySelector('[data-act="toggle"]'));
    check(body.textContent.indexOf("This paragraph is long enough") === 0, "「切原文」→ 卡片正文换成原文", j(body.textContent));
    clickOn(doc.getElementById("st-card"), doc.querySelector('[data-act="toggle"]'));
    check(body.textContent === zhText, "再点一下 → 切回译文", j(body.textContent));
    clickOn(doc.getElementById("st-card"), doc.querySelector('[data-act="copy"]'));
    await tick(10);
    check(C.clipboard.length === 1 && C.clipboard[0] === zhText, "「复制」→ 剪贴板拿到的是当前显示的文本", j(C.clipboard[0] || ""));
    const ins = doc.querySelector('[data-act="insert"]');
    check(!!ins, "文字路：卡片上有「插入到原文下方」按钮", ins ? j(ins.textContent) : "(没有)");
    clickOn(doc.getElementById("st-card"), ins);
    check(ins.disabled === true && doc.querySelectorAll(".st-trans").length === 1, "点它 → 已插过的不会重复插（如实回话）", j(ins.textContent));
    clickOn(doc.getElementById("st-card"), doc.querySelector('[data-act="close"]'));
    check(!doc.getElementById("st-card"), "「✕」→ 卡片关掉");
    log("");
  }

  // ---------- ② 截图路：图片块 → 截图 → 裁剪 → 识图 → 卡片 ----------
  {
    log("--- ② 截图路：框里是图片（DOM 取不到文字） ---");
    const SHOT = "data:image/png;base64,SHOT-DPR2";
    setImageDims(SHOT, 2400, 1600);                    // 截图 = 视口 1200×800 的 2 倍（dpr=2）
    const { doc, C, st } = fresh({ captureDataUrl: SHOT, session: {}, settings: { visionModel: "stub-vision-model" } });
    setBody(doc, '<div class="pic"><img src="a.png"></div>');
    rectOf(doc.querySelector("div.pic"), 500, 200, 400, 300);

    const res = await st.finishRegion({ x: 100, y: 50, w: 300, h: 200 });
    check(res.ok === true && res.road === "image", "图片块 → 走截图路（自动截图送多模态）", "road=" + res.road + " ok=" + res.ok);
    check(C.calls.capture === 1 && C.calls.vision === 1, "截图 1 次、识图 1 次（都经 background）", "capture=" + C.calls.capture + " vision=" + C.calls.vision);
    check(res.bytes === Math.round(600 * 400 * 0.85) && res.quality === 0.85,
      "压缩：长边 ≤1280 + JPEG q85（这次 600×400 没超 400KB，不用降质量）",
      "bytes=" + res.bytes + " quality=" + res.quality);
    const cv = doc.canvases[0];
    const dr = cv && cv.__draw;
    check(!!dr && dr[1] === 200 && dr[2] === 100 && dr[3] === 600 && dr[4] === 400 && dr[7] === 600 && dr[8] === 400,
      "裁剪真的按 k=2 换算后画进去（drawImage(src=200,100,600,400 → dst=0,0,600,400)）",
      dr ? j({ sx: dr[1], sy: dr[2], sw: dr[3], sh: dr[4], dw: dr[7], dh: dr[8] }) : "(没有 drawImage)");
    const body = doc.querySelector(".st-card-body");
    check(!!body && body.textContent.indexOf("你好，世界") >= 0, "卡片正文 = 识图返回的【译文】", j(body && body.textContent));
    check(!doc.querySelector('[data-act="insert"]'), "截图路：卡片上没有「插入到原文下方」（没原文可插）");
    const tag = doc.querySelector(".st-card-tag");
    check(!!tag && tag.textContent.indexOf("截图路") === 0, "卡片上写明走的是截图路", j(tag && tag.textContent));
    const dbg = (await send(C.listeners, { type: "status" })).state.regionDebug;
    check(!!dbg && dbg.sentW === 600 && dbg.sentH === 400 && dbg.crop.w === 600 && dbg.crop.h === 400 && dbg.imgW === 2400,
      "status 里能拿到 regionDebug（CDP 复验用：送出去的图尺寸 = 框尺寸 × dpr）",
      dbg ? j({ sentW: dbg.sentW, sentH: dbg.sentH, crop: dbg.crop, img: dbg.imgW + "x" + dbg.imgH }) : "(没有)");

    // 缓存：同 URL + 同矩形（±4px）→ 直接复用
    const res2 = await st.finishRegion({ x: 103, y: 52, w: 300, h: 200 });
    check(res2.cached === true && C.calls.capture === 1 && C.calls.vision === 1,
      "缓存：同矩形 ±4px 内 5 分钟内再来一次 → 直接用缓存（不重复花钱）",
      "cached=" + res2.cached + " capture=" + C.calls.capture + " vision=" + C.calls.vision);
    const res3 = await st.finishRegion({ x: 110, y: 50, w: 300, h: 200 });
    check(res3.cached !== true && C.calls.capture === 2, "差 10px（超过 ±4）→ 缓存不命中，老老实实重新截图", "capture=" + C.calls.capture);
    const storedBag = await C.ctx.chrome.storage.session.get("st:region-cache");
    const storedList = storedBag["st:region-cache"];
    check(Array.isArray(storedList) && storedList.length === 2 && storedList[0].href === "https://example.com/page" &&
      storedList[0].rect.w === 300 && storedList[0].pairs.length === 1 && storedList[0].model === "stub-vision-model" && typeof storedList[0].ts === "number",
      "缓存落在 chrome.storage.session：记了 URL / 矩形 / 译文 / 模型 / 时间戳",
      storedList ? storedList.length + " 条 · " + j({ href: storedList[0].href, rect: storedList[0].rect, model: storedList[0].model }) : "(没有)");

    // 缓存过期：手塞一条 6 分钟前的记录 → 不该命中
    C.ctx.chrome.storage.session.set({
      "st:region-cache": [{ href: "https://example.com/page", rect: { x: 100, y: 50, w: 300, h: 200 }, pairs: [], model: "old", ts: Date.now() - 6 * 60 * 1000 }],
    });
    const res4 = await st.finishRegion({ x: 100, y: 50, w: 300, h: 200 });
    check(res4.cached !== true && C.calls.capture === 3, "缓存超过 5 分钟 → 不命中", "capture=" + C.calls.capture);
    log("");
  }

  // ---------- ③ 护栏：大框提醒 + 超 400KB 降质量 ----------
  {
    log("--- ③ 护栏：框太大提醒、图太大降质量 ---");
    const SHOT = "data:image/png;base64,SHOT-BIG";
    setImageDims(SHOT, 1200, 800);
    const { doc, C, st } = fresh({ captureDataUrl: SHOT, session: {} });
    setBody(doc, '<div class="pic"><img src="a.png"></div>');
    rectOf(doc.querySelector("div.pic"), 0, 0, 1200, 800);
    await send(C.listeners, { type: "regionMode", on: true });
    doc.dispatch("mousedown", { clientX: 10, clientY: 10, button: 0, preventDefault() {}, stopPropagation() {} });
    doc.dispatch("mousemove", { clientX: 1150, clientY: 700, preventDefault() {}, stopPropagation() {} });
    doc.dispatch("mouseup", { clientX: 1150, clientY: 700, preventDefault() {}, stopPropagation() {} });
    await waitFor(() => !!doc.getElementById("st-card"));
    const pillText = doc.getElementById("st-region-pill").textContent;
    check(pillText.indexOf("框小一点更准（小字放大会更清楚）") >= 0, "框选面积 > 视口 40% → 提示条提醒「框小一点更准（小字放大会更清楚）」（只是提醒，不禁止）", j(pillText));
    check(!!doc.getElementById("st-card"), "大框照样翻（护栏不拦）");
    const foot = doc.querySelector(".st-card-foot");
    check(!!foot && /q(0\.[0-9]+)/.test(foot.textContent), "卡片脚注带上这趟图的体积与质量档位", j(foot && foot.textContent));
    log("");
  }

  // ---------- ④ 退化 + 退出 ----------
  {
    log("--- ④ 截图失败要退化、ESC/右键/再点按钮要能干净退出 ---");
    const { doc, C, st } = fresh({ captureError: "没拿到 activeTab 授权", session: {} });
    setBody(doc, '<div class="pic"><img src="a.png"></div>');
    rectOf(doc.querySelector("div.pic"), 0, 0, 1000, 700);
    await send(C.listeners, { type: "regionMode", on: true });
    doc.dispatch("mousedown", { clientX: 100, clientY: 100, button: 0, preventDefault() {}, stopPropagation() {} });
    doc.dispatch("mousemove", { clientX: 400, clientY: 400, preventDefault() {}, stopPropagation() {} });
    doc.dispatch("mouseup", { clientX: 400, clientY: 400, preventDefault() {}, stopPropagation() {} });
    await tick(80);
    const pillText = doc.getElementById("st-region-pill").textContent;
    check(C.calls.capture === 1 && C.calls.vision === 0, "截图失败时不继续瞎调识图接口", "capture=" + C.calls.capture + " vision=" + C.calls.vision);
    check(pillText.indexOf("截图失败") >= 0 && pillText.indexOf("只能走文字路") >= 0,
      "给一句人话提示 + 退化为「仅文字路」，不崩", j(pillText));
    check(doc.querySelectorAll(".st-trans").length === 0 && !doc.getElementById("st-card"), "失败时页面一个字节没动");
    check(!!doc.getElementById("st-region-pill"), "失败提示留在提示条上（不弹窗）");
    log("");

    // ESC 退出
    const e1 = fresh({ session: {} });
    setBody(e1.doc, '<p class="para">A paragraph that should NOT be translated by ESC.</p>');
    rectOf(e1.doc.querySelector("p.para"), 100, 100, 400, 60);
    await send(e1.C.listeners, { type: "regionMode", on: true });
    e1.doc.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    const st1 = await send(e1.C.listeners, { type: "status" });
    check(st1.state.region === false, "ESC → 退出区域模式", "region=" + st1.state.region);
    check(!e1.doc.getElementById("st-region-overlay") && !e1.doc.getElementById("st-region-pill"), "ESC 之后遮罩/提示条都收干净了");
    check(e1.doc.querySelectorAll(".st-trans").length === 0 && e1.C.calls.capture === 0, "ESC 不改页面（没译文、没截图）",
      "译文=" + e1.doc.querySelectorAll(".st-trans").length + " capture=" + e1.C.calls.capture);

    // 右键退出
    const e2 = fresh({ session: {} });
    setBody(e2.doc, "<div>whatever</div>");
    await send(e2.C.listeners, { type: "regionMode", on: true });
    e2.doc.dispatch("contextmenu", { preventDefault() {}, stopPropagation() {} });
    const st2 = await send(e2.C.listeners, { type: "status" });
    check(st2.state.region === false && !e2.doc.getElementById("st-region-overlay"), "右键 → 退出区域模式", "region=" + st2.state.region);

    // 再点一次按钮
    const e3 = fresh({ session: {} });
    setBody(e3.doc, "<div>whatever</div>");
    await send(e3.C.listeners, { type: "regionMode", on: true });
    const off = await send(e3.C.listeners, { type: "regionMode", on: false });
    check(off.region === false && off.summary.indexOf("没改页面") >= 0, "popup 再点一次按钮 → 退出（回话里明确说了没改页面）", j(off.summary));

    // 小拖拽（只是点一下）不算框
    const e4 = fresh({ session: {} });
    setBody(e4.doc, "<div>whatever</div>");
    await send(e4.C.listeners, { type: "regionMode", on: true });
    e4.doc.dispatch("mousedown", { clientX: 100, clientY: 100, button: 0, preventDefault() {}, stopPropagation() {} });
    e4.doc.dispatch("mouseup", { clientX: 102, clientY: 101, preventDefault() {}, stopPropagation() {} });
    await tick(40);
    const st4 = await send(e4.C.listeners, { type: "status" });
    check(st4.state.region === true && e4.C.calls.capture === 0, "拖了 2px（其实只是点了一下）→ 当没框，继续等下一次拖拽", "region=" + st4.state.region);
    log("");
  }

  log("=== 四、版本 ===");
  {
    const { C } = fresh();
    check(C.st.SCRIPT_VERSION === EXT_VERSION && C.st.PI === 2,
      "content.js 的 SCRIPT_VERSION 与 manifest 的 version 一致（popup 靠它判「本页要不要刷新」）",
      "SCRIPT_VERSION=" + C.st.SCRIPT_VERSION + " manifest=" + EXT_VERSION + " PI=" + C.st.PI);
  }

  log("");
  log("=== 汇总 ===");
  log("通过 " + pass + " 项，失败 " + fail + " 项" + (fail ? "  ❌" : "  ✅"));
  fs.writeFileSync(path.join(__dirname, "region-check-output.txt"), out.join("\r\n") + "\r\n", "utf8");
  process.exit(fail ? 1 : 0);
})();
