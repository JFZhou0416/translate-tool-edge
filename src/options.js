/** 屏幕翻译 · 设置页 */
const DEFAULTS = {
  apiKey: "",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  visionModel: "deepseek-v4-flash",   // 第 4 轮：区域翻译走截图路时的识图模型
  chunkChars: 2000,
  maxBlocksPerPage: 300,
  glossary: "",
  // T2 译文外观
  colorMode: "auto",
  stFg: "#4a5878",
  stBorder: "#7aa2f7",
  stBg: "#ffffff",
  stBgOn: false,
};

const $ = (id) => document.getElementById(id);
const msg = (t, cls) => { const m = $("msg"); m.textContent = t; m.className = cls || ""; };

// T2：自动/浅色/深色三档用的就是 content.js 里那两套预设色（预览与实现同源）
const PRESET = {
  light: { fg: "#4a5878", border: "#7aa2f7", bg: "transparent" },
  dark: { fg: "#b9c6e6", border: "#4f7bd9", bg: "transparent" },
};

function currentTheme() {
  const mode = $("colorMode").value;
  if (mode === "custom") {
    return {
      fg: $("stFg").value,
      border: $("stBorder").value,
      bg: $("stBgOn").checked ? $("stBg").value : "transparent",
    };
  }
  return { ...(PRESET[mode] || PRESET.light) };
}

function refreshUI() {
  $("customRow").style.display = $("colorMode").value === "custom" ? "" : "none";
  const t = currentTheme();
  const p = $("preview");
  p.style.color = t.fg;
  p.style.borderLeftColor = t.border;
  p.style.background = t.bg;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  const v = { ...DEFAULTS, ...s };
  $("apiKey").value = v.apiKey;
  $("endpoint").value = v.endpoint;
  $("model").value = v.model;
  $("visionModel").value = v.visionModel;
  $("chunkChars").value = v.chunkChars;
  $("maxBlocksPerPage").value = v.maxBlocksPerPage;
  $("glossary").value = v.glossary;
  $("colorMode").value = v.colorMode;
  $("stFg").value = v.stFg;
  $("stBorder").value = v.stBorder;
  $("stBg").value = v.stBg;
  $("stBgOn").checked = !!v.stBgOn;
  refreshUI();
}

async function save() {
  const v = {
    apiKey: $("apiKey").value.trim(),
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    model: $("model").value.trim() || DEFAULTS.model,
    visionModel: $("visionModel").value.trim() || DEFAULTS.visionModel,
    chunkChars: Math.max(200, Math.min(8000, Number($("chunkChars").value) || 2000)),
    maxBlocksPerPage: Math.max(5, Math.min(2000, Number($("maxBlocksPerPage").value) || 300)),
    glossary: $("glossary").value,
    colorMode: $("colorMode").value,
    stFg: $("stFg").value,
    stBorder: $("stBorder").value,
    stBg: $("stBg").value,
    stBgOn: $("stBgOn").checked,
  };
  await chrome.storage.local.set(v);
  msg("已保存 ✅", "ok");
  setTimeout(() => msg(""), 2500);
}

$("save").onclick = save;

$("reset").onclick = async () => {
  await chrome.storage.local.set(DEFAULTS);
  await load();
  msg("已恢复默认", "ok");
  setTimeout(() => msg(""), 2500);
};

$("test").onclick = async () => {
  msg("自检中…");
  try {
    await save();
    const p = await chrome.runtime.sendMessage({ type: "ping" });
    if (!p?.ok) { msg("通道不通：" + (p?.error || "?"), "err"); return; }
    const t = await chrome.runtime.sendMessage({ type: "selftest" });
    if (t?.ok) msg(`✅ 通了　模型 ${p.model}　译文：${t.out[1] || "(空)"}`, "ok");
    else msg("API 失败：" + (t?.error || "?"), "err");
  } catch (e) { msg("异常：" + e.message, "err"); }
};

// 外观一改就刷新预览（保存仍要点「保存」）
$("colorMode").onchange = refreshUI;
$("stBgOn").onchange = refreshUI;
["stFg", "stBorder", "stBg"].forEach((id) => ($(id).oninput = refreshUI));

load();
