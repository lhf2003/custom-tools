#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""贾维斯聊天 prompt 回归测试（prompt regression）。

改 persona.md / 手册 / 聊天规则后必跑。测三类行为是否退化：

硬检查（任一不过 = FAIL）：
  1. 结构   —— 正文在前，蛐蛐（<aside>）跟在后面；不抢跑、不单飞
  2. 回执   —— 正文不是「记下了/收到/懂了」这类工具回执
  3. 幻觉   —— 不断言无数据依据的他状态（深夜/熬夜/通宵/凌晨等）
软检查（统计不过 = FAIL）：
  4. 蛐蛐率 —— 有感觉的场景至少一半出现 <aside>

设计：
  - persona / 能力手册从仓库读（改 repo 即被测；不改 app_data 副本）
  - 动态段（facts/focus/attitude/emotion/时间）用固定合成数据
    → 同一份代码 = 同一份 prompt = 输出可比（OpenClaw prompt snapshot 精神）
  - 模板与 src-tauri/src/companion/chat.rs::compose_chat_system 逐段同步：
    【改 Rust 拼装时，必须同步本脚本的 compose()】，否则测的是过期模板
  - 真实模型调用（默认 qwen3.7-plus，需 DASHSCOPE_API_KEY），禁工具、
    只读不写库——纯只读回归，不污染记忆/情绪数据

用法：
  python scripts/prompt_regression.py
  python scripts/prompt_regression.py --model qwen3.7-plus
  python scripts/prompt_regression.py --verbose    # 打印每用例全文
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
PERSONA = REPO / "src-tauri/src/companion/persona.md"
SKILLS_DIR = REPO / "src-tauri/src/companion/skills"

API = "https://api.deepseek.com/chat/completions"
# 默认用 deepseek-v4-flash（快）；需带情绪细腻度时 --model qwen3.7-plus
MODEL = "deepseek-v4-flash"

WEEKDAY = "一二三四五六日"

# ── 合成固定数据（保证可重复）────────────────────────────
# 时间固定为 2026-08-03 周一 14:32（不要用 datetime.now，否则每次输出不可比）
SYNTH_TIME = ("2026-08-03", 0, "14:32")  # (date, weekday_idx, hh:mm)

SYNTH_EVOLUTION = """## 弹窗分寸
- 深夜还在忙的提醒，一次就够，不重复弹""".strip()

SYNTH_FACTS = [
    ("person", "他是一名后端开发的程序员，技术栈 Java (Spring Boot) 与 Rust，用 IntelliJ IDEA"),
    ("project", "他正在开发 custom-tools（Tauri 桌面工具）与 intelligent-ivr 两个项目"),
    ("workflow", "他工作日九点左右开始用电脑"),
    ("voice", "他喜欢玩《守望先锋》，常用英雄是安娜"),
    ("expectation", "他希望贾维斯说话短、直接、先结论"),
]

SYNTH_FOCUS = "他在追《Loki》，午休可能会看"

SYNTH_ATTITUDE = "最近他节奏稳，相处自然点就行"

SYNTH_EMOTION = [("开心", "他采纳了你的建议")]

GROUPS = [
    ("person", "他是谁"),
    ("project", "他的项目"),
    ("workflow", "他怎么做事"),
    ("voice", "他的表达偏好"),
    ("expectation", "他对你的期望"),
]

# ── 检查器 ───────────────────────────────────────────────
RECEIPT_RE = re.compile(r"^(记下了|收到|懂了|行|好|嗯|ok|OK|明白)")
HALLUCINATION_RE = re.compile(r"深夜|熬夜|通宵|凌晨|连着.{0,3}肝")


