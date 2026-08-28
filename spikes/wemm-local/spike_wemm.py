# N0 spike 轨2：WeMM-Embedding-2B 本地 CPU 裸跑验证
#
# 验证项（裁决 CASE-007 Q10）：
#   1. 文本回归——一期同语料 488 条 + 16 查询，top-1/top-3 命中率（硬红线 top-3>=88%）
#   2. 512 截断 vs 2048 全维 质量损失（MRL embed 一次截断两版）
#   3. 图片/视频 embed 链路 + 文搜图/文搜视频 sanity
#   4. CPU 推理速度（单条耗时、P95）——无 GPU 用户机器可行性
#
# 用法：
#   python spike_wemm.py                 # 全量（文本回归 + 视觉链路）
#   python spike_wemm.py --skip-vision   # 只跑文本回归
#
# 命中判定口径与一期 bge spike 一致：doc id contains expect 子串。

import argparse
import json
import os
import subprocess
import sys
import time

import torch

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")
CORPUS = os.path.join(HERE, "..", "bge-onnx", "corpus", "corpus.jsonl")
QUERIES = os.path.join(HERE, "..", "bge-onnx", "corpus", "queries.jsonl")
SAMPLES = os.path.join(HERE, "samples")
FFMPEG = r"D:\Java\ffmpeg-7.0.2-essentials_build\bin\ffmpeg.exe"

DIMS = [2048, 512]  # 全维 vs 截断（MRL：embed 一次，截断出两版）


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_model(device="cpu"):
    from transformers import AutoModel, AutoProcessor

    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(MODEL_DIR, trust_remote_code=True)
    # 必须 trust_remote_code：主线 transformers 也能加载 qwen3_5 架构，
    # 但那样拿到的是 Qwen3_5Model 裸类，没有 embedding() 方法
    # 显存约束：fp32 需 8GB+ 超过 5060 Laptop，GPU 走 bf16（5.1GB）
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    model = AutoModel.from_pretrained(
        MODEL_DIR, dtype=dtype, trust_remote_code=True
    )
    model.eval().to(device)
    log(f"模型加载 {time.perf_counter() - t0:.1f}s（device={device}, dtype={dtype}）")
    return processor, model


def encode(processor, model, messages, dimension=None, device="cpu"):
    """按官方示例：chat template -> processor -> model.embedding -> MRL 截断 -> L2 归一化"""
    import torch.nn.functional as F
    from qwen_vl_utils import process_vision_info

    prompt = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    images, videos, video_kwargs = process_vision_info(
        messages,
        image_patch_size=16,
        return_video_kwargs=True,
        return_video_metadata=True,
    )
    if videos is not None:
        videos, video_metadata = zip(*videos)
        videos, video_metadata = list(videos), list(video_metadata)
    else:
        video_metadata = None
    inputs = processor(
        text=prompt,
        images=images,
        videos=videos,
        video_metadata=video_metadata,
        padding=True,
        return_tensors="pt",
        **video_kwargs,
    )
    inputs = inputs.to(device)
    with torch.inference_mode():
        emb = model.embedding(**inputs).float()
    if dimension is not None:
        emb = emb[:, :dimension]
    return F.normalize(emb, p=2, dim=-1)


def text_messages(text):
    return [{"role": "user", "content": [{"type": "text", "text": text}]}]


def embed_texts(processor, model, texts, batch_size=8, desc="", device="cpu"):
    """批量文本 embed，返回全维矩阵（未截断），并统计耗时"""
    out, times = [], []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        t0 = time.perf_counter()
        emb = encode(processor, model, [text_messages(t) for t in batch], device=device)
        dt = time.perf_counter() - t0
        times.extend([dt / len(batch)] * len(batch))
        out.append(emb)
        log(f"  {desc} {i + len(batch)}/{len(texts)} ({dt:.1f}s/batch)")
    return torch.cat(out), times


def cosine_topk(query_emb, doc_embs, k=5):
    sims = (doc_embs @ query_emb.T).squeeze(-1)
    return sims.topk(min(k, len(sims)))


