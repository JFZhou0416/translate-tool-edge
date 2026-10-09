# -*- coding: utf-8 -*-
"""
屏幕翻译（Edge 扩展）API 冒烟测试 —— 不依赖浏览器，直接验扩展真正用的那套调用规格。

用法（key 走环境变量，不要写进文件）：
    set DEEPSEEK_KEY=sk-xxx
    python tools/api_smoke_test.py
    python tools/api_smoke_test.py --glossary="vault=仓库;lighthouse=灯塔"
    python tools/api_smoke_test.py --endpoint=https://api.deepseek.com/chat/completions --model=deepseek-v4-flash

验证点（逐条对应 src/background.js 里的 buildPrompt / translateChunk）：
  1. 端点 + 模型能连通（默认值就是扩展的默认值）
  2. thinking:{type:"disabled"} 被接受（不报 400）—— 扩展靠它省一半 token
  3. 输出严格是 [[n]] 编号协议、几段进几段出（扩展是按这个回填段落的）
  4. 术语表生效：表里的词必须按表翻
  5. 耗时：扩展侧单块超时是 25s（< MV3 service worker 的 30s 回收窗口），所以这里 >25s 直接 NG

说明：本脚本由安卓版 tools/api_smoke_test.py 改编而来：那边测的是"识图 →【原文】/【译文】"，
这边扩展走的是"文本 → [[n]] 编号协议"，所以提示词与断言都换成了扩展的这一套（协议本身没改）。
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-v4-flash"
CHUNK_TIMEOUT_S = 25.0          # 与 src/background.js 的 REQUEST_TIMEOUT_MS 对齐

# 三条样例段落：故意放上测试页用的那俩陷阱词（vault / lighthouse）
SAMPLE_ITEMS = [
    (1, "Every evening, the keeper climbed the spiral staircase with a lantern in his hand."),
    (2, "The vault beneath the tower was cold and dry, and nobody remembered who had built the lighthouse."),
    (3, "She asked whether the vault was still locked, and the keeper realised he had forgotten his own name."),
]


def build_prompt(numbers, glossary_text, src_hint=""):
    """与 src/background.js 的 buildPrompt 保持一致（改那边记得同步改这边）。"""
    entries = [l.strip() for l in re.split(r"\r?\n", glossary_text or "")
               if l.strip() and not l.strip().startswith("#") and re.search(r"[=＝]", l)]
    suffix = ""
    if entries:
        # 与 background.js 的 glossarySuffix 一致：全角 ＝ 也认，按 = 切开后两端去空格再拼回
        table = "\n".join(
            "=".join(p.strip() for p in l.replace("＝", "=").split("=")) for l in entries
        )
        suffix = ("\n\n术语表（必须遵守）：\n" + table +
                  "\n表格里出现过的，必须按表格翻译；表格里没有的人名/专有名词，全篇译法必须一致。")
    return (
        "你是网页翻译助手。下面用 [[n]] 标记了若干段待翻译文本。\n"
        "逐段翻译成中文，输出格式必须严格为：\n[[1]] 译文一\n[[2]] 译文二\n"
        "要求：术语准确、简洁，不要任何解释，不要合并或拆分段落。"
        + (f"\n（源语言可能是{src_hint}）" if src_hint else "")
        + suffix
        + "\n\n待翻译：\n" + numbers
    )


def parse_numbered(text):
    """与 src/background.js 的回填正则一致。"""
    out = {}
    for m in re.finditer(r"\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n?\s*\[\[\d+\]\]|$)", text):
        out[int(m.group(1))] = m.group(2).strip()
    return out


def main() -> int:
    key = os.environ.get("DEEPSEEK_KEY", "").strip()
    if not key:
        print("缺少环境变量 DEEPSEEK_KEY（例：set DEEPSEEK_KEY=sk-xxx）")
        return 2

    endpoint, model, glossary = ENDPOINT, MODEL, ""
    for a in sys.argv[1:]:
        if a.startswith("--endpoint="):
            endpoint = a.split("=", 1)[1]
        elif a.startswith("--model="):
            model = a.split("=", 1)[1]
        elif a.startswith("--glossary="):
            glossary = a.split("=", 1)[1].replace(";", "\n")

    numbers = "\n".join(f"[[{i}]] {t}" for i, t in SAMPLE_ITEMS)
    prompt = build_prompt(numbers, glossary, "英文")
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "thinking": {"type": "disabled"},
        "max_tokens": 8000,
        "stream": False,
    }
    print(f"端点: {endpoint}\n模型: {model}\n术语表: {glossary or '(空)'}\n段落数: {len(SAMPLE_ITEMS)}")

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"[失败] HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}")
        return 1
    except Exception as e:                                  # noqa: BLE001
        print(f"[失败] {type(e).__name__}: {e}")
        return 1
    dt = time.time() - t0

    content = resp["choices"][0]["message"]["content"]
    usage = resp.get("usage", {}) or {}
    out = parse_numbered(content)

    print(f"\n耗时: {dt:.2f}s")
    print(f"tokens: 入 {usage.get('prompt_tokens')} / 出 {usage.get('completion_tokens')}")
    print(f"实际模型: {resp.get('model')}")
    print("-" * 60)
    for i, _ in SAMPLE_ITEMS:
        print(f"[[{i}]] {out.get(i, '(没返回这段)')}")
    print("-" * 60)

    checks = [
        ("thinking:{type:disabled} 被接受（没报 400）", True, ""),
        (f"端到端 ≤ {CHUNK_TIMEOUT_S:.0f}s（扩展侧单块超时）", dt <= CHUNK_TIMEOUT_S, f"{dt:.2f}s"),
        (f"[[n]] 编号协议：{len(SAMPLE_ITEMS)} 段进 / {len(out)} 段出", len(out) == len(SAMPLE_ITEMS), ""),
        ("没把多段合成一段（编号没串行）", all(len(out.get(i, "").split("[[", 1)) == 1 for i, _ in SAMPLE_ITEMS), ""),
    ]
    if glossary:
        table = [l for l in re.split(r"\r?\n", glossary) if "=" in l]
        for line in table:
            src, _, dst = line.partition("=")
            hit = any(dst.strip() and dst.strip() in out.get(i, "") for i, _ in SAMPLE_ITEMS)
            checks.append((f"术语表生效：{src.strip()} → {dst.strip()}", hit, ""))

    ok = True
    for name, passed, extra in checks:
        print(f"[{'OK ' if passed else 'NG '}] {name} {extra}")
        ok = ok and passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
