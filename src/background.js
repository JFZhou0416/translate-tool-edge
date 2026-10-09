/**
 * 屏幕翻译 · background（MV3 service worker）
 *
 * ⚠️ 为什么所有 API 调用都在这儿（计划书 §3.2，整个插件的成败点）：
 *    content script 里发 fetch，请求会带上"当前页面"的 origin → 受页面 CORS 约束 → 大概率被拦。
 *    service worker 属于扩展自身身份，配合 manifest 里的 host_permissions 就能跨域 ✅
 *    → content 只负责 DOM，文本通过 runtime.sendMessage 交给这里翻译，结果再回传。
 *
 * 设计要点（照抄计划书 §3.3）：
 *   · 编号协议：[[1]] [[2]]…，一块一次请求（不是逐段），一页通常 1~3 次调用
 *   · 关思考（thinking disabled）+ temperature 0.1 → 防等待过久：耗时减半（安卓版实测 3.9s→1.7s）
 *   · 术语表：一行一条 `原文=译名`（全角 ＝ 也认）；非空时追加"人名一致性"约束
 */

const DEFAULT_SETTINGS = {
  apiKey: "",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  visionModel: "deepseek-v4-flash", // 第 4 轮 T2：区域翻译走截图路时用的识图模型（规格见任务单 T2.2）
  chunkChars: 2000,      // 每块最大字符数
  maxChunkChars: 200,    // 单段超过这个长度 → 单独成块
  maxBlocksPerPage: 300, // T3：一次点「翻译」最多翻多少段；超出的不硬砍，分批翻完（防一次翻太多、等太久）
  glossary: "",          // 术语表原文
  // ---- T2 译文外观（颜色由 content script 注入 CSS 变量，这里只存配置）----
  colorMode: "auto",     // auto（按页面实际背景亮度）/ light / dark / custom
  stFg: "#4a5878",       // 自定义：译文文字色
  stBorder: "#7aa2f7",   // 自定义：译文左侧竖线色
  stBg: "#ffffff",       // 自定义：译文底色
  stBgOn: false,         // 是否启用底色（默认关 → 透明）
};

const REQUEST_TIMEOUT_MS = 25000;   // T3：单次翻译请求的超时（必须 < service worker 的 30s 回收窗口）

// ---------------------------------------------------------------- 第 4 轮 T2：区域翻译的识图规格
// ⚠️ 这一段是**照抄**任务单 T2.2（安卓端实测过的形态），别自创：
//   · 端点就用这个（带 /v1）；模型名做成设置项 visionModel（默认 deepseek-v4-flash）
//   · thinking 必须写成 { type: "disabled" }（写成 thinking.enabled = false 会 400）
//   · messages[0].content 里 image_url 在前、text 在后（安卓端实测顺序）
//   · max_tokens 1500、temperature 0.1（超时沿用现有的 25s）
const VISION_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_VISION_MODEL = "deepseek-v4-flash";
const VISION_MAX_TOKENS = 1500;
const VISION_TEMPERATURE = 0.1;

// ------------------------------------------------------------------ 存储可见性（T3）

// content script 属于"非受信任上下文"，默认读不到 chrome.storage.session；
// 而断点续翻的进度就存在 session 里，所以这里显式放宽。
// 老版本 Edge 没有 setAccessLevel 就跳过 —— content 那边会自动兜底到 storage.local。
(async () => {
  try { await chrome.storage?.session?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }); }
  catch { /* 忽略 */ }
})();

// ------------------------------------------------------------------ 设置

async function getSettings() {
  const got = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...got };
}

// ------------------------------------------------------------------ 错误人话化（照搬安卓版 mapHttpError 的思路）

function humanError(status, body) {
  if (status === 401 || status === 403) return "API Key 无效或没有权限 —— 去设置页检查（重新填一次）";
  if (status === 402) return "账户余额不足";
  if (status === 429) return "请求太频繁（限流），等一下再试";
  if (status >= 500) return `服务端错误（${status}），稍后重试`;
  return `请求失败（${status}）${body ? "：" + String(body).slice(0, 200) : ""}`;
}

// ------------------------------------------------------------------ 术语表 → prompt 尾巴

function glossarySuffix(glossaryText) {
  const entries = String(glossaryText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /[=＝]/.test(l));
  if (!entries.length) return "";   // ⚠️ 留空时**不加任何额外约束**（与安卓版规格一致）
  const table = entries
    .map((l) => l.replace(/[＝]/g, "=").split("=").map((s) => s.trim()).join("="))
    .join("\n");
  return (
    "\n\n术语表（必须遵守）：\n" + table +
    "\n表格里出现过的，必须按表格翻译；表格里没有的人名/专有名词，全篇译法必须一致。"
  );
}

function buildPrompt(chunk, glossaryText, srcLangHint) {
  return (
    "你是网页翻译助手。下面用 [[n]] 标记了若干段待翻译文本。\n" +
    "逐段翻译成中文，输出格式必须严格为：\n[[1]] 译文一\n[[2]] 译文二\n" +
    "要求：术语准确、简洁，不要任何解释，不要合并或拆分段落。" +
    (srcLangHint ? `\n（源语言可能是${srcLangHint}）` : "") +
    glossarySuffix(glossaryText) +
    "\n\n待翻译：\n" + chunk
  );
}

// ------------------------------------------------------------------ 翻译一块

