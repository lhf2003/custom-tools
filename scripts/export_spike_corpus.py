# M0 spike: 从 flowhub.db + notes 目录导出真实语料 → corpus.jsonl
# 用法: python scripts/export_spike_corpus.py
import json
import sqlite3
from pathlib import Path

DB = r"C:/Users/23851/AppData/Roaming/com.flowhub.app/flowhub.db"
NOTES_DIR = Path(r"C:/Users/23851/AppData/Roaming/com.flowhub.app/notes")
OUT = Path(__file__).resolve().parent.parent / "spikes" / "bge-onnx" / "corpus" / "corpus.jsonl"

MIN_LEN = 30          # 短于此无检索价值
MAX_DOC = 3000        # 单文档直接入库上限
CHUNK = 1200          # 超长文档切块大小
MAX_CHUNKS_PER_DOC = 8


def chunk_text(text: str, size: int = CHUNK):
    return [text[i : i + size] for i in range(0, len(text), size)][:MAX_CHUNKS_PER_DOC]


def main():
    docs = []

    db = sqlite3.connect(DB)
    rows = db.execute(
        "SELECT id, content, source_app, created_at FROM clipboard_history "
        "WHERE content_type='text' AND length(content) >= ?",
        (MIN_LEN,),
    ).fetchall()
    db.close()

    for cid, content, source_app, created_at in rows:
        content = content.strip()
        if len(content) <= MAX_DOC:
            docs.append({"id": f"clip-{cid}", "source": f"clipboard/{source_app or 'unknown'}",
                         "created_at": created_at, "text": content})
        else:
            for i, ch in enumerate(chunk_text(content)):
                docs.append({"id": f"clip-{cid}#{i}", "source": f"clipboard/{source_app or 'unknown'}",
                             "created_at": created_at, "text": ch})

    for md in NOTES_DIR.rglob("*.md"):
        text = md.read_text(encoding="utf-8", errors="replace").strip()
        if len(text) < MIN_LEN:
            continue
        rel = md.relative_to(NOTES_DIR).as_posix()
        if len(text) <= MAX_DOC:
            docs.append({"id": f"note-{rel}", "source": "notes", "created_at": None, "text": text})
        else:
            for i, ch in enumerate(chunk_text(text)):
                docs.append({"id": f"note-{rel}#{i}", "source": "notes", "created_at": None, "text": ch})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for d in docs:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    print(f"exported {len(docs)} docs -> {OUT}")


if __name__ == "__main__":
    main()
