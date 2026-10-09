/* 屏幕翻译 · 交付前静态自检（第 4 轮建；第 5 轮加了第 ⑫ 节。不启动浏览器、不联网、不花钱）
 * 跑法：node edge-translate/tools/static-check.js   （在仓库根执行）
 *
 * 覆盖：语法 / manifest / HTML 结构 / id 引用对账 / 本轮新增点 /
 *       协议与契约不变量（不该被本轮动到的）/ 编码换行 / .st-trans 既有排版没被动 */
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");  // 仓库根 = tools/ 的上一级（脚本自定位，换目录也能跑）
let pass = 0, fail = 0;
const log = (s) => console.log(s);
function ck(ok, label, detail) { if (ok) pass++; else fail++; log((ok ? "PASS  " : "FAIL  ") + label + (detail !== undefined ? "   -> " + detail : "")); }
const rd = (f) => fs.readFileSync(ROOT + "\\" + f, "utf8");
const has = (s, sub) => s.indexOf(sub) >= 0;
const hasAll = (s, list) => list.every((x) => s.indexOf(x) >= 0);
const missing = (s, list) => list.filter((x) => s.indexOf(x) < 0);

log("--- ① 语法 / JSON ---");
for (const f of ["src\\content.js", "src\\popup.js", "src\\options.js", "src\\background.js", "tools\\stub-dom.js", "tools\\selfcheck.js", "tools\\region-check.js"]) {
  try { execFileSync(process.execPath, ["--check", ROOT + "\\" + f], { stdio: "pipe" }); ck(true, "node --check " + f); }
  catch (e) { ck(false, "node --check " + f, String(e.stderr || e.message).slice(0, 200)); }
}
let mf = null;
try { mf = JSON.parse(rd("manifest.json")); ck(true, "manifest.json 可 JSON.parse"); } catch (e) { ck(false, "manifest.json 可 JSON.parse", e.message); }
ck(!!mf && mf.version === "0.3.1", "manifest.version = 0.3.1（第 5 轮）", mf && mf.version);
ck(!!mf && mf.manifest_version === 3, "manifest_version 仍是 3");
ck(!!mf && JSON.stringify(mf.permissions) === JSON.stringify(["storage", "activeTab", "scripting"]),
  "permissions 没动（截图靠 activeTab，不用新权限）", JSON.stringify(mf.permissions));
ck(!!mf && JSON.stringify(mf.host_permissions) === JSON.stringify(["https://api.deepseek.com/*"]),
  "host_permissions 没动（识图端点同一个域）", JSON.stringify(mf.host_permissions));
ck(!!mf && mf.content_scripts[0].matches.join(",") === "http://*/*,https://*/*,file:///*", "content_scripts.matches 没动（file:// 自测路径还在）");
ck(!!mf && mf.content_scripts[0].js.join(",") === "src/content.js" && mf.content_scripts[0].css.join(",") === "src/content.css", "注入的 js/css 没变");
ck(!!mf && mf.background.service_worker === "src/background.js" && mf.background.type === "module", "background 配置没变");

log("");
log("--- ② 结构：HTML 标签配平 / id 唯一 ---");
function stripText(html) { return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, ""); }
for (const f of ["src\\popup.html", "src\\options.html"]) {
  const h = rd(f);
  // 自闭合的 void 标签（meta/link/br/hr/img/input…）整段删掉，剩下的开/闭标签数应该相等
  const VOID = /<(?:meta|link|br|hr|img|input|source|area|base|col|embed|track|wbr)\b[^>]*>/gi;
  const skel = h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(VOID, "");
  const tally = {};
  (skel.match(/<([a-zA-Z][\w-]*)(?=[\s>/])/g) || []).forEach((t) => { const k = t.slice(1).toLowerCase(); tally[k] = (tally[k] || 0) + 1; });
  (skel.match(/<\/([a-zA-Z][\w-]*)>/g) || []).forEach((t) => { const k = t.slice(2, -1).toLowerCase(); tally[k] = (tally[k] || 0) - 1; });
  const bad = Object.entries(tally).filter(([, v]) => v !== 0);
  ck(bad.length === 0, f + " 开闭标签配平", bad.length ? JSON.stringify(bad) : Object.keys(tally).length + " 种标签全配平");
  const ids = (h.match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1));
  const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
  ck(dup.length === 0, f + " 无重复 id", dup.length ? JSON.stringify(dup) : ids.length + " 个 id 全唯一");
}