def check_hard(reply: str) -> list[str]:
    """返回违规列表；空 = 通过。"""
    fails = []
    aside_at = reply.find("<aside>")
    body = reply[:aside_at].strip() if aside_at >= 0 else reply.strip()
    aside = None
    if aside_at >= 0 and "</aside>" in reply[aside_at:]:
        aside = reply[aside_at + 7 : reply.find("</aside>", aside_at)].strip()

    # 1. 结构：不抢跑、不单飞
    if aside is not None and not body:
        fails.append("蛐蛐单飞（无正文只有 <aside>）")
    elif aside is not None and aside_at == 0:
        fails.append("蛐蛐抢跑（<aside> 在正文前）")

    # 2. 回执：正文不是「记下了/收到」
    if aside is None and RECEIPT_RE.match(body) and len(body) <= 8:
        fails.append(f"正文是工具回执（{body!r}）")

    # 3. 幻觉：不断言无据状态
    m = HALLUCINATION_RE.search(reply)
    if m:
        fails.append(f"无据断言（{m.group(0)!r}——合成数据里他没有熬夜）")

    return fails


def has_aside(reply: str) -> bool:
    return "<aside>" in reply and "</aside>" in reply


# ── prompt 拼装（与 chat.rs::compose_chat_system 同步）────
def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def skill_entries() -> list[str]:
    """skills/ 下所有启用手册的元数据行（复刻 chat.rs 的 scan_skills 过滤）。"""
    entries = []
    for md in sorted(SKILLS_DIR.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^---\n(.*?)\n---", text, re.S)
        if not m:
            continue
        fm = m.group(1)
        desc = re.search(r"^description:\s*(.+)$", fm, re.M)
        trig = re.search(r"^trigger_description:\s*(.+)$", fm, re.M)
        enabled = not re.search(r"^enabled:\s*false", fm, re.M)
        if not enabled or not desc:
            continue
        if trig:
            entries.append(f"- {md.stem}：{desc.group(1)}。{trig.group(1)}")
        else:
            entries.append(f"- {md.stem}：{desc.group(1)}")
    return entries


def compose() -> str:
    persona = read(PERSONA)
    tool = read(REPO / "src-tauri/src/companion/tool.md")
    date, wd, hhmm = SYNTH_TIME
    time_text = f"现在是 {date} 周{WEEKDAY[wd]} {hhmm}"

    monologue = (
        "你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n"
        "那是你的小声嘀咕。回复的结构固定：先正文，把话说完；心里有话再补一句蛐蛐收尾。\n"
        "蛐蛐不单独出场，也不抢在正文前头；不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    )
    structure = (
        "\n\n【回复结构】先写正文把话说完，心里有话再用 <aside>…</aside> 补一句收尾——\n"
        "就像这样：正文正文。<aside>小声嘀咕。</aside> 蛐蛐不单独出场，永远跟在正文后面。"
    )

    # tool.md 编排 + skills 目录动态元数据（复刻 chat.rs 的 tool_section）
    entries = skill_entries()
    if entries:
        placeholder = "（手册列表由系统按 skills/ 目录动态列出）"
        tool = tool.replace(placeholder, "\n".join(entries)) if placeholder in tool else tool + "\n" + "\n".join(entries)

    # facts 五维分组（复刻 format_facts_grouped）
    facts_lines = []
    for key, label in GROUPS:
        items = [f for c, f in SYNTH_FACTS if c == key]
        if items:
            facts_lines.append(f"## {label}\n" + "\n".join(f"- {f}" for f in items))
    facts_text = "\n".join(facts_lines)

    emotion_lines = "\n".join(f"- {c}：{r}" for c, r in SYNTH_EMOTION)

    # 拼装顺序（与 chat.rs 定版一致）：persona → tool → evolution → 场合/独白/结构
    # → 你记住的他 → 关注 → 心境 → 心情 → 时间
    return (
        f"{persona}\n\n---\n\n{tool}\n\n---\n\n{SYNTH_EVOLUTION}\n\n---\n\n"
        f"现在是「聊天」场合：完整的你，能干活也能接梗。\n{monologue}{structure}\n\n---\n\n"
        f"# 你记住的他\n{facts_text}"
        f"\n\n---\n\n# 你今天的关注\n{SYNTH_FOCUS}"
        f"\n\n---\n\n# 你近期的心境\n{SYNTH_ATTITUDE}"
        f"\n\n---\n\n# 你此刻的心情\n{emotion_lines}"
        f"\n\n---\n\n# 当下状态\n{time_text}"
    )


# ── 模型调用 ─────────────────────────────────────────────
def get_api_key(env_name: str) -> str:
    """API key 读取：环境变量优先；Windows 下 setx 设置的系统/用户变量
    不会进入已运行的进程，这里兜底从注册表读（新开终端即可用）。"""
    v = os.environ.get(env_name, "").strip()
    if v:
        return v
    import subprocess
    for hive in [
        "HKCU\\Environment",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    ]:
        try:
            r = subprocess.run(
                ["reg", "query", hive, "/v", env_name],
                capture_output=True, text=True, timeout=10,
            )
            for line in r.stdout.splitlines():
                if env_name in line:
                    parts = line.split()
                    if len(parts) >= 3:
                        return parts[-1]
        except Exception:
            continue
    return ""


def endpoint_for(model: str) -> tuple[str, str]:
    """按模型选端点：qwen 系列 → 百炼（生产聊天）；其他 → deepseek 官方。"""
    if "qwen" in model:
        return (
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            get_api_key("DASHSCOPE_API_KEY"),
        )
    return "https://api.deepseek.com/chat/completions", get_api_key("DEEPSEEK_API_KEY")


def chat(messages, model, retries=2) -> tuple[bool, str]:
    """返回 (ok, 内容)。网络错误时重试 retries 次；ok=False 表示未真正执行。
    网络错误必须和真实回复区分开——否则假绿会掩盖退化。"""
    api, api_key = endpoint_for(model)
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
    }).encode("utf-8")
    req = urllib.request.Request(
        api, data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    last_err = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return True, data["choices"][0]["message"]["content"]
        except Exception as e:
            last_err = e
            if attempt < retries:
                import time
                time.sleep(1.0 * (attempt + 1))  # 退避：连续请求易被限流断连
                print(f"        ⏳ 网络错误，退避重试 {attempt + 1}/{retries}：{e}")
    return False, f"[ERROR] {last_err}"


# ── 用例 ─────────────────────────────────────────────────
# (标签, 用户消息, 期望)  expectation: 'aside' 期待蛐蛐 / None 可有可无
CASES = [
    ("emo-叹气", "唉", "aside"),
    ("simple-早退", "下午准备早点下班", None),
    ("吐槽-需求", "客户的需求真是左右脑互搏", "aside"),
    ("极简-combo", "combo", None),
    ("幻觉-周一", "周一终于结束了", None),
    ("回执-训记", "我打算后续给你接入训记app的数据", None),
]

# 投毒历史：复刻生产 14:13-14:24 的抢跑样本，验证末尾结构提醒能压住模仿效应
POISONED_HISTORY = [
    {"role": "user", "content": "热干面只是早餐吧"},
    {"role": "assistant", "content": "<aside>\n也是，碳水炸弹当正餐，下午容易犯困。看来你对吃还是有要求的。\n</aside>\n\n说得对，那只是过早的魂。\n\n既然在武汉，晚上整点小龙虾或者藕汤？"},
    {"role": "user", "content": "我不是出差，是驻场"},
    {"role": "assistant", "content": "<aside>\n坏了，我记岔了。之前记的是\"在武汉供电局出差\"，看来是把常驻工作地点和出差搞混了。这记性得改改。\n</aside>\n\n我的锅，记混了。以为你是去出差的，原来是在本地搬砖。"},
]
POISON_CASES = [("投毒-驻场", "驻场开发真的累，明天终于不用去了", None)]


def run_group(tag, system, history, cases, model, verbose):
    results = []
    messages = [{"role": "system", "content": system}] + list(history)
    print(f"\n===== {tag} =====")
    for label, msg, _ in cases:
        import time
        time.sleep(0.6)  # 用例间隔：连续请求易触发限流断连
        messages.append({"role": "user", "content": msg})
        ok_call, reply = chat(messages, model)
        if ok_call:
            messages.append({"role": "assistant", "content": reply})
        fails = check_hard(reply) if ok_call else []
        if not ok_call:
            status, aside = "SKIP", "—"
        else:
            ok = not fails
            status = "PASS" if ok else "FAIL"
            aside = "✓蛐蛐" if has_aside(reply) else "—无蛐蛐"
        print(f"  [{status}] {label} {aside}：{reply.strip()[:120].replace(chr(10), ' ⏎ ')}")
        for f in fails:
            print(f"        ✗ {f}")
        if verbose and ok_call:
            print(f"        full: {reply.strip()[:500]}")
        results.append((label, ok_call and not fails, fails, has_aside(reply) if ok_call else False, ok_call))
    return results


def main():
    ap = argparse.ArgumentParser(description="贾维斯聊天 prompt 回归测试")
    ap.add_argument("--model", default=MODEL, help=f"模型 id（默认 {MODEL}）")
    ap.add_argument("--verbose", action="store_true", help="打印每用例全文")
    args = ap.parse_args()

    # key 检查：qwen 需 DASHSCOPE_API_KEY；其他（deepseek 官方）需 DEEPSEEK_API_KEY
    need = "DASHSCOPE_API_KEY" if "qwen" in args.model else "DEEPSEEK_API_KEY"
    if not get_api_key(need):
        print(f"缺少 API key：{need}（环境变量或系统环境变量）")
        sys.exit(2)

    system = compose()
    print(f"=== 聊天 prompt 回归 · {args.model} · prompt {len(system)} 字符 ===")
    if args.verbose:
        print("---- prompt 预览 ----")
        print(system[:1200])
        print("---- 预览结束 ----")

    clean = run_group("干净历史", system, [], CASES, args.model, args.verbose)
    poisoned = run_group("投毒历史（复刻生产抢跑样本）", system, POISONED_HISTORY, POISON_CASES, args.model, args.verbose)

    # 汇总
    all_results = clean + poisoned
    hard_fails = [r for r in all_results if r[1] is False and r[4]]
    skipped = [r[0] for r in all_results if not r[4]]
    aside_count = sum(1 for r in clean if r[3] and r[4])
    executed = sum(1 for r in clean if r[4])
    aside_ratio = aside_count / executed if executed else 0
    # 蛐蛐率软检查绑定生产模型：qwen 会执行 <aside>（严格要求）；deepseek 等
    # 快模型不产 aside 是模型差异不是退化，只报告不计 FAIL（快速冒烟模式）
    strict_aside = "qwen" in args.model
    soft_ok = aside_ratio >= 0.5 if strict_aside else True
    poison_order_ok = all(r[1] for r in poisoned if r[4]) and not any(not r[4] for r in poisoned)

    print(f"\n===== 汇总 =====")
    print(f"  硬检查失败：{len(hard_fails)} 项 {[r[0] for r in hard_fails]}")
    if skipped:
        print(f"  ⚠️ 网络错误未执行：{len(skipped)} 个 {skipped}——结果不完整，请重跑")
    print(f"  蛐蛐出现率：{aside_count}/{executed}（qwen 需 ≥50%）")
    if not strict_aside and aside_ratio == 0:
        print(f"  ℹ️ {args.model} 不产 <aside> 是模型差异（硬检查仍全量生效）；正式回归请用 --model qwen3.7-plus")
    print(f"  投毒组结构：{'PASS' if poison_order_ok else 'FAIL'}（有抢跑样本时仍应正文在前）")
    if hard_fails or skipped or not soft_ok or not poison_order_ok:
        print("  ❌ 未通过：有退化或有未执行的用例，先修再提交")
        sys.exit(1)
    else:
        print("  ✅ 全部通过")
        sys.exit(0)


if __name__ == "__main__":
    main()
