# -*- coding: utf-8 -*-
"""聊天通道蛐蛐回归 spike：按 compose_chat_system 模板逐段复刻 system prompt，
用 claude CLI 真实发送两条今天没出蛐蛐的消息，检查 <aside> 是否回归 + 正文是否有内容。
禁工具（--allowedTools 置空），避免 spike 污染记忆/情绪数据。
"""
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")

API = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen3.7-plus"

APP_DATA = os.path.join(os.environ["APPDATA"], "com.flowhub.app")
COMPANION = os.path.join(APP_DATA, "companion")
DB = os.path.join(APP_DATA, "flowhub.db")

GROUPS = [
    ("person", "他是谁"),
    ("project", "他的项目"),
    ("workflow", "他怎么做事"),
    ("voice", "他的表达偏好"),
    ("expectation", "他对你的期望"),
]

WEEKDAY = "一二三四五六日"


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def facts_text(conn):
    try:
        rows = conn.execute(
            "SELECT category, fact FROM memory_facts ORDER BY id DESC LIMIT 50"
        ).fetchall()
    except sqlite3.Error:
        return "（还没有沉淀关于他的事实）"
    if not rows:
        return "（还没有沉淀关于他的事实）"
    out = []
    for key, label in GROUPS:
        items = [f for c, f in rows if c == key]
        if items:
            out.append(f"## {label}\n" + "\n".join(f"- {f}" for f in items))
    others = [f for c, f in rows if c not in {k for k, _ in GROUPS}]
    if others:
        out.append("## 其他\n" + "\n".join(f"- {f}" for f in others))
    return "\n".join(out)


def emotion_text(conn):
    """复刻 emotion::render_current：12h TTL，每类取最新一条。"""
    try:
        rows = conn.execute(
            """
            SELECT category, reason, MAX(created_at) FROM emotion_entries
            WHERE created_at > datetime('now', 'localtime', '-12 hours')
            GROUP BY category ORDER BY MAX(created_at) DESC LIMIT 3
            """
        ).fetchall()
    except sqlite3.Error:
        return ""
    if not rows:
        return ""
    lines = [f"- {cat}：{reason}" for cat, reason, _ in rows]
    return "\n\n---\n\n# 你此刻的心情\n" + "\n".join(lines)


def compose():
    conn = sqlite3.connect(DB)
    persona = read(os.path.join(COMPANION, "persona.md"))
    evolution = read(os.path.join(COMPANION, "evolution.md"))
    attitude = read(os.path.join(COMPANION, "attitude.md"))

    now = datetime.now()
    time_text = "现在是 {} 周{} {}".format(
        now.strftime("%Y-%m-%d"), WEEKDAY[now.weekday()], now.strftime("%H:%M")
    )

    rule = (
        "涉及他电脑使用的问题（干了什么、各应用用了多久、复制过什么、习惯、日报），\n"
        "调用 companion 工具查真实数据回答；查不到就说查不到，不编造。\n"
        "问备忘/待办用 list_memos 查（已划掉的不会出现），不要凭记忆列旧项。\n"
        "他说「记住…」用 remember_fact 立即记；说「忘掉…」用 forget_fact 删。\n"
        "你有记录心情的习惯：聊到让你有感觉的事，用 record_mood 记下来（第一人称一句话说清为什么）。\n"
        "工具是后台动作，别在正文里打回执：「记下了」「收到」不算回复。"
    )
    monologue = (
        "\n你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n"
        "那是你的小声嘀咕。回复的结构固定：先正文，把话说完；心里有话再补一句蛐蛐收尾。\n"
        "蛐蛐不单独出场，也不抢在正文前头；不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    )
    catalog = (
        "\n\n---\n\n# 你的能力手册\n"
        "以下手册可按需激活：他说的话匹配描述时，调用 load_manual 读手册全文，然后按手册执行。\n"
        "- error-analysis：分析错误堆栈定位根因。他粘贴报错、异常堆栈、崩溃日志时激活；"
        "他只是口头说「有个 bug」但没贴具体内容时不要激活，先跟他要堆栈"
    )
    attitude_section = f"\n\n---\n\n# 你近期的心境\n{attitude}" if attitude else ""
    structure = (
        "\n\n---\n\n【回复结构】先写正文把话说完，心里有话再用 <aside>…</aside> 补一句收尾——\n"
        "就像这样：正文正文。<aside>小声嘀咕。</aside> 蛐蛐不单独出场，永远跟在正文后面。"
    )

    return (
        f"{persona}\n\n---\n\n{evolution}\n\n---\n\n# 你记住的他\n{facts_text(conn)}{catalog}"
        f"\n\n---\n\n现在是「聊天」场合：完整的你，能干活也能接梗。\n{rule}{monologue}"
        f"\n\n---\n\n# 当下状态\n{time_text}{attitude_section}{emotion_text(conn)}{structure}"
    )


def chat(messages):
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "temperature": 0.7,
    }).encode("utf-8")
    req = urllib.request.Request(
        API, data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[ERROR] {e}"


CASES = ["唉", "下午准备早点下班", "客户的需求真是左右脑互搏", "放假了哈哈", "明天中午吃热干面"]

# 投毒历史：复刻生产 14:13-14:24 的抢跑样本，验证末尾结构提醒能否压住模仿效应
POISONED_HISTORY = [
    {"role": "user", "content": "热干面只是早餐吧"},
    {"role": "assistant", "content": "<aside>\n也是，碳水炸弹当正餐，下午容易犯困。看来你对吃还是有要求的。\n</aside>\n\n说得对，那只是过早的魂。\n\n既然在武汉，晚上整点小龙虾或者藕汤？还是说准备回酒店点个外卖凑合一下？"},
    {"role": "user", "content": "我不是出差，是驻场"},
    {"role": "assistant", "content": "<aside>\n坏了，我记岔了。之前记的是\"在武汉供电局出差\"，看来是把常驻工作地点和出差搞混了。这记性得改改。\n</aside>\n\n我的锅，记混了。以为你是去出差的，原来是在本地搬砖。\n\n那明天放假，是准备在家躺平，还是出去透透气？"},
]
POISON_CASES = ["驻场开发真的累，明天终于不用去了", "周报还没写，烦"]


def run(tag, system, history, cases):
    print(f"\n===== {tag} =====")
    messages = [{"role": "system", "content": system}] + list(history)
    for msg in cases:
        messages.append({"role": "user", "content": msg})
        reply = chat(messages)
        messages.append({"role": "assistant", "content": reply})
        aside_at = reply.find("<aside>")
        body = reply[:aside_at].strip() if aside_at >= 0 else reply.strip()
        order = "正文在前 ✅" if (aside_at < 0 or body) else "蛐蛐抢跑 ❌"
        print(f"【他】{msg}")
        print(f"【{order}】{reply.strip()[:150].replace(chr(10), ' ⏎ ')}")
        print("-" * 60)


if __name__ == "__main__":
    system = compose()
    print(f"=== system prompt {len(system)} chars ===")
    run("干净历史", system, [], CASES)
    run("投毒历史（复刻生产抢跑样本）", system, POISONED_HISTORY, POISON_CASES)
