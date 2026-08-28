# N0 spike 轨1：qwen3-vl-embedding API（百炼）回归验证
#
# 验证项（裁决 CASE-007 Q10，API 仅作验证工具、2560 全维、不动历史数据）：
#   1. 文本回归——一期同语料 488 条 + 16 查询，top-1/top-3（硬红线 top-3>=88%）
#   2. 视频链路——10s 样本视频 embed + 文搜视频 sanity
#   3. API 端到端延迟（P95），为 query 验收线提供实测依据
#
# 用法：
#   set DASHSCOPE_API_KEY=sk-...   （或 export）
#   python spike_qwen_api.py [--skip-video]

import base64
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "..", "bge-onnx", "corpus", "corpus.jsonl")
QUERIES = os.path.join(HERE, "..", "bge-onnx", "corpus", "queries.jsonl")
SAMPLES = os.path.join(HERE, "samples")
MODEL = "qwen3-vl-embedding"
DIMENSION = 2560


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def embed_texts(texts, desc="", instruct=None, cache_file=None):
    """逐条调 MultiModalEmbedding，返回 (向量列表, 单条耗时列表)。带 npy 缓存。"""
    import dashscope
    import numpy as np

    if cache_file and os.path.exists(cache_file):
        log(f"命中缓存 {os.path.basename(cache_file)}")
        return np.load(cache_file).tolist(), [0.0] * len(texts)

    vectors, times = [], []
    for i, text in enumerate(texts):
        t0 = time.perf_counter()
        kwargs = dict(model=MODEL, input=[{"text": text}], dimension=DIMENSION)
        if instruct:
            kwargs["instruct"] = instruct
        resp = dashscope.MultiModalEmbedding.call(**kwargs)
        dt = time.perf_counter() - t0
        if resp.status_code != 200:
            raise RuntimeError(f"embed 失败 {resp.status_code}: {resp.message}")
        vectors.append(resp.output["embeddings"][0]["embedding"])
        times.append(dt)
        if (i + 1) % 25 == 0 or i + 1 == len(texts):
            log(f"  {desc} {i + 1}/{len(texts)}（最近 {dt*1000:.0f}ms）")
    if cache_file:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        np.save(cache_file, np.asarray(vectors, dtype=np.float32))
    return vectors, times


def cosine_topk(query, docs, k=5):
    import numpy as np

    q = np.asarray(query, dtype=np.float32)
    d = np.asarray(docs, dtype=np.float32)
    sims = d @ q / (np.linalg.norm(d, axis=1) * np.linalg.norm(q) + 1e-9)
    idx = sims.argsort()[::-1][:k]
    return [(int(i), float(sims[i])) for i in idx]


def text_regression(instruct=None):
    log(f"=== 文本回归（{MODEL}，{DIMENSION}d，instruct={'有' if instruct else '无'}）===")
    docs = [json.loads(l) for l in open(CORPUS, encoding="utf-8")]
    queries = [json.loads(l) for l in open(QUERIES, encoding="utf-8")]
    log(f"语料 {len(docs)} 条，查询 {len(queries)} 条")

    doc_cache = os.path.join(HERE, "cache", f"doc_vecs_{DIMENSION}.npy")
    doc_vecs, doc_times = embed_texts([d["text"] for d in docs], desc="语料", cache_file=doc_cache)
    if doc_times[0] > 0:
        ts = sorted(doc_times)
        log(
            f"语料 embed 单条均 {sum(doc_times)/len(doc_times)*1000:.0f}ms，"
            f"P50 {ts[len(ts)//2]*1000:.0f}ms，P95 {ts[int(len(ts)*0.95)]*1000:.0f}ms"
        )

    q_vecs, q_times = embed_texts([q["q"] for q in queries], desc="查询", instruct=instruct)
    qs = sorted(q_times)
    log(f"查询单条均 {sum(q_times)/len(q_times)*1000:.0f}ms，P95 {qs[int(len(qs)*0.95)]*1000:.0f}ms")

    hit1 = hit3 = 0
    for q, vec in zip(queries, q_vecs):
        top = cosine_topk(vec, doc_vecs)
        expect = q.get("expect", "")
        mark = ""
        if expect in docs[top[0][0]]["id"]:
            hit1 += 1
            mark = " <<< top1"
        elif any(expect in docs[i]["id"] for i, _ in top[:3]):
            hit3 += 1
            mark = " <<< top3"
        log(f"  {q['q'][:30]} -> {docs[top[0][0]]['id']}（{top[0][1]:.3f}）{mark}")
    n = len(queries)
    log(f"top-1: {hit1}/{n} = {hit1/n*100:.0f}%  top-3: {hit3+hit1}/{n} = {(hit3+hit1)/n*100:.0f}%")


def video_sanity():
    """10s 样本视频 embed + 文搜视频（样本由 spike_wemm.py 的 make_samples 生成）"""
    import dashscope

    vids = [os.path.join(SAMPLES, n) for n in ["err.mp4", "sql.mp4"]]
    if not all(os.path.exists(p) for p in vids):
        log("样本视频不存在，先跑 spike_wemm.py 生成，跳过视频链路验证")
        return

    log("=== 视频链路 sanity ===")
    vecs, times = [], []
    for p in vids:
        b64 = base64.b64encode(open(p, "rb").read()).decode()
        t0 = time.perf_counter()
        resp = dashscope.MultiModalEmbedding.call(
            model=MODEL,
            input=[{"video": f"data:video/mp4;base64,{b64}"}],
            dimension=DIMENSION,
        )
        dt = time.perf_counter() - t0
        if resp.status_code != 200:
            raise RuntimeError(f"视频 embed 失败 {resp.status_code}: {resp.message}")
        vecs.append(resp.output["embeddings"][0]["embedding"])
        times.append(dt)
    log(f"10s 视频 embed 单段均 {sum(times)/len(times):.1f}s")

    for q in ["视频里展示了红色错误页面", "视频演示了 SQL 删除操作"]:
        qv, _ = embed_texts([q], desc="查询")
        top = cosine_topk(qv[0], vecs)
        log(f"  「{q}」-> {os.path.basename(vids[top[0][0]])}（{top[0][1]:.3f}）")


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-video", action="store_true")
    parser.add_argument("--instruct", default=None, help="查询侧任务指令（语料侧不加）")
    args = parser.parse_args()
    if not os.environ.get("DASHSCOPE_API_KEY"):
        sys.exit("缺少 DASHSCOPE_API_KEY 环境变量")
    text_regression(instruct=args.instruct)
    if not args.skip_video:
        video_sanity()
    log("done")


if __name__ == "__main__":
    main()
