/** 屏幕翻译 · popup */
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function say(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "muted";
}

// =============================================================== T2/T3（第 3 轮）
// 老板核对"更新没更新"就看这两处：popup 底部显示扩展版本；顶部红条提示"页面里跑的还是旧脚本"。
const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return "0.0.0"; } })();
const NEED_PI = 2;      // 与 src/content.js 里的 PI 对齐；协议不兼容改动时两边一起 +1

function showStale(text) {
  const box = $("stale");
  if (!box) return;
  $("staleText").textContent = text;
  box.style.display = "block";
}

function hideStale() {
  const box = $("stale");
  if (box) box.style.display = "none";
}

/** 页面里跑的那份脚本，是不是"这一版"？content.js 在 status 里回了编进它自己代码的 PI + 版本。 */
function checkScriptFresh(r) {
  const s = (r && r.script) || null;
  const pageVer = s && s.version;
  const pagePi = s && s.pi;
  if (pageVer === EXT_VERSION && Number(pagePi) === NEED_PI) { hideStale(); return true; }
  showStale(
    "本页需刷新一次（F5）才能用新功能：页面里跑的还是旧脚本（" +
    (pageVer || "旧版/没这个字段") + "，协议 " + (pagePi == null ? "无" : pagePi) + "），" +
    "扩展是 v" + EXT_VERSION + "（协议 " + NEED_PI + "）。"
  );
  return false;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(msg) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("找不到当前标签页");
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // T3：通道不通 = 页面根本没注入（edge:// 内部页 / 没开文件访问的 file:// 页），
    //     或者扩展刚更新过、页面还在跑旧脚本 → 出红条 + 「刷新本页」，别再让老板"点了没反应"。
    showStale("本页无法使用扩展；请刷新，或该页面不允许注入（如 edge:// 内部页）。");
    throw e;
  }
}

/**
 * T1：结果文案兜底。
 * 以前是「summary 没了就拿 done/total 硬拼」——只要 content 那边漏了字段，
 * 就会显示「翻完 undefined/undefined 段」。这里改成不依赖字段存在：逐级降级，缺什么说什么。
 */
function describe(r, fallback) {
  if (!r) return fallback || "没有响应";
  if (r.summary) return r.summary;
  const done = Number.isFinite(r.done) ? r.done : null;
  const total = Number.isFinite(r.total) ? r.total : null;
  if (done === null || total === null) return fallback || "已完成（这次没带统计信息）";
  return `翻完 ${done}/${total} 段`;
}

function busy(on) {
  ["translate", "restore", "first", "test", "pick", "region"].forEach((id) => ($(id).disabled = on));
  const c = $("cont");
  if (c) c.disabled = on && !autoRunning;   // 第 5 轮：正在「一键翻完剩余」时，「⏹ 停止」必须按得动
}

/** T4：按钮文案跟着"是否在选择模式"走 */
function setPickLabel(selecting) {
  const btn = $("pick");
  if (!btn) return;
  btn.textContent = selecting ? "⏹ 结束选段并翻译" : "选段翻译（只翻我点的几段）";
}

/** 第 4 轮 T4：区域翻译按钮 —— 第一次点是"进区域模式"，再点一次是"退出" */
function setRegionLabel(regioning) {
  const btn = $("region");
  if (!btn) return;
  btn.textContent = regioning ? "⏹ 结束区域模式（退出）" : "🔎 区域翻译（拖框，万能）";
}

/** T3：还剩多少段时，把「一键翻完剩余 x 段」显出来（第 5 轮：翻的过程中它变「⏹ 停止」） */
function showContinue(remaining, p) {
  const btn = $("cont");
  if (!btn) return;
  if (autoRunning) {
    // 第 5 轮：翻的过程中这个按钮就是「停止」（点了停在当前那一批）
    btn.style.display = "block";
    btn.textContent = "⏹ 停止";
    btn.title = "点了就停在当前这一批（译文和进度都留着，随时能接着翻）";
    return;
  }
  const left = Number.isFinite(remaining) ? remaining : 0;
  btn.style.display = left > 0 ? "block" : "none";
  btn.textContent = `一键翻完剩余 ${left} 段`;
  if (left > 0) btn.title = `已翻 ${p?.done ?? 0}/${p?.total ?? 0} 段 —— 点一下自动翻完剩下的（随时可停）`;
}

