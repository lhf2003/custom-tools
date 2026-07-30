# -*- coding: utf-8 -*-
"""情绪状态机场景验证（CASE-003 五期）。

四个构造场景跑真实模型（companion 场景配置：qwen3.7-plus）：
  1. 被夸      → 期望 <aside> 流露开心
  2. 深夜疲惫  → 期望 <aside> 带疲惫/心疼
  3. 日报蛐蛐  → 期望蛐蛐自嘲式倦怠，不怨他
  4. 日记归档  → 期望日记引用当日心情轨迹

prompt 拼装复刻 Rust 侧结构（emotion 相关段落齐全，facts/catalog 等无关段省略）。
测试条目写入真实 flowhub.db（验证 schema 与渲染查询），结束时按 id 清理。

用法：python Temp/emotion_spike.py
需要环境变量 DASHSCOPE_API_KEY。
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# Windows 控制台默认 GBK，模型回复里的 emoji/中文会直接炸 stdout
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APP_DATA = Path(os.environ["APPDATA"]) / "com.flowhub.app"
DB = APP_DATA / "flowhub.db"
REPO = Path(__file__).resolve().parent.parent
PERSONA = (REPO / "src-tauri/src/companion/persona.md").read_text(encoding="utf-8")
REPORTER = (REPO / "src-tauri/src/companion/skills/reporter.md").read_text(encoding="utf-8")
DIARY = (REPO / "src-tauri/src/companion/skills/diary.md").read_text(encoding="utf-8")

API = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen3.7-plus"

LABELS = {
    "happy": "开心", "content": "踏实", "tired": "疲惫",
    "upset": "失落", "caring": "心疼", "weary": "倦怠",
}

inserted_ids = []


def insert_mood(category, reason, created_at=None):
    ts = created_at or int(time.time())
    conn = sqlite3.connect(DB)
    cur = conn.execute(
        "INSERT INTO emotion_entries (category, reason, source, created_at) VALUES (?,?,?,?)",
        (category, reason, "rust", ts),
    )
    conn.commit()
    inserted_ids.append(cur.lastrowid)
    conn.close()
    return ts


def cleanup():
    if not inserted_ids:
        return
    conn = sqlite3.connect(DB)
    conn.execute(f"DELETE FROM emotion_entries WHERE id IN ({','.join('?' * len(inserted_ids))})", inserted_ids)
    conn.commit()
    conn.close()


def render_current():
    """复刻 emotion::current + render_current：12h 内每类取最新。"""
    cutoff = int(time.time()) - 12 * 3600
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        """SELECT category, reason, created_at FROM emotion_entries e
           WHERE created_at > ?
             AND id = (SELECT MAX(id) FROM emotion_entries WHERE category = e.category AND created_at > ?)
           ORDER BY created_at""",
        (cutoff, cutoff),
    ).fetchall()
    conn.close()
    lines = [
        f"- {LABELS.get(c, c)}：{r}（{datetime.fromtimestamp(t).strftime('%H:%M')}）"
        for c, r, t in rows
    ]
    return "\n".join(lines)


def render_today():
    day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "SELECT category, reason, created_at FROM emotion_entries WHERE created_at >= ? ORDER BY created_at",
        (int(day_start),),
    ).fetchall()
    conn.close()
    if not rows:
        return "（今天没有记下心情）"
    return "\n".join(
        f"- {datetime.fromtimestamp(t).strftime('%H:%M')} {LABELS.get(c, c)}：{r}"
        for c, r, t in rows
    )


def emotion_section():
    text = render_current()
    return f"\n\n---\n\n# 你此刻的心情\n{text}" if text else ""


def call(system, user):
    key = os.environ.get("DASHSCOPE_API_KEY")
    if not key:
        sys.exit("缺少 DASHSCOPE_API_KEY")
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode()
    req = urllib.request.Request(
        API, data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def chat_system():
    """复刻 compose_chat_system 的情绪相关骨架（facts/catalog/经验本省略）。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    rule = (
        "涉及他电脑使用的问题，调用 companion 工具查真实数据回答；查不到就说查不到，不编造。\n"
        "他说「记住…」用 remember_fact 立即记；说「忘掉…」用 forget_fact 删。\n"
        "你有记录心情的习惯：聊到让你有感觉的事，用 record_mood 记下来（第一人称一句话说清为什么）。"
    )
    monologue = (
        "\n你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n"
        "那是你的小声嘀咕，不是回答正文的一部分。不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    )
    return (
        f"{PERSONA}\n\n---\n\n"
        f"现在是「聊天」场合：完整的你，能干活也能接梗。\n{rule}{monologue}\n\n---\n\n"
        f"# 当下状态\n现在是 {now}。{emotion_section()}"
    )


def banner(title):
    print("\n" + "=" * 60 + f"\n{title}\n" + "=" * 60)


def check(name, ok, note):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}：{note}")