log("");
log("--- ③ 引用对账 ---");
const popupHtml = rd("src\\popup.html"), popupJs = rd("src\\popup.js");
const optionsHtml = rd("src\\options.html"), optionsJs = rd("src\\options.js");
const htmlIds = (h) => new Set((h.match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1)));
const jsIds = (j) => Array.from(new Set((j.match(/\$\("([^"]+)"\)/g) || []).map((s) => s.slice(3, -2))));
for (const [label, html, js] of [["popup", popupHtml, popupJs], ["options", optionsHtml, optionsJs]]) {
  const have = htmlIds(html);
  const want = jsIds(js);
  const miss = want.filter((id) => !have.has(id));
  ck(miss.length === 0, label + ".js 里 $(\"…\") 取的 id 全在 HTML 里", want.length + " 个 id，缺 " + miss.length + (miss.length ? "：" + JSON.stringify(miss) : ""));
}
const css = rd("src\\content.css");
const cssVars = Array.from(new Set((css.match(/var\((--[\w-]+)/g) || []).map((s) => s.slice(4))));
const js = rd("src\\content.js");
const notSet = cssVars.filter((v) => !has(js, "setProperty(\"" + v + "\""));
ck(notSet.length === 0, "content.css 用到的 var(--st-*) 全由 content.js 注入", cssVars.join(",") + "；缺 " + JSON.stringify(notSet));

log("");
log("--- ④ 第 3 轮那几条命门还在（版本纪律 / 陈旧脚本检测） ---");
ck((js.match(/const PI = (\d+);/) || [])[1] === "2", "content.js 里 PI = 2（本轮消息是加类型，协议没变）", (js.match(/const PI = (\d+);/) || [])[0]);
ck(new RegExp('const SCRIPT_VERSION = "' + (mf && mf.version) + '";').test(js), "content.js 的 SCRIPT_VERSION 与 manifest.version 一致（命门）", (js.match(/const SCRIPT_VERSION = "([^"]+)";/) || [])[0]);
ck(has(js, "script: { pi: PI, version: SCRIPT_VERSION }"), "content.js 的 status 响应带上 script{pi,version}");
ck(has(popupJs, "const NEED_PI = 2;"), "popup.js 里 NEED_PI = 2");
ck(has(popupJs, "chrome.runtime.getManifest().version"), "popup.js 读 chrome.runtime.getManifest().version");
ck(/tabs\.reload/.test(popupJs), "popup.js 用 chrome.tabs.reload（刷新本页）");
ck(/id="reload"/.test(popupHtml) && /id="stale"/.test(popupHtml) && /id="ver"/.test(popupHtml), "popup.html 有 #stale / #reload / #ver");

log("");
log("--- ⑤ 第 4 轮 T1：区域模式骨架（拖框 → 选路） ---");
ck((js.match(/msg\?\.type === "regionMode"/) || []).length === 1, "content.js 认识 regionMode 消息");
ck(has(js, "const REGION_MIN_JOINED = 12;") && has(js, "const REGION_MIN_PARA = 12;"),
  "判定阈值：拼起来 ≥12 字 + ≥1 个够格段落（单个元素 ≥12 字）");
ck(hasAll(js, ["function regionSamplePoints(", "function regionCandidates(", "function regionDecide("]),
  "3×3 采样 / 命中判定 / 选路 三个函数都在");
ck(has(js, "document.elementsFromPoint("), "命中判定用 document.elementsFromPoint()");
ck(has(js, "for (const fx of [0.25, 0.5, 0.75])") && has(js, "push(rect.x + rect.w / 2, rect.y + rect.h / 2);"),
  "采样点 = 框内 3×3 + 中心点");
ck(has(js, 'el.closest("." + CLS)') && has(js, "inChromeZone(el)"), "过滤：.st-trans 内不给、导航/页眉/页脚/侧栏不给");
ck(has(js, "const REGION_MIN_DRAG = 8;"), "拖拽小于 8px 当“只是点了一下”，不算框");
ck(hasAll(js, ["onRegionDown", "onRegionMove", "onRegionUp", "onRegionKey", "onRegionContext"]),
  "拖拽 / 实时矩形 / ESC / 右键 五条交互都在");
ck(has(js, 'setRegionPill("拖拽框选要翻译的区域　ESC 取消", 0);'), "提示条文案就是任务单里那句");
ck(has(js, "判定：文字路") && has(js, "判定：截图路"), "命中结果会在提示条上短暂显示「文字路」/「截图路」");
ck(has(js, "exitRegionMode();") && has(js, "已退出区域模式（没改页面）"), "ESC/右键/再点按钮 → 退出且不改页面");
ck(has(popupHtml, 'id="region"') && has(popupHtml, "🔎 区域翻译（拖框，万能）"), "popup 有「🔎 区域翻译（拖框，万能）」按钮");
ck(has(popupJs, 'type: "regionMode"') && has(popupJs, "function setRegionLabel("), "popup 发 regionMode、并按状态切按钮文案");
ck(has(popupHtml, "翻译本页（文章/文献）") && has(popupHtml, "选段翻译（只翻我点的几段）"),
  "两个入口文案分清：翻译本页（文章/文献）/ 选段翻译（只翻我点的几段）");
ck(!has(popupHtml, "🎯 框选翻译（只翻我选的几段）"), "旧的「🎯 框选翻译」文案已改名");

log("");
log("--- ⑥ 第 4 轮 T2：截图 + 坐标换算 + 识图规格（照抄任务单 T2.2） ---");
const bg = rd("src\\background.js");
ck(has(js, "function computeCrop(rect, imgW, imgH, viewW, viewH)"), "坐标换算独立成函数（自检直接喂数据）");
ck(has(js, "const k = (Number(viewW) > 0 && Number(imgW) > 0) ? Number(imgW) / Number(viewW) : 1;"),
  "k = 截图宽度 / window.innerWidth（把 dpr 与页面缩放一起算进去）");
ck(has(js, "Math.round(Number(rect.x || 0) * k)") && has(js, "Math.round(Number(rect.w || 0) * k)"),
  "裁剪区 = rect*k，四舍五入");
ck(has(js, "if (x < 0) { w += x; x = 0; }") && has(js, "w = Math.min(w, Number(imgW) - x);"),
  "夹紧：越界剪到 0、超出图片边界裁到边界内");
ck(has(js, "const VISION_MAX_SIDE = 1280;") && has(js, "fitSize(crop.w, crop.h, VISION_MAX_SIDE)"), "长边 ≤ 1280");
ck(has(js, "const VISION_JPEG_QUALITY = 0.85;") && has(js, 'canvas.toDataURL("image/jpeg", q)'), "输出 JPEG q85");
ck(has(js, "const VISION_MAX_BYTES = 400 * 1024;") && has(js, "while (bytesOfBase64(dataUrlBase64(out)) > VISION_MAX_BYTES"),
  "超 400KB 逐档降质量（目标单次 < 400KB）");
ck(has(js, 'chrome.runtime.sendMessage({ type: "capture" })'), "截图走 background（content 拿不到 chrome.tabs）");
ck(has(bg, 'chrome.tabs.captureVisibleTab(null, { format: "png" })'), "background：chrome.tabs.captureVisibleTab(null, {format:\"png\"})");
ck(has(js, "截图失败：") && has(js, "只能走文字路"), "截图失败：人话提示 + 退化为「仅文字路」，不崩");
// ⚠️ 识图 payload：这一坨是任务单 T2.2 的原样规格，一个字都不该被改
ck(has(bg, 'const VISION_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";'), "识图端点 = https://api.deepseek.com/v1/chat/completions");
ck(has(bg, 'thinking: { type: "disabled" },'), "识图 thinking 写成 { type: \"disabled\" }（不是 enabled:false）");
ck(has(bg, "const VISION_MAX_TOKENS = 1500;") && has(bg, "max_tokens: VISION_MAX_TOKENS,"), "识图 max_tokens = 1500");
ck(has(bg, "const VISION_TEMPERATURE = 0.1;") && has(bg, "temperature: VISION_TEMPERATURE,"), "识图 temperature = 0.1");
ck(has(bg, 'model: model,') && has(bg, "const model = settings.visionModel || DEFAULT_VISION_MODEL;"),
  "识图模型走设置项 visionModel（默认 deepseek-v4-flash）");
ck(/content: \[\s*\{ type: "image_url"[\s\S]*?\{ type: "text"/.test(bg), "识图请求里 image_url 在前、text 在后（安卓端实测顺序）");
ck(/【原文】[\s\S]*【译文】/.test(bg) && has(bg, "glossarySuffix(glossaryText)"), "识图 Prompt：用【原文】/【译文】输出 + 注入术语表");
ck(has(bg, 'if (msg?.type === "capture")') && has(bg, 'if (msg?.type === "vision")'), "background 路由：capture / vision");
ck(has(js, 'chrome.runtime.sendMessage({ type: "vision", image: base64 })'), "content 把裁剪后的 JPEG 交给 background 识图");
ck(has(optionsHtml, 'id="visionModel"') && has(optionsJs, "visionModel"), "设置页有识图模型这一项");

log("");
log("--- ⑦ 第 4 轮 T3：结果卡片 ---");
ck(has(js, 'card.className = "st-card"') && has(css, ".st-card {"), "卡片：自己一块浮层（.st-card）");
ck(hasAll(js, ['mkBtn("toggle"', 'mkBtn("copy"', '"close"']), "卡片按钮：切原文/译文 · 复制 · ✕ 关闭");
ck(has(js, 'info.road === "text" ? mkBtn("insert", "插入到原文下方") : null'), "文字路才给「插入到原文下方」");
ck(has(js, 'foot.textContent = "模型 "') && has(js, '" · 耗时 "'), "卡片写明：模型 + 耗时");
ck(has(js, '(info.road === "text" ? "文字路" : "截图路")'), "卡片写明走的是哪条路");
ck(has(js, "function onCardDown(") && has(js, "function onCardMove("), "卡片可拖动");
ck(has(js, "function armCardOutsideClose()") && has(js, "closeResultCard();                                  // 点空白 → 关掉卡片"),
  "点空白关卡片（不给页面加任何阻挡层）");
ck(has(css, ".st-card {") && has(css, "z-index: 2147483647;") && has(css, "pointer-events: auto;"), "卡片的 z-index 拉满、pointer-events 正常");

log("");
log("--- ⑧ 第 4 轮 T4：缓存 / 大框护栏 / 文档 ---");
ck(has(js, 'const REGION_CACHE_KEY = "st:region-cache";') && has(js, "const REGION_CACHE_TTL_MS = 5 * 60 * 1000;") && has(js, "const REGION_CACHE_TOL = 4;"),
  "缓存：同 URL + 同矩形 ±4px + 5 分钟");
ck(has(js, "await store.get(REGION_CACHE_KEY)") && has(js, "await store.set(REGION_CACHE_KEY"), "缓存走 store（session 优先、local 兜底）");
ck(has(js, "const REGION_BIG_RATIO = 0.4;") && has(js, "框小一点更准（小字放大会更清楚）"), "大框护栏：>40% 视口 → 提醒「框小一点更准（小字放大会更清楚）」（不禁止）");
const readme = rd("README.md");
ck(has(readme, "区域翻译"), "README 补了区域翻译说明");
ck(has(readme, "只用于当次识别") && has(readme, "不落盘"), "README 补了截图隐私说明（只用于当次识别、不落盘）");
ck(has(readme, "## 🔁 交付约定") && has(readme, "重新加载"), "README 的交付约定还在");

log("");
log("--- ⑨ 协议/契约不变量（不该被本轮动到的） ---");
ck(has(js, "fetch(") === false, "content.js 里依然没有任何 fetch（AI 调用只在 background）");
ck(has(js, 'const CAND = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption";'), "CAND 选择器一字未改");
ck(has(js, "const MAX_BLOCK_CHARS = 200;"), "MAX_BLOCK_CHARS = 200 未改");
ck(has(js, "const t = `[[${it.id}]] ${it.text}\\n`;"), "编号模板 [[n]] 未改");
ck(/function chunk\(items, limit\) \{[\s\S]*?if \(it\.text\.length > MAX_BLOCK_CHARS\)/.test(js), "chunk() 分块函数体仍在（超长段单独成块）");
ck(/if \(tag === "td" \|\| tag === "th"\) \{/.test(js), "insertAfter 的表格特判未改");
ck(has(bg, 'thinking: { type: "disabled" }') && has(bg, "temperature: 0.1") && has(bg, "max_tokens: 8000"), "文字路的模型参数（thinking/temperature/max_tokens）未改");
ck(has(bg, "\\n\\n术语表（必须遵守）：\\n"), "术语表 prompt 尾巴未改");
const ST_TRANS = [
  ".st-trans {",
  "  margin: 2px 0 6px 0;",
  "  padding: 0 0 0 8px;",
  "  border-left: 3px solid var(--st-border, #7aa2f7);",
  "  color: var(--st-fg, #4a5878);",
  "  background: var(--st-bg, transparent);",
  "  font-size: 0.95em;",
  "  line-height: 1.55;",
  "  white-space: pre-wrap;",
  "}",
].join("\n");
ck(css.replace(/\r\n/g, "\n").indexOf(ST_TRANS) >= 0, ".st-trans 的既有排版规则一个字没动（本轮只加新 class）");
ck(has(css, ".st-region-overlay {") && has(css, ".st-region-rect {") && has(css, ".st-region-pill {"), "区域模式的新样式：遮罩 / 实时矩形 / 提示条");

log("");
log("--- ⑩ 自检脚本自身 ---");
for (const f of ["tools\\stub-dom.js", "tools\\selfcheck.js", "tools\\region-check.js", "tools\\api_smoke_test.py"]) {
  ck(fs.existsSync(ROOT + "\\" + f), "自检脚本在位：" + f);
}
ck(has(rd("tools\\selfcheck.js"), 'require("./stub-dom.js")'), "selfcheck.js 用共享桩（tools/stub-dom.js）");
ck(has(rd("tools\\region-check.js"), 'require("./stub-dom.js")'), "region-check.js 用共享桩");
ck(has(rd("tools\\selfcheck.js"), "EXT_VERSION"), "selfcheck.js 的版本号改成读 manifest（不再写死 0.2.0）");

log("");
log("--- ⑪ 编码/换行 ---");
for (const f of ["src\\content.js", "src\\content.css", "src\\background.js", "src\\popup.html", "src\\popup.js",
                 "src\\options.html", "src\\options.js", "manifest.json", "README.md",
                 "tools\\stub-dom.js", "tools\\selfcheck.js", "tools\\region-check.js", "tools\\static-check.js"]) {
  const b = fs.readFileSync(ROOT + "\\" + f);
  const noBom = !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf);
  const crlf = b.indexOf(Buffer.from([0x0d, 0x0a])) >= 0 && b.indexOf(Buffer.from([0x0a])) >= 0 && b.toString("utf8").replace(/\r\n/g, "").indexOf("\n") < 0;
  const endNl = b[b.length - 1] === 0x0a;
  ck(noBom && crlf && endNl, "UTF-8 无 BOM + CRLF + 末尾换行：" + f, "noBom=" + noBom + " CRLF=" + crlf + " endNL=" + endNl);
}

log("");
log("--- ⑫ 第 5 轮：一键翻完剩余 / 大框文案 / 措辞 ---");
ck(has(popupHtml, 'id="cont"') && has(popupHtml, "一键翻完剩余") && !has(popupHtml, "继续翻译剩余"),
  "popup 的按钮升级成「一键翻完剩余 n 段」（旧的『继续翻译剩余』字样已不存在）");
ck(has(popupJs, 'type: "translateAll"') && has(popupJs, 'type: "translateStop"') && has(popupJs, "⏹ 停止"),
  "popup：点一次发 translateAll（自动翻完）；翻的过程中按钮变「⏹ 停止」→ 发 translateStop");
ck(has(js, 'msg?.type === "translateAll"') && has(js, 'msg?.type === "translateStop"') && has(js, "function runAutoDrain("),
  "content.js 认识 translateAll / translateStop，自动翻的循环本体独立成 runAutoDrain()");
ck(has(js, "const AUTO_FAIL_BATCHES = 2;") && has(js, "if (stopped || failStreak >= AUTO_FAIL_BATCHES || !remaining) break;"),
  "出错策略：连着 2 批一段都没翻成 → 收手（不死循环）");
ck(has(js, "const res = await translatePage(0);") && has(js, "if (state.autoStop) break;"),
  "单批仍走 translatePage（分批/25s 超时/重试 1 次/每块落盘都没动），自动翻只是循环调它 + 每块开头看一眼停止标记");
const money = ["省 token", "更快更省", "防费用失控", "不重复花钱", "省掉重复请求"].filter((w) => has(js, w) || has(bg, w) || has(readme, w));
ck(money.length === 0, "content.js / background.js / README 里不再有『为省钱』那套措辞", money.length ? JSON.stringify(money) : "那 5 个词都不见了");
ck(has(bg, "防等待过久") && has(bg, "分批翻完（防一次翻太多、等太久）"), "background 的注释改成『防等待过久 / 防一次翻太多』");
ck(has(readme, "一键翻完剩余") && has(readme, "防等待过久") && !has(readme, "继续翻译剩余"),
  "README 跟上：一键翻完剩余（可停）+ 护栏理由改成防等待过久");
log("");
log("汇总：通过 " + pass + " 项，失败 " + fail + " 项" + (fail ? " ❌" : " ✅"));
process.exit(fail ? 1 : 0);
