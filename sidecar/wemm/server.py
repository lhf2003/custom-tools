# nervis WeMM sidecar —— 多模态 embedding 推理服务
#
# 协议：stdin/stdout 传 [u32 LE 长度][JSON] 帧（与 memory-host native messaging 同格式，D1）。
# 生命周期由 Rust 侧管理（按需拉起、空闲退出、shutdown 命令），本进程模型常驻。
#
# 启动握手：进程起来先发 {"type":"loading"}，模型就绪发 {"type":"ready",device,dimension}；
# 无 NVIDIA GPU（D7：N1 只保 GPU）发 {"type":"error","error":"gpu_required"} 后退出码 2。
#
# 请求（type 字段）：
#   ping                                              -> {"ok":true}
#   embed_documents {texts:[...]}                     -> result.vectors [[f32;2048]...]（语料侧，无 instruct）
#   embed_query {text}                                -> result.vector [f32;2048]（查询侧，固定 instruct 前缀，N0 规范）
#   embed_image {image_base64, mime}                  -> result.vector
#   embed_video {video_base64, mime, captured_seconds?} -> result.vector
#   shutdown                                          -> {"ok":true} 后退出码 0
#
# 维度固定 2048 全维（N0：512 截断裸查询不过线已弃用）；模型 bf16（8GB 显卡约束）。

import base64
import json
import os
import struct
import sys
import tempfile
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# N0 验证的检索指令（查询侧固定前缀，语料侧不加；与 qwen3-vl API 回归同文案）
QUERY_INSTRUCT = "为这个句子生成表示以用于检索相关的个人记忆、笔记与剪贴板内容："
DIMENSION = 2048
EMBED_BATCH = 8
MAX_FRAME_BYTES = 64 * 1024 * 1024  # 视频 base64 单段 ~2.7MB，余量充足

_processor = None
_model = None
_device = "cpu"


def log(msg):
    print(f"[wemm {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def send(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_frame():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"帧超长 {length}")
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def load_model():
    global _processor, _model, _device
    import torch
    from transformers import AutoModel, AutoProcessor

    if not torch.cuda.is_available():
        send({"type": "error", "error": "gpu_required",
              "detail": "N1 阶段 WeMM sidecar 需要 NVIDIA GPU（≥6GB 显存）"})
        sys.exit(2)

    model_dir = os.environ.get(
        "NERVIS_WEMM_MODEL_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"),
    )
    _device = "cuda"
    _processor = AutoProcessor.from_pretrained(model_dir, trust_remote_code=True)
    # 必须显式 trust_remote_code（N0 坑3：主线裸类无 embedding()）
    _model = AutoModel.from_pretrained(
        model_dir, dtype=torch.bfloat16, trust_remote_code=True
    )
    _model.eval().to(_device)
    send({"type": "ready", "device": _device, "dimension": DIMENSION})
    log(f"模型就绪（bf16, VRAM {torch.cuda.memory_allocated()/2**30:.1f}GB）")


def _encode(messages):
    """N0 spike 验证路径：chat template -> processor(padding) -> embedding -> L2 归一化"""
    import torch
    import torch.nn.functional as F
    from qwen_vl_utils import process_vision_info

    prompt = _processor.apply_chat_template(
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
    inputs = _processor(
        text=prompt,
        images=images,
        videos=videos,
        video_metadata=video_metadata,
        padding=True,
        return_tensors="pt",
        **video_kwargs,
    ).to(_device)
    with torch.inference_mode():
        emb = _model.embedding(**inputs).float()
    return F.normalize(emb, p=2, dim=-1)


def _text_messages(text):
    return [{"role": "user", "content": [{"type": "text", "text": text}]}]


def embed_documents(texts):
    out = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i : i + EMBED_BATCH]
        emb = _encode([_text_messages(t) for t in batch])
        out.extend(emb.tolist())
        log(f"embed_documents {i + len(batch)}/{len(texts)}")
    return out


def embed_query(text):
    emb = _encode([_text_messages(QUERY_INSTRUCT + text)])
    return emb[0].tolist()


def _write_temp(b64, suffix):
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(base64.b64decode(b64))
    return path


def embed_media(b64, mime, kind):
    # 剥离 data URI 前缀（调用方可能传 data:image/png;base64,... 格式）
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    suffix = {"image": ".png", "video": ".webm"}[kind]
    if mime and "/" in mime:
        suffix = "." + mime.split("/", 1)[1].split(";")[0]
    path = _write_temp(b64, suffix)
    try:
        msg = [{"role": "user", "content": [{"type": kind, kind: path}]}]
        emb = _encode(msg)
        return emb[0].tolist()
    finally:
        os.unlink(path)


def handle(req):
    rtype = req.get("type")
    if rtype == "ping":
        return {"pong": True}
    if rtype == "embed_documents":
        return {"vectors": embed_documents(req["texts"])}
    if rtype == "embed_query":
        return {"vector": embed_query(req["text"])}
    if rtype == "embed_image":
        return {"vector": embed_media(req["image_base64"], req.get("mime"), "image")}
    if rtype == "embed_video":
        return {"vector": embed_media(req["video_base64"], req.get("mime"), "video")}
    if rtype == "shutdown":
        send({"ok": True, "req_id": req.get("req_id")})
        sys.exit(0)
    raise ValueError(f"未知请求类型 {rtype}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    send({"type": "loading"})
    load_model()
    while True:
        try:
            req = read_frame()
        except (ValueError, json.JSONDecodeError) as e:
            send({"ok": False, "error": f"帧解析失败: {e}"})
            continue
        if req is None:
            break  # stdin 关闭，父进程已退出
        try:
            result = handle(req)
            send({"ok": True, "req_id": req.get("req_id"), "result": result})
        except Exception as e:  # 推理错误不致命，回包继续服务
            log(f"请求失败: {e}")
            send({"ok": False, "req_id": req.get("req_id"), "error": str(e)})


if __name__ == "__main__":
    main()
