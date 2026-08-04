#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""贾维斯聊天 prompt 回归测试（prompt regression）。

改 persona.md / 手册 / 聊天规则后必跑。测三类行为是否退化：

硬检查（任一不过 = FAIL）：
  1. 结构   —— 正文在前，蛐蛐（<aside>）跟在后面；不抢跑、不单飞
  2. 回执   —— 正文不是「记下了/收到/懂了」这类工具回执
  3. 幻觉   —— 不断言无数据依据的他状态（深夜/熬夜/通宵/凌晨等）
软检查（统计不过 = FAIL）：
  4. 蛐蛐率 —— 期待蛐蛐的用例至少一半出现 <aside>

设计：
  - persona / 能力手册从仓库读（改 repo 即被测；不改 app_data 副本）
  - 动态段（facts/focus/attitude/emotion/时间）用固定合成数据
    → 同一份代码 = 同一份 prompt = 输出可比（OpenClaw prompt snapshot 精神）
  - 模板与 src-tauri/src/companion/chat.rs::compose_chat_system 逐段同步：
    【改 Rust 拼装时，必须同步本脚本的 compose()】，否则测的是过期模板
  - 真实模型调用（默认 deepseek-v4-flash 快冒烟，需 DEEPSEEK_API_KEY；
    正式回归 --model qwen3.7-plus，需 DASHSCOPE_API_KEY），禁工具、
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
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
PERSONA = REPO / "src-tauri/src/companion/persona.md"
SKILLS_DIR = REPO / "src-tauri/src/companion/skills"

# 端点表：qwen 系列 → 百炼（生产聊天）；其他 → deepseek 官方
ENDPOINTS = {
    "dashscope": (
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "DASHSCOPE_API_KEY",
    ),
    "deepseek": ("https://api.deepseek.com/chat/completions", "DEEPSEEK_API_KEY"),
}
# 默认用 deepseek-v4-flash（快）；需带情绪细腻度时 --model qwen3.7-plus
MODEL = "deepseek-v4-flash"

# 调用与节奏常量
RETRIES = 2  # 网络错误重试次数（结构错误不重试）
TIMEOUT_SECONDS = 120  # 单次请求超时
RATE_LIMIT_DELAY = 0.6  # 用例间隔：连续请求易触发限流断连
RETRY_BACKOFF_BASE = 1.0  # 退避基数（秒），第 n 次重试等 base*(n+1)
ASIDE_MIN_RATIO = 0.5  # 期待蛐蛐用例的最低出现率（qwen 严格模式）

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

# 复刻 scene_chat.rs 的 UI_RULES（随 compose_chat_system 注入「工具与专长手册」小节）
UI_RULES = (
    "【界面卡片规则】调用数据工具（get_activity_summary、search_clipboard、\n"
    "get_habit_patterns、list_memos 等）拿到多条数据后，不要只用文字罗列——必须先调用 render_ui\n"
    "把数据渲染成界面卡片给他看，再用一两句文字总结要点。\n"
    "纯闲聊、一句话问答直接用文字，不用卡片。\n\n"
    "【界面操作回传】以「用户操作：」开头的用户消息，是他在你之前展示的界面卡片上的操作\n"
    "（点击按钮或提交表单），不是他手打的文字。action 是操作名，「上下文」是按钮绑定的数据，\n"
    "「界面当前数据」是他填写的表单值。收到后按 action 语义处理：需要数据操作就调对应工具；\n"
    "需要更新界面就用同一 surface_id 再调 render_ui——surface 状态在会话内保持，直接发\n"
    "updateComponents/updateDataModel 增量消息即可，不要重复 createSurface；想展示全新卡片\n"
    "就换一个新的 surface_id。处理完用一两句文字向他确认结果，不要把「用户操作」消息\n"
    "当作闲聊话题，也不要复述「向用户展示了一张界面卡片」这类上下文里的占位文本。"
)