async function translateChunk(items, settings, srcLangHint) {
  if (!settings.apiKey) throw new Error("还没填 API Key —— 打开扩展的「设置」页填一个");
  const numbered = items.map((it) => `[[${it.id}]] ${it.text}`).join("\n");
  const payload = {
    model: settings.model,
    messages: [{ role: "user", content: buildPrompt(numbered, settings.glossary, srcLangHint) }],
    temperature: 0.1,
    // ⭐ 关思考（防等待过久）：安卓版实测耗时减半（3.9s → 1.7s）
    thinking: { type: "disabled" },
    max_tokens: 8000,
    stream: false,
  };

  const ctrl = new AbortController();
  // ⚠️ T3：25 秒必须 < MV3 service worker 的 30 秒空转回收窗口。
  //    原来的 120s 会拖到后台被回收 → 消息通道断掉 → 那一块整块丢（还不重试）。
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）—— 可能是网络慢或这一块太大`);
    throw new Error("网络请求失败：" + (e.message || e));
  }
  clearTimeout(timer);

  const raw = await resp.text();
  if (!resp.ok) throw new Error(humanError(resp.status, raw));

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("返回的不是合法 JSON"); }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("模型返回空内容");

  // 解析编号回填
  const out = {};
  const re = /\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n?\s*\[\[\d+\]\]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[Number(m[1])] = m[2].trim().replace(/^\n+|\n+$/g, "");
  }
  return out;
}

// ------------------------------------------------------------------ 第 4 轮 T2：识图翻译（区域翻译的截图路）

/** 识图翻译的 Prompt：输出格式仍用【原文】/【译文】（卡片解析依赖它）；
 *  ⚠️ 术语表必须注入 —— 安卓端已证明：不注入 vault 会漂成"库"，注入后稳定"仓库"（代价 +16 token）。 */
function buildVisionPrompt(glossaryText, srcLangHint) {
  return (
    "你是网页截图翻译助手。用户框选了网页上的一块区域，下面是这块区域的截图。\n" +
    "请识别截图里所有需要翻译的文字，逐条翻译成中文，输出格式必须严格为：\n" +
    "【原文】原文一\n【译文】译文一\n【原文】原文二\n【译文】译文二\n" +
    "要求：术语准确、简洁，不要任何解释。" +
    (srcLangHint ? `\n（源语言可能是${srcLangHint}）` : "") +
    glossarySuffix(glossaryText)
  );
}

/**
 * 识图翻译一块截图。payload 的字段与顺序**照抄任务单 T2.2**（安卓端实测过）：
 *   model / thinking:{type:"disabled"} / max_tokens:1500 / temperature:0.1 / messages[image_url, text]
 * ⚠️ 这里同样只在本文件发 fetch（content script 会被页面 CORS 拦）。
 */
async function translateImage(base64, settings, srcLangHint) {
  if (!settings.apiKey) throw new Error("还没填 API Key —— 打开扩展的「设置」页填一个");
  const model = settings.visionModel || DEFAULT_VISION_MODEL;
  const payload = {
    model: model,
    thinking: { type: "disabled" },
    max_tokens: VISION_MAX_TOKENS,
    temperature: VISION_TEMPERATURE,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64 } },
        { type: "text", text: buildVisionPrompt(settings.glossary, srcLangHint) },
      ],
    }],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(VISION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`识图超时（${REQUEST_TIMEOUT_MS / 1000} 秒）—— 可能是网络慢或这块截图太大`);
    throw new Error("网络请求失败：" + (e.message || e));
  }
  clearTimeout(timer);

  const raw = await resp.text();
  if (!resp.ok) throw new Error(humanError(resp.status, raw));

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("返回的不是合法 JSON"); }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("模型返回空内容");
  return { text, model };
}

// ------------------------------------------------------------------ 消息路由

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "translate") {
        const settings = await getSettings();
        const out = await translateChunk(msg.items, settings, msg.srcLangHint || "");
        sendResponse({ ok: true, out });
        return;
      }
      if (msg?.type === "ping") {   // ← E0 验收用：只要这条通，说明 background 跨域链路是活的
        const settings = await getSettings();
        sendResponse({ ok: true, hasKey: !!settings.apiKey, model: settings.model });
        return;
      }
      if (msg?.type === "selftest") {  // ← E0 验收：真打一次 API（翻一句固定的话）
        const settings = await getSettings();
        const out = await translateChunk([{ id: 1, text: "Hello, world. This is a smoke test." }], settings, "英文");
        sendResponse({ ok: true, out });
        return;
      }
      if (msg?.type === "capture") {   // ← 第 4 轮 T2：截图只能由扩展侧调（content script 拿不到 chrome.tabs）
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({ ok: false, error: "截图没成功（" + String((e && e.message) || e) + "）" });
        }
        return;
      }
      if (msg?.type === "vision") {   // ← 第 4 轮 T2：识图翻译（术语表在 getSettings 里拿）
        const settings = await getSettings();
        const out = await translateImage(msg.image, settings, msg.srcLangHint || "");
        sendResponse({ ok: true, text: out.text, model: out.model });
        return;
      }
      if (msg?.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }
      sendResponse({ ok: false, error: "未知消息类型：" + (msg?.type || "") });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;   // 异步 sendResponse
});

// ------------------------------------------------------------------ 快捷键

chrome.commands?.onCommand?.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (cmd === "region-translate") {   // 第 4 轮补：Alt+Shift+R → 区域翻译（和 popup 发的是同一条消息）
    try { await chrome.tabs.sendMessage(tab.id, { type: "regionMode", on: true }); } catch { /* 页面没注入就算了 */ }
    return;
  }
  const type = cmd === "restore-page" ? "restore" : "translate";
  try { await chrome.tabs.sendMessage(tab.id, { type }); } catch { /* 页面没注入就算了 */ }
});