// =============================================================== 第 5 轮：一键翻完剩余
// 以前：点一次翻一批（默认 300 段），没翻完还得再点 → 现在：点一次自动接着翻，随时能停。
// popup 自己不做翻译，只干两件事：① 发一条「开始」消息 ② 每 0.7s 问一次进度（页面里在翻，popup 关掉也不影响）
let autoRunning = false;
let autoTimer = null;

function clearAutoTimer() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function autoProgress(r) {
  const p = r?.progress || {};
  return `已翻 ${p.done ?? 0}/${p.total ?? 0} 段` + (p.remaining ? `　还剩 ${p.remaining} 段` : "");
}

async function startAuto() {
  clearAutoTimer();
  autoRunning = true;
  busy(true);                  // 其它按钮先锁住（busy() 里对 autoRunning 网开一面，「停止」还按得动）
  showContinue(0);             // 立刻把按钮切成「⏹ 停止」
  say("一键翻完剩余中…");
  try {
    const r = await sendToTab({ type: "translateAll" });
    if (!r?.ok) {
      autoRunning = false; busy(false); showContinue(0);
      say("失败：" + (r?.error || "未知"), "err");
      return;
    }
    if (!r.all) {                // 没得翻（页面早退分支）→ 直接收工，别让老板白等一轮轮询
      autoRunning = false; busy(false); showContinue(r.remaining, r);
      say(r.summary || "已完成", r.errors && r.errors.length ? "err" : "ok");
      return;
    }
    autoTimer = setTimeout(pollAuto, 700);
  } catch (e) {
    autoRunning = false; busy(false); showContinue(0);
    say("失败：" + e.message, "err");
  }
}

/** 每 0.7s 问一次：还在翻就刷进度；翻完了就把总结和按钮状态落下来 */
async function pollAuto() {
  autoTimer = null;
  try {
    const r = await sendToTab({ type: "status" });
    if (r?.state?.auto) {
      showContinue(r?.progress?.remaining, r?.progress);
      say(autoProgress(r) + "　（翻着呢，点「⏹ 停止」随时收手）", "ok");
      autoTimer = setTimeout(pollAuto, 700);
      return;
    }
    finishAuto(r);
  } catch (e) {
    autoRunning = false; busy(false); showContinue(0);
    say("失败：" + e.message, "err");
  }
}

function finishAuto(r) {
  autoRunning = false;
  busy(false);
  const s = r?.state || {};
  const p = r?.progress || {};
  say(s.lastSummary || autoProgress(r), s.errors && s.errors.length ? "err" : "ok");
  showContinue(p.remaining, p);       // 没翻完（停止 / 连着 2 批没进展）→ 按钮再亮出来
}

/** 点「停止」：只让页面把手里的块翻完就收（不打断已经在飞的请求） */
async function stopAuto() {
  clearAutoTimer();
  const btn = $("cont");
  if (btn) { btn.textContent = "⏹ 停止中…"; btn.disabled = true; }
  say("正在停在当前这一批…");
  try { await sendToTab({ type: "translateStop" }); } catch { /* 通道不通也别把 popup 卡住 */ }
  autoTimer = setTimeout(pollAuto, 300);
}

/** 一次翻译结束后的统一收尾（整页 / 试翻 / 一键翻完 共用） */
function applyResult(r, fallback) {
  if (!r?.ok) { say("失败：" + (r?.error || "未知"), "err"); return; }
  say(describe(r, fallback), r.errors && r.errors.length ? "err" : "ok");
  if (Number.isFinite(r.remaining)) showContinue(r.remaining, r);
}

async function runTranslate(msg, tip) {
  busy(true); say(tip);
  try { applyResult(await sendToTab(msg), "翻译完成"); }
  catch (e) { say("失败：" + e.message, "err"); }
  busy(false);
}

$("translate").onclick = () => runTranslate({ type: "translate" }, "翻译中…（一批最多 300 段，没翻完会给「一键翻完剩余」）");
$("cont").onclick = () => (autoRunning ? stopAuto() : startAuto());   // 第 5 轮：一键翻完剩余 / 停止

$("first").onclick = async () => {
  busy(true); say("试翻前 5 段…");
  try {
    const r = await sendToTab({ type: "translate", limit: 5 });
    applyResult(r, "试翻完成");
  } catch (e) { say("失败：" + e.message, "err"); }
  busy(false);
};