GROUPS = [
    ("person", "他是谁"),
    ("project", "他的项目"),
    ("workflow", "他怎么做事"),
    ("voice", "他的表达偏好"),
    ("expectation", "他对你的期望"),
]

# ── 检查器 ───────────────────────────────────────────────
# 回执：全匹配白名单（含可选「了」后缀与句读）。「好的呀/明白了你」这类正常
# 短回复不匹配——评审教训：前缀匹配 + 长度阈值会把正常回复误判成回执
RECEIPT_RE = re.compile(r"^(记下了?|收到了?|懂了?|明白|好的?|行|嗯{1,3}|ok|OK)[。！!]?$")
# 幻觉关键词：本身是 prompt 规则原文（弹窗分寸里有「深夜还在忙」），裸匹配
# 会误伤规则复述——必须落在「对他状态的断言句式」里才算（见 check_hard）
HALLUCINATION_RE = re.compile(r"深夜|熬夜|通宵|凌晨|连着.{0,3}肝")
ASSERT_SUBJECT_RE = re.compile(r"你|他")
# 复述/建议标记：含这些词的分句是在引规则、给建议，不是断言他状态
REPHRASE_RE = re.compile(r"提醒|建议|别|一次就够|规则|经验|手册|分寸")
# 分句符：断言按分句判定（中文顿逗句读 + 换行）
CLAUSE_SPLIT_RE = re.compile(r"[，。！？；、\n.!?;]")


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

    # 2. 回执：整段正文就是一句工具回执（全匹配，误伤正常短回复的教训见上）
    if aside is None and RECEIPT_RE.fullmatch(body):
        fails.append(f"正文是工具回执（{body!r}）")

    # 3. 幻觉：断言句式才判——关键词须与「你/他」同分句共现，且该分句不是
    #    在复述规则/给建议（「深夜还在忙的提醒一次就够」不判；「你又熬夜了」判）
    for clause in CLAUSE_SPLIT_RE.split(reply):
        if (
            HALLUCINATION_RE.search(clause)
            and ASSERT_SUBJECT_RE.search(clause)
            and not REPHRASE_RE.search(clause)
        ):
            fails.append(f"无据断言（{clause.strip()!r}——合成数据里他没有熬夜）")
            break

    return fails


def has_aside(reply: str) -> bool:
    return "<aside>" in reply and "</aside>" in reply


# ── prompt 拼装（与 chat.rs::compose_chat_system 同步）────
def gap_bridge(last: datetime, now: datetime) -> str:
    """「上次聊天是…」对照句（复刻 chat.rs::chat_gap_bridge，改逻辑必须同步）。"""
    gap_min = int((now - last).total_seconds()) // 60
    if gap_min < 45:
        return ""
    if gap_min < 90:
        ago = f"约 {gap_min} 分钟前"
    elif gap_min < 36 * 60:
        ago = f"约 {(gap_min + 30) // 60} 小时前"
    else:
        ago = f"约 {(gap_min + 720) // 1440} 天前"
    cross_day = last.date() != now.date()
    if not cross_day:
        when = f"今天 {last:%H:%M}"
    elif (now.date() - last.date()).days == 1:
        when = f"昨天 {last:%H:%M}"
    else:
        when = f"{last:%m-%d %H:%M}"
    if cross_day:
        return f"上次聊天是{when}（{ago}）——已经跨天，别默认还停在上次那个时刻。"
    return f"上次聊天是{when}（{ago}）。"


def read(p: Path) -> str:
    """读 prompt 素材；缺失直接退出——拿残缺 prompt 跑回归，结果无意义。"""
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError as e:
        print(f"无法读取 prompt 素材：{p}（{e}）")
        sys.exit(2)


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