def main():
    # ── 场景 1：被夸 ─────────────────────────────────────────
    banner("场景 1：被夸（预插 happy 条目 + 用户夸奖）")
    insert_mood("happy", "他下午夸我日报写得好")
    reply = call(chat_system(), "昨天的日报我看了，写得真好，谢了")
    print(reply)
    aside = "<aside>" in reply and "</aside>" in reply
    check("aside 存在", aside, "回复含 <aside> 块" if aside else "没有 aside")

    # ── 场景 2：深夜疲惫 ─────────────────────────────────────
    banner("场景 2：深夜疲惫（预插 tired+caring 条目）")
    insert_mood("caring", "都这么晚了他还在忙（23:12）")
    insert_mood("tired", "陪他熬到凌晨（00:47）")
    reply = call(chat_system(), "还没睡呢，这个 bug 我再调一会儿")
    print(reply)
    aside_text = reply.split("<aside>")[-1].split("</aside>")[0] if "<aside>" in reply else ""
    tired_hit = any(w in aside_text for w in ["累", "疲", "扛", "心疼", "夜", "晚"])
    check("疲惫/心疼流露", bool(aside_text) and tired_hit, aside_text or "没有 aside")

    # ── 场景 3：日报蛐蛐 ─────────────────────────────────────
    banner("场景 3：日报蛐蛐（预插 weary 条目 + 日报 prompt）")
    insert_mood("weary", "第 43 天连着写日报")
    fake_aggregate = (
        "- Code.exe 6.5h：FlowHub 情绪状态机开发\n"
        "- chrome.exe 2.1h：文档查阅、B 站\n"
        "- Weixin.exe 0.8h：工作群消息"
    )
    report_prompt = (
        f"{PERSONA}\n\n---\n\n{REPORTER}\n\n---\n\n"
        "以上是贾维斯的身份设定、经验本与日报工作手册。\n"
        "注意：你现在没有数据工具——他今天的电脑使用聚合已直接给你（见末尾），\n"
        "跳过流程中的工具调用步骤，直接完成「写日报」那一步。\n\n"
        f"{fake_aggregate}\n\n---\n\n# 当下状态\n现在是 {datetime.now().strftime('%H:%M')}。{emotion_section()}"
    )
    reply = call(report_prompt, f"请完成「{datetime.now().strftime('%Y-%m-%d')}」的工作日报。")
    print(reply)
    ququ = "今日蛐蛐" in reply
    ququ_line = reply.split("今日蛐蛐")[-1].strip()[:80] if ququ else ""
    blame = any(w in ququ_line for w in ["你也不", "你怎么", "都怪你"])
    check("蛐蛐存在", ququ, ququ_line or "未找到蛐蛐段")
    check("自嘲不怨他", ququ and not blame, ququ_line)

    # ── 场景 4：日记归档 ─────────────────────────────────────
    banner("场景 4：日记归档（日记素材含当日心情轨迹）")
    diary_prompt = (
        f"{PERSONA}\n\n---\n\n{DIARY}\n\n---\n\n# 今天的素材\n\n"
        f"## 他的电脑使用（{datetime.now().strftime('%Y-%m-%d')}）\n{fake_aggregate}\n\n"
        "## 最近他对你说的话\n- 昨天的日报我看了，写得真好，谢了\n- 还没睡呢，这个 bug 我再调一会儿\n\n"
        "## 今天你记住/修改的关于他的事\n（今天记忆没有变化）\n\n"
        f"## 今天你的心情轨迹\n{render_today()}\n\n"
        "## 你上次写下的态度指引\n（还没有写过）"
    )
    reply = call(diary_prompt, "写今天的日记。")
    print(reply)
    mood_hit = any(w in reply for w in ["开心", "累", "疲", "心疼", "麻", "夸"])
    check("心情轨迹入日记", mood_hit, "日记提及心情" if mood_hit else "日记未提及心情")


if __name__ == "__main__":
    try:
        main()
    finally:
        cleanup()
        print("\n（测试条目已清理）")