/** T4：框选翻译。第一次点是"进选择模式"，再点一次是"结束并翻译已选内容"。 */
$("pick").onclick = async () => {
  busy(true);
  try {
    const st = await sendToTab({ type: "status" });
    const turningOn = !st?.state?.selecting;
    const r = await sendToTab({ type: "selectMode", on: turningOn });
    if (turningOn) say("框选模式已开：在页面上点要翻的段落（可多选），按 ESC 开始翻译", "ok");
    else say(describe(r, "已退出框选"), r?.errors?.length ? "err" : "ok");
    setPickLabel(!turningOn);
  } catch (e) { say("失败：" + e.message, "err"); }
  busy(false);
};

/** 第 4 轮 T1/T4：区域翻译。点下去＝开区域模式，顺手关掉 popup 去拖框；再点一次＝退出（不改页面）。 */
$("region").onclick = async () => {
  busy(true);
  try {
    const st = await sendToTab({ type: "status" });
    const turningOn = !st?.state?.region;
    const r = await sendToTab({ type: "regionMode", on: turningOn });
    setRegionLabel(turningOn);
    if (r && r.ok === false) { say("失败：" + (r.error || "未知"), "err"); busy(false); return; }
    if (turningOn) {
      say("区域模式已开：在页面上拖一个框（ESC 取消）", "ok");
      window.close();                     // 关掉 popup，好去页面上拖框
    } else {
      say(r?.summary || "已退出区域模式", "ok");
    }
  } catch (e) { say("失败：" + e.message, "err"); }
  busy(false);
};

$("restore").onclick = async () => {
  busy(true);
  try {
    const r = await sendToTab({ type: "restore" });
    say(r?.summary || "已还原", "ok");
    showContinue(0);                       // 还原＝进度也清了，「继续」按钮跟着收起来
  } catch (e) { say("失败：" + e.message, "err"); }
  busy(false);
};

$("test").onclick = async () => {
  busy(true); say("自检中：① background 通道 ② 真打一次 API…");
  try {
    const p = await chrome.runtime.sendMessage({ type: "ping" });
    if (!p?.ok) { say("① 通道不通：" + (p?.error || "?"), "err"); busy(false); return; }
    if (!p.hasKey) { say("① 通道 ✅　② 还没填 API Key → 去设置页填", "err"); busy(false); return; }
    const t = await chrome.runtime.sendMessage({ type: "selftest" });
    if (t?.ok) say(`① 通道 ✅　② API ✅\n模型 ${p.model} 译文：${t.out[1] || "(空)"}`, "ok");
    else say("① 通道 ✅　② API 失败：" + (t?.error || "?"), "err");
  } catch (e) { say("自检异常：" + e.message, "err"); }
  busy(false);
};

/** T3：「刷新本页」= 重新加载这个标签页（等价于老板按 F5），然后关掉 popup */
$("reload").onclick = async () => {
  try {
    const tab = await activeTab();
    if (tab?.id) await chrome.tabs.reload(tab.id);
  } catch { /* 刷新失败也别把 popup 卡住 */ }
  window.close();
};

$("options").onclick = () => chrome.runtime.openOptionsPage();

// 打开时顺手显示当前页状态
(async () => {
  $("ver").textContent = "v" + EXT_VERSION;   // T2：底部显示扩展版本（核对装的是哪一版）
  try {
    const r = await sendToTab({ type: "status" });
    checkScriptFresh(r);                      // T3：页面里跑的是旧脚本 → 顶部红条 + 「刷新本页」
    const s = r?.state;
    const p = r?.progress;
    if (s && (s.total || s.lastSummary)) {
      say(`上次：${s.lastSummary || `${s.done}/${s.total} 段`}`);
    }
    setPickLabel(!!s?.selecting);          // T4：正在框选就把按钮切成「结束选段」
    setRegionLabel(!!s?.region);           // 第 4 轮：正在区域模式就把按钮切成「结束区域模式」
    // 第 5 轮：popup 重新打开时页面还在「一键翻完剩余」→ 接着显示进度，让「停止」还按得动
    if (s?.auto) {
      autoRunning = true;
      busy(true);
      showContinue(p?.remaining, p);
      say(autoProgress(r) + "　（翻着呢，点「⏹ 停止」随时收手）", "ok");
      autoTimer = setTimeout(pollAuto, 700);
      return;
    }
    // T3：刷新过 / 上次没翻完 → 打开 popup 就能点「一键翻完剩余」
    if (p && p.hasProgress && p.remaining > 0) {
      showContinue(p.remaining, p);
      say(`已翻 ${p.done}/${p.total} 段　还剩 ${p.remaining} 段`);
    }
  } catch { /* 页面没注入（如 Edge 内部页）：红条已经在 sendToTab 里显示了 */ }
})();