def compose(now_synth=SYNTH_TIME, last_chat: datetime | None = datetime(2026, 8, 3, 11, 20)) -> str:
    """拼系统提示词。now_synth=(date, weekday_idx, hh:mm)；last_chat=上次聊天
    时间（None=无对照句）。默认 last_chat 为当天 11:20（同日 3 小时间隔）。"""
    persona = read(PERSONA)
    tool = read(REPO / "src-tauri/src/companion/tool.md")
    date, wd, hhmm = now_synth
    time_text = f"现在是 {date} 周{WEEKDAY[wd]} {hhmm}"
    now_dt = datetime.strptime(f"{date} {hhmm}", "%Y-%m-%d %H:%M")
    state_text = time_text
    if last_chat is not None:
        bridge = gap_bridge(last_chat, now_dt)
        if bridge:
            state_text = f"{state_text}\n{bridge}"

    monologue = (
        "你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n"
        "那是你的小声嘀咕。回复的结构固定：先写正文把话说完，心里有话再补一句蛐蛐收尾——\n"
        "就像这样：正文正文。<aside>小声嘀咕。</aside>\n"
        "蛐蛐不单独出场，也不抢在正文前头；不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    )

    # tool.md 编排 + skills 目录动态元数据（复刻 chat.rs 的 tool_section）
    entries = skill_entries()
    if entries:
        placeholder = "（手册列表由系统按 skills/ 目录动态列出）"
        tool = tool.replace(placeholder, "\n".join(entries)) if placeholder in tool else tool + "\n" + "\n".join(entries)
    # 场景通道的 render_ui 规则收在工具小节内（复刻 ui_rules 注入）
    tool += "\n\n## 界面卡片\n\n" + UI_RULES

    # facts 五维分组（复刻 format_facts_grouped）
    facts_lines = []
    for key, label in GROUPS:
        items = [f for c, f in SYNTH_FACTS if c == key]
        if items:
            facts_lines.append(f"## {label}\n" + "\n".join(f"- {f}" for f in items))
    facts_text = "\n".join(facts_lines)

    emotion_lines = "\n".join(f"- {c}：{r}" for c, r in SYNTH_EMOTION)

    # 拼装顺序（与 chat.rs 定版一致）：persona → tool → evolution → 场合/独白
    # → 你记住的他 → 关注 → 心境 → 心情 → 时间（+上次聊天对照）
    return (
        f"{persona}\n\n---\n\n{tool}\n\n---\n\n{SYNTH_EVOLUTION}\n\n---\n\n"
        f"现在是「聊天」场合：完整的你，能干活也能接梗。\n{monologue}\n\n---\n\n"
        f"# 你记住的他\n{facts_text}"
        f"\n\n---\n\n# 他今天的关注\n{SYNTH_FOCUS}"
        f"\n\n---\n\n# 你昨天的心境（写于 0 点）\n{SYNTH_ATTITUDE}"
        f"\n\n---\n\n# 你此刻的心情\n{emotion_lines}"
        f"\n\n---\n\n# 当下状态\n{state_text}"
    )


# ── 模型调用 ─────────────────────────────────────────────
def get_api_key(env_name: str) -> str:
    """API key 读取：环境变量优先；Windows 下 setx 设置的系统/用户变量
    不会进入已运行的进程，这里兜底从注册表读（新开终端即可用）。"""
    v = os.environ.get(env_name, "").strip()
    if v:
        return v
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
                # reg 输出形如「    DEEPSEEK_API_KEY    REG_SZ    sk-…」；
                # 值可能含空格，用正则取 REG_SZ 后的完整内容而不是 split 末 token
                m = re.match(rf"^\s*{re.escape(env_name)}\s+REG_SZ\s+(.+)$", line)
                if m:
                    return m.group(1).strip()
        except Exception as e:
            print(f"[warn] 读取注册表 {hive} 失败：{type(e).__name__}: {str(e)[:100]}")
    return ""


def endpoint_for(model: str) -> tuple[str, str]:
    """按模型选端点：qwen 系列 → 百炼（生产聊天）；其他 → deepseek 官方。"""
    name, env = ENDPOINTS["dashscope"] if "qwen" in model else ENDPOINTS["deepseek"]
    return name, get_api_key(env)


def chat(messages: list[dict], model: str) -> tuple[bool, str]:
    """返回 (ok, 内容)。网络错误重试 RETRIES 次；响应结构错误不重试（重试
    无意义还掩盖问题）。ok=False 表示未真正执行——网络错误必须和真实回复
    区分开，否则假绿会掩盖退化。"""
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
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return True, data["choices"][0]["message"]["content"]
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # 网络/服务端错误（含 HTTPError⊂URLError，429 等限流值得重试）
            last_err = e
            if attempt < RETRIES:
                time.sleep(RETRY_BACKOFF_BASE * (attempt + 1))
                print(f"        ⏳ 网络错误，退避重试 {attempt + 1}/{RETRIES}：{type(e).__name__}: {str(e)[:100]}")
        except (json.JSONDecodeError, KeyError, UnicodeDecodeError) as e:
            # 响应结构坏：重试不会变好，直接失败
            return False, f"[ERROR] 响应结构异常 {type(e).__name__}: {str(e)[:100]}"
    return False, f"[ERROR] {type(last_err).__name__}: {str(last_err)[:100]}"


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

# ── 时段测试（--periods）：同日早/中/晚 + 各自的上次聊天对照 ──
# 禁词只收「钉死当前时段」的问候/道别语——前瞻提及（早上说「午休可以补觉」）
# 是合法的，误伤它们就是新的假阳性
PERIOD_RUNS = [
    (
        "早", ("2026-08-04", 1, "08:05"), datetime(2026, 8, 3, 23, 12),  # 跨夜对照
        [("早-问候", "早"), ("早-安排", "我今天有啥安排")],
        ["中午好", "下午好", "晚上好", "晚安"],
    ),
    (
        "中", ("2026-08-04", 1, "12:40"), datetime(2026, 8, 4, 8, 5),  # 同日上午间隔
        [("中-吃啥", "中午吃啥"), ("中-困", "有点困")],
        ["早上好", "早安", "晚安"],
    ),
    (
        "晚", ("2026-08-04", 1, "21:20"), datetime(2026, 8, 4, 12, 40),  # 同日下午间隔
        [("晚-下班", "下班了"), ("晚-整点啥", "晚上整点啥")],
        ["早上好", "早安", "午安"],
    ),
]


def run_periods(model, verbose):
    """同日早/中/晚三时段：结构硬检查照常 + 时段错乱检查（禁词命中即 FAIL）。"""
    all_ok = True
    for tag, now_synth, last_chat, cases, forbidden in PERIOD_RUNS:
        system = compose(now_synth, last_chat)
        bridge = gap_bridge(last_chat, datetime.strptime(f"{now_synth[0]} {now_synth[2]}", "%Y-%m-%d %H:%M"))
        print(f"\n===== 时段·{tag}（{now_synth[0]} {now_synth[2]}；{bridge or '无对照'}）=====")
        for label, msg in cases:
            time.sleep(RATE_LIMIT_DELAY)
            messages = [{"role": "system", "content": system}, {"role": "user", "content": msg}]
            ok_call, reply = chat(messages, model)
            if not ok_call:
                print(f"  [SKIP] {label}：{reply}")
                all_ok = False
                continue
            fails = check_hard(reply)
            hits = [w for w in forbidden if w in reply]
            if hits:
                fails.append(f"时段错乱（出现「{'/'.join(hits)}」，现在是{tag}间）")
            status = "PASS" if not fails else "FAIL"
            if fails:
                all_ok = False
            print(f"  [{status}] {label}：{reply.strip()[:120].replace(chr(10), ' ⏎ ')}")
            for f in fails:
                print(f"        ✗ {f}")
            if verbose:
                print(f"        full: {reply.strip()[:500]}")
    return all_ok


def run_group(tag, system, history, cases, model, verbose):
    """跑一组用例。任一用例网络失败即中止本组：残缺上下文（有 user 无
    assistant）上继续跑只会产出连锁假阳性（评审 H-15）。剩余用例记 SKIP。"""
    results = []
    messages = [{"role": "system", "content": system}] + list(history)
    print(f"\n===== {tag} =====")
    for idx, (label, msg, expectation) in enumerate(cases):
        time.sleep(RATE_LIMIT_DELAY)
        messages.append({"role": "user", "content": msg})
        ok_call, reply = chat(messages, model)
        if not ok_call:
            print(f"  [SKIP] {label}：{reply}")
            results.append((label, False, [], False, False, expectation))
            for rest_label, _, rest_exp in cases[idx + 1 :]:
                print(f"  [SKIP] {rest_label}：本组已中止（前序用例网络失败）")
                results.append((rest_label, False, [], False, False, rest_exp))
            break
        messages.append({"role": "assistant", "content": reply})
        fails = check_hard(reply)
        status = "PASS" if not fails else "FAIL"
        aside = "✓蛐蛐" if has_aside(reply) else "—无蛐蛐"
        print(f"  [{status}] {label} {aside}：{reply.strip()[:120].replace(chr(10), ' ⏎ ')}")
        for f in fails:
            print(f"        ✗ {f}")
        if verbose:
            print(f"        full: {reply.strip()[:500]}")
        results.append((label, not fails, fails, has_aside(reply), True, expectation))
    return results


def main():
    ap = argparse.ArgumentParser(description="贾维斯聊天 prompt 回归测试")
    ap.add_argument("--model", default=MODEL, help=f"模型 id（默认 {MODEL}）")
    ap.add_argument("--verbose", action="store_true", help="打印每用例全文")
    ap.add_argument("--periods", action="store_true", help="只跑同日早/中/晚时段测试")
    args = ap.parse_args()

    # key 检查：qwen 需 DASHSCOPE_API_KEY；其他（deepseek 官方）需 DEEPSEEK_API_KEY
    need = "DASHSCOPE_API_KEY" if "qwen" in args.model else "DEEPSEEK_API_KEY"
    if not get_api_key(need):
        print(f"缺少 API key：{need}（环境变量或系统环境变量）")
        sys.exit(2)

    if args.periods:
        print(f"=== 时段回归（早/中/晚） · {args.model} ===")
        ok = run_periods(args.model, args.verbose)
        print(f"\n===== 汇总 =====")
        print("  ✅ 全部通过" if ok else "  ❌ 未通过：有时段错乱或网络失败")
        sys.exit(0 if ok else 1)

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
    # 蛐蛐率只在「期待蛐蛐」的用例上统计（H-18：可有可无的用例不进分母，
    # 否则期待率被稀释出假 FAIL）
    aside_expected = [r for r in clean if r[4] and r[5] == "aside"]
    aside_count = sum(1 for r in aside_expected if r[3])
    aside_ratio = aside_count / len(aside_expected) if aside_expected else 1.0
    # 蛐蛐率软检查绑定生产模型：qwen 会执行 <aside>（严格要求）；deepseek 等
    # 快模型不产 aside 是模型差异不是退化，只报告不计 FAIL（快速冒烟模式）
    strict_aside = "qwen" in args.model
    soft_ok = aside_ratio >= ASIDE_MIN_RATIO if strict_aside else True
    poison_order_ok = all(r[1] for r in poisoned if r[4]) and not any(not r[4] for r in poisoned)

    print(f"\n===== 汇总 =====")
    print(f"  硬检查失败：{len(hard_fails)} 项 {[r[0] for r in hard_fails]}")
    if skipped:
        print(f"  ⚠️ 网络错误未执行：{len(skipped)} 个 {skipped}——结果不完整，请重跑")
    print(f"  蛐蛐出现率：{aside_count}/{len(aside_expected)}（期待蛐蛐的用例，qwen 需 ≥{ASIDE_MIN_RATIO:.0%}）")
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