def text_regression(processor, model, device="cpu", query_instruct=None):
    log("=== 文本回归（488 语料 + 16 查询） ===")
    docs = [json.loads(l) for l in open(CORPUS, encoding="utf-8")]
    queries = [json.loads(l) for l in open(QUERIES, encoding="utf-8")]
    log(f"语料 {len(docs)} 条，查询 {len(queries)} 条")

    t0 = time.perf_counter()
    doc_full, doc_times = embed_texts(
        processor, model, [d["text"] for d in docs], desc="语料", device=device
    )
    total = time.perf_counter() - t0
    ts = sorted(doc_times)
    log(
        f"语料 embed 总耗时 {total/60:.1f}min，单条均 {sum(doc_times)/len(doc_times)*1000:.0f}ms，"
        f"P50 {ts[len(ts)//2]*1000:.0f}ms，P95 {ts[int(len(ts)*0.95)]*1000:.0f}ms"
    )

    q_texts = [(query_instruct + q["q"]) if query_instruct else q["q"] for q in queries]
    query_full, query_times = embed_texts(
        processor, model, q_texts, batch_size=4, desc="查询", device=device
    )
    qs = sorted(query_times)
    log(f"查询单条均 {sum(query_times)/len(query_times)*1000:.0f}ms，P95 {qs[int(len(qs)*0.95)]*1000:.0f}ms")

    for dim in DIMS:
        doc_embs = torch.nn.functional.normalize(doc_full[:, :dim], p=2, dim=-1)
        query_embs = torch.nn.functional.normalize(query_full[:, :dim], p=2, dim=-1)
        hit1 = hit3 = 0
        for qi, q in enumerate(queries):
            top = cosine_topk(query_embs[qi : qi + 1], doc_embs)
            ids = [docs[i]["id"] for i in top.indices.tolist()]
            expect = q.get("expect", "")
            mark = ""
            if any(expect in i for i in ids[:1]):
                hit1 += 1
                mark = " <<< top1"
            elif any(expect in i for i in ids[:3]):
                hit3 += 1
                mark = " <<< top3"
            log(f"  [{dim}d] {q['q'][:30]} -> {ids[0]}（{top.values[0]:.3f}）{mark}")
        n = len(queries)
        log(f"[{dim}d] top-1: {hit1}/{n} = {hit1/n*100:.0f}%  top-3: {hit3+hit1}/{n} = {(hit3+hit1)/n*100:.0f}%")


def make_samples():
    """生成 4 张测试图 + 2 个 10s 视频（ffmpeg 图片转视频）"""
    from PIL import Image, ImageDraw

    os.makedirs(SAMPLES, exist_ok=True)
    specs = [
        ("err500.png", (200, 40, 40), "500 Internal Server Error"),
        ("success.png", (40, 130, 200), "Submit Success"),
        ("launcher.png", (60, 60, 60), "nervis Launcher Alt+Space"),
        ("sql.png", (240, 200, 90), "DELETE FROM t WHERE id=1"),
    ]
    for name, color, text in specs:
        p = os.path.join(SAMPLES, name)
        if not os.path.exists(p):
            img = Image.new("RGB", (640, 360), color)
            ImageDraw.Draw(img).text((40, 160), text, fill=(255, 255, 255))
            img.save(p)
    for name, src in [("err.mp4", "err500.png"), ("sql.mp4", "sql.png")]:
        p = os.path.join(SAMPLES, name)
        if not os.path.exists(p):
            subprocess.run(
                [FFMPEG, "-y", "-loop", "1", "-i", os.path.join(SAMPLES, src),
                 "-t", "10", "-pix_fmt", "yuv420p", p],
                check=True, capture_output=True,
            )


def vision_sanity(processor, model, device="cpu"):
    log("=== 视觉链路 sanity（文搜图 / 文搜视频） ===")
    make_samples()

    t0 = time.perf_counter()
    img_embs = []
    for name in ["err500.png", "success.png", "launcher.png", "sql.png"]:
        msg = [{"role": "user", "content": [
            {"type": "image", "image": os.path.join(SAMPLES, name)}]}]
        img_embs.append(encode(processor, model, msg, device=device))
    log(f"图片 embed 单张均 {(time.perf_counter()-t0)/4*1000:.0f}ms")

    t0 = time.perf_counter()
    vid_embs = []
    for name in ["err.mp4", "sql.mp4"]:
        msg = [{"role": "user", "content": [
            {"type": "video", "video": os.path.join(SAMPLES, name)}]}]
        vid_embs.append(encode(processor, model, msg, device=device))
    vid_time = (time.perf_counter() - t0) / 2
    log(f"10s 视频 embed 单段均 {vid_time:.1f}s")

    cases = [
        ("服务器报错的红色截图", torch.cat(img_embs), ["err500", "success", "launcher", "sql"]),
        ("数据库删除语句的界面", torch.cat(img_embs), ["err500", "success", "launcher", "sql"]),
        ("视频里展示了红色错误页面", torch.cat(vid_embs), ["err.mp4", "sql.mp4"]),
        ("视频演示了 SQL 删除操作", torch.cat(vid_embs), ["err.mp4", "sql.mp4"]),
    ]
    for q, embs, names in cases:
        qe = encode(processor, model, text_messages(q), device=device)
        top = cosine_topk(qe, embs, k=len(names))
        log(f"  「{q}」-> {names[top.indices[0]]}（{top.values[0]:.3f}）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-vision", action="store_true")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--query-instruct", default=None,
                        help="查询侧任务指令（拼接在查询文本前，语料侧不加）")
    args = parser.parse_args()

    if not os.path.isdir(MODEL_DIR):
        sys.exit("模型未下载：先跑 python download_model.py")

    processor, model = load_model(args.device)
    text_regression(processor, model, args.device, args.query_instruct)
    if not args.skip_vision:
        vision_sanity(processor, model, args.device)
    log("done")


if __name__ == "__main__":
    main()
