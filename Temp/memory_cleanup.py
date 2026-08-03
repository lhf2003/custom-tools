# -*- coding: utf-8 -*-
"""存量记忆清洗（私人管家升级工作包 #7）。

memory_facts 里的语义重复（Java×4、守望×3、B站×3）与「用户」称呼问题，
经 qwen 合并改写为精简清单。默认预览，--apply 才写库（写库前自动备份 JSON）。

用法：
  python Temp/memory_cleanup.py          # 预览合并方案
  python Temp/memory_cleanup.py --apply  # 备份后执行
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

APP_DATA = Path(os.environ["APPDATA"]) / "com.flowhub.app"
DB = APP_DATA / "flowhub.db"
BACKUP = Path(__file__).resolve().parent / f"memory_facts_backup_{time.strftime('%Y%m%d_%H%M%S')}.json"

API = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen3.7-plus"

MERGE_PROMPT = """你是数据整理助手。下面是一个 AI 管家关于他主人的记忆条目，存在语义重复与称呼问题。
请合并为精简清单，规则：
1. 同主题合并成一条最准最新版（例：多条技术栈 → 一条；多条守望先锋/安娜 → 一条；多条 B 站/动漫 → 一条）
2. 一律用「他」，禁用「用户」
3. 保留全部不重复的信息点，不发明新信息
4. category 从 person/project/workflow/voice/expectation 选
5. 已经过时或被更全条目覆盖的旧条，进 delete_ids
6. 原清单的每个 id 都必须出现在 keep 或 delete_ids 之一，一个不许漏；
   keep 的条数应明显少于原清单（该合并的就合并）

只输出 JSON：
{"keep": [{"id": 原条目id, "fact": "改写后的条目", "category": "..."}], "delete_ids": [被合并掉的条目id]}

keep 的 id 必须来自原清单（fact 可改写）；delete_ids 里的条目会被删除。
原清单：

{facts}"""


def main():
    apply = "--apply" in sys.argv
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT id, category, fact FROM memory_facts ORDER BY id").fetchall()
    print(f"现有 {len(rows)} 条记忆")
    facts_text = "\n".join(f'- [id={i}] ({c}) {f}' for i, c, f in rows)

    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": MERGE_PROMPT.replace("{facts}", facts_text)}],
        "temperature": 0.2,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    plan = json.loads(data["choices"][0]["message"]["content"])

    keep = plan.get("keep", [])
    delete_ids = set(plan.get("delete_ids", []))
    valid_ids = {i for i, _, _ in rows}
    keep_ids = set()
    print("\n=== 保留/改写 ===")
    for k in keep:
        keep_ids.add(k["id"])
        print(f'  [{k["id"]}] ({k["category"]}) {k["fact"]}')
    print("\n=== 删除（被合并）===")
    for d in sorted(delete_ids):
        orig = next((f for i, _, f in rows if i == d), "?")
        print(f"  [{d}] {orig}")
    unknown = (keep_ids | delete_ids) - valid_ids
    overlap = keep_ids & delete_ids
    uncovered = valid_ids - keep_ids - delete_ids
    if unknown or overlap:
        print(f"\n⚠️ 方案异常：未知 id {unknown} / keep 与 delete 重叠 {overlap}，中止")
        sys.exit(1)
    if uncovered:
        print(f"\n⚠️ 以下条目未被方案覆盖（将原样保留）：{sorted(uncovered)}")

    if not apply:
        print(f"\n预览模式：{len(keep)} 条保留改写，{len(delete_ids)} 条删除。确认无误后加 --apply 执行")
        return

    backup = [{"id": i, "category": c, "fact": f} for i, c, f in rows]
    BACKUP.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已备份 {len(backup)} 条到 {BACKUP.name}")

    for k in keep:
        conn.execute("UPDATE memory_facts SET fact=?, category=? WHERE id=?", (k["fact"], k["category"], k["id"]))
    for d in delete_ids:
        conn.execute("DELETE FROM memory_facts WHERE id=?", (d,))
    conn.commit()
    print(f"执行完成：改写 {len(keep)} 条，删除 {len(delete_ids)} 条，剩余 {len(rows) - len(delete_ids)} 条")


if __name__ == "__main__":
    main()
