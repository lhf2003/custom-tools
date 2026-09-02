# nervis WeMM sidecar —— 多模态 embedding 推理服务
#
# 协议：stdin/stdout 传 [u32 LE 长度][JSON] 帧（与 memory-host native messaging 同格式，D1）。
# 生命周期由 Rust 侧管理（按需拉起、空闲退出、shutdown 命令），本进程模型常驻。
#
# 进程唯一性（TCP 代理共享，CASE-009）：
#   第一个实例绑定 127.0.0.1:47812 成为主实例（加载模型占显存 + TCP 监听）。
#   后续实例检测到端口已占用 → 代理模式：不加载模型（零显存），stdin 帧转发到主实例 TCP。
#   代理收到 shutdown 只退出自己（不杀主实例）；主实例退出后下一个 spawn 自动成为新主实例。
#   Rust 侧零改动——握手/帧协议对主/代理完全透明。
#
# 启动握手：主实例 loading → ready；代理直接 ready（模型已加载）。
# 无 NVIDIA GPU（D7：N1 只保 GPU）发 {"type":"error","error":"gpu_required"} 后退出码 2。
#
# 请求（type 字段）：
#   ping                                              -> {"ok":true}
#   embed_documents {texts:[...]}                     -> result.vectors [[f32;2048]...]（语料侧，无 instruct）
#   embed_query {text}                                -> result.vector [f32;2048]（查询侧，固定 instruct 前缀，N0 规范）
#   embed_image {image_base64, mime}                  -> result.vector
#   embed_video {video_base64, mime}                    -> result.vector
#     解码走 PyAV 顺序解码（N3 坑：MediaRecorder webm 元数据残缺，decord 帧索引路线硬失败）
#   embed_video_url {video_url, referer, segment_secs}  -> result.segments [{start, vector}...]
#     整视频后台索引：PyAV 直接流式打开 CDN 地址（ffmpeg headers 选项带 Referer/UA），
#     按 segment_secs 窗口水库抽样 VIDEO_NFRAMES 帧（内存恒定），逐窗口 embed
#   shutdown                                          -> {"ok":true} 后退出码 0（代理模式只退自己不转发）
#
# 维度固定 2048 全维（N0：512 截断裸查询不过线已弃用）；模型 bf16（8GB 显卡约束）。

import base64
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# N0 验证的检索指令（查询侧固定前缀，语料侧不加；与 qwen3-vl API 回归同文案）
QUERY_INSTRUCT = "为这个句子生成表示以用于检索相关的个人记忆、笔记与剪贴板内容："
DIMENSION = 2048
EMBED_BATCH = 8
MAX_FRAME_BYTES = 64 * 1024 * 1024  # 视频 base64 单段 ~2.7MB，余量充足
PRIMARY_PORT = 47812  # 主实例 TCP 监听端口（SO_EXCLUSIVEADDRUSE 保证绑定即唯一）
# 视频帧预算（显存硬约束：处理器 video longest_edge=224MP 不缩放，720p×32≈2.9万 token 必 OOM）
VIDEO_NFRAMES = 32
VIDEO_MAX_W = 720
VIDEO_MAX_H = 360

_processor = None
_model = None
_device = "cpu"
_model_lock = threading.Lock()  # GPU 模型非线程安全：主实例 stdio/TCP 两路请求串行化

# 主实例生命周期自治（CASE-009 共享语义）：Rust watchdog 只统计 owner 自己 stdio 通道的
# 活动，看不见 TCP 代理通道的使用——曾致 21:17 误杀事故（主线程 30min 无页面索引，
# watchdog kill 主实例，后台视频索引第 4 块 TCP 被拦腰砍断）。
# 改为 python 侧统计全通道最后活跃，全通道空闲超时才自行退出释放显存。
_last_activity = time.time()
IDLE_EXIT_SECS = 30 * 60


def _touch():
    global _last_activity
    _last_activity = time.time()


def log(msg):
    print(f"[wemm {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ---- stdio 帧读写（Rust ⇄ 本进程） ----

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


# ---- TCP 帧读写（代理 ⇄ 主实例） ----

def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame_tcp(sock):
    """从 TCP 读一帧，返回解析后的 dict；连接断开返回 None"""
    header = _recv_exact(sock, 4)
    if header is None:
        return None
    (length,) = struct.unpack("<I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"TCP 帧超长 {length}")
    body = _recv_exact(sock, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def write_frame_tcp(sock, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sock.sendall(struct.pack("<I", len(data)) + data)


# ---- 模型 ----

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


def _write_temp(data: bytes, suffix: str):
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _read_video_frames(path, nframes=VIDEO_NFRAMES, max_w=VIDEO_MAX_W, max_h=VIDEO_MAX_H):
    """PyAV 顺序解码全帧 → 降采样（默认 ≤640×360）→ 均匀抽 nframes 帧。
    - 顺序解码不依赖容器元数据/帧索引：MediaRecorder webm（unknown-size、无 Duration/Cues）
      decord 帧计数路线必炸（video_reader.cc:270），PyAV 直接可读（N3 坑）。
    - 降采样是显存硬约束：处理器 video longest_edge=224MP 基本不缩放，720p×32 帧
      ≈ 2.9 万视觉 token，8GB 显存（模型占 5.1GB）OOM；640×360×24 ≈ 5.5k token。
    返回 PIL Image 列表，走 fetch_video 的帧列表路径。"""
    import av

    container = av.open(path)
    try:
        frames = []
        for f in container.decode(video=0):
            img = f.to_image()
            if img.width > max_w or img.height > max_h:
                img.thumbnail((max_w, max_h))  # 保比例缩到框内
            frames.append(img)
    finally:
        container.close()
    total = len(frames)
    if total == 0:
        raise ValueError("视频无帧")
    n = min(nframes, total) // 2 * 2  # temporal_patch_size=2 对齐
    idx = [round(i * (total - 1) / max(n - 1, 1)) for i in range(n)]
    return [frames[i] for i in idx]


def _downscale(img):
    """超过帧预算才缩（LANCZOS 保细节）；640×360 源直出不变"""
    if img.width > VIDEO_MAX_W or img.height > VIDEO_MAX_H:
        img.thumbnail((VIDEO_MAX_W, VIDEO_MAX_H))
    return img


def embed_video_url(video_url, referer, segment_secs=10, skip_segments=0, max_segments=None):
    """整视频后台索引：PyAV 流式打开 CDN 地址（ffmpeg headers 带 Referer/UA），
    按 segment_secs 窗口做水库抽样（每窗最多 VIDEO_NFRAMES 帧，内存恒定），逐窗 embed。
    skip_segments/max_segments 支持分段调用（块间释放模型锁，前台查询不被长任务饿死）。
    返回 {"segments": [{"start", "vector"}], "eof": bool, "next_skip": int}。"""
    import random

    import av

    if not segment_secs or segment_secs <= 0:
        segment_secs = 10
    headers = (f"Referer: {referer}\r\n"
               "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n")
    container = av.open(video_url, options={"headers": headers})
    # 跳过已处理窗口：seek 到 skip 位置前的关键帧（CDN 走 Range），避免每块从头
    # 下载解码的 O(n²) 重下浪费；seek 失败（流不可 seek）回退顺序解码，w<skip 的
    # 帧由下方 continue 过滤，两种路径产出一致
    if skip_segments > 0:
        try:
            container.seek(skip_segments * segment_secs * 1_000_000, backward=True)
        except Exception as e:
            log(f"seek 到 {skip_segments * segment_secs}s 失败，回退顺序解码: {e}")
    rng = random.Random(42)  # 定死种子：同一视频重复索引产出一致
    segments = []
    win_idx = -1
    reservoir = []  # 当前窗口抽样帧 [(t, PIL.Image)]
    seen = 0
    prev_t = 0.0
    eof = True
    limit = None if max_segments is None else skip_segments + max_segments

    def close_window():
        nonlocal reservoir
        if win_idx >= 0 and len(reservoir) >= 2:
            frames = [img for _, img in sorted(reservoir, key=lambda x: x[0])]
            n = len(frames) // 2 * 2  # FRAME_FACTOR=2 对齐
            frames = frames[:n]
            msg = [{"role": "user", "content": [{"type": "video", "video": frames}]}]
            emb = _encode(msg)
            segments.append({"start": win_idx * segment_secs, "vector": emb[0].tolist()})
            log(f"embed_video_url 段 {win_idx}（{n} 帧）完成，累计 {len(segments)} 段")
        reservoir = []

    try:
        for frame in container.decode(video=0):
            t = float(frame.time) if frame.time is not None else prev_t
            prev_t = t
            w = int(t // segment_secs)
            if w < skip_segments:
                continue  # 快过已处理窗口（只解码不驻留，低成本）
            if limit is not None and w >= limit:
                eof = False
                break
            if w != win_idx:
                close_window()
                win_idx, seen = w, 0
            seen += 1
            if len(reservoir) < VIDEO_NFRAMES:
                reservoir.append((t, _downscale(frame.to_image())))
            else:
                j = rng.randrange(seen)
                if j < VIDEO_NFRAMES:
                    reservoir[j] = (t, _downscale(frame.to_image()))
        close_window()
    finally:
        container.close()
    next_skip = limit if limit is not None and not eof else win_idx + 1
    return {"segments": segments, "eof": eof, "next_skip": next_skip}


def embed_media(b64, mime, kind):
    # 剥离 data URI 前缀（调用方可能传 data:image/png;base64,... 格式）
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    suffix = {"image": ".png", "video": ".webm"}[kind]
    if mime and "/" in mime:
        suffix = "." + mime.split("/", 1)[1].split(";")[0]
    raw = base64.b64decode(b64)
    path = _write_temp(raw, suffix)
    try:
        if kind == "video":
            try:
                frames = _read_video_frames(path)
            except Exception:
                # 现场取证：浏览器链路 stderr 不可见，失败样本落盘供离线分析
                dbg = os.path.join(tempfile.gettempdir(), "nervis_wemm_debug")
                os.makedirs(dbg, exist_ok=True)
                with open(os.path.join(dbg, "fail.webm"), "wb") as f:
                    f.write(raw)
                with open(os.path.join(dbg, "diag.json"), "w", encoding="utf-8") as f:
                    json.dump({"mime": mime, "bytes": len(raw)}, f)
                log(f"视频解码失败，样本已写入 {dbg}")
                raise
            msg = [{"role": "user", "content": [{"type": "video", "video": frames}]}]
        else:
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
    if rtype == "embed_video_url":
        return embed_video_url(
            req["video_url"],
            req.get("referer") or "https://www.bilibili.com",
            req.get("segment_secs") or 10,
            req.get("skip_segments") or 0,
            req.get("max_segments"),
        )
    if rtype == "shutdown":
        send({"ok": True, "req_id": req.get("req_id")})
        sys.exit(0)
    raise ValueError(f"未知请求类型 {rtype}")


# ---- 主实例模式（加载模型 + TCP 监听代理连接） ----

def tcp_handler(conn):
    """处理一个代理连接：读帧 → 加锁调 handle → 写响应"""
    try:
        while True:
            req = read_frame_tcp(conn)
            if req is None:
                break
            _touch()  # TCP 通道活动计入自治计时（请求到达即算，不等处理完）
            # shutdown 不允许从 TCP 通道杀主实例（代理侧已过滤，这里防御性忽略）
            if req.get("type") == "shutdown":
                write_frame_tcp(conn, {"ok": True, "req_id": req.get("req_id")})
                continue
            with _model_lock:
                try:
                    result = handle(req)
                    resp = {"ok": True, "req_id": req.get("req_id"), "result": result}
                except Exception as e:
                    log(f"TCP 请求失败: {e}")
                    resp = {"ok": False, "req_id": req.get("req_id"), "error": str(e)}
            _touch()
            write_frame_tcp(conn, resp)
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    finally:
        conn.close()


def primary_mode(listener):
    send({"type": "loading"})
    load_model()

    # 自治空闲退出：全通道（stdio+TCP）30min 无请求 → 自行退出释放显存。
    # 必须 os._exit——daemon 线程里 sys.exit 只退线程自己；模型无持久状态，直接退安全。
    # 退出后 Rust 侧 child_alive 检测到死亡，下次调用透明 respawn。
    def idle_watchdog():
        while True:
            time.sleep(60)
            if time.time() - _last_activity > IDLE_EXIT_SECS:
                log("全通道空闲超 30 分钟，主实例自治退出（释放显存）")
                os._exit(0)

    threading.Thread(target=idle_watchdog, daemon=True).start()

    # TCP 监听线程（daemon：主线程退出时自动结束）
    def accept_loop():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                break
            threading.Thread(target=tcp_handler, args=(conn,), daemon=True).start()
    threading.Thread(target=accept_loop, daemon=True).start()
    log(f"主实例模式，TCP 监听 :{PRIMARY_PORT}（帧预算 {VIDEO_NFRAMES}f×{VIDEO_MAX_W}w）")

    # stdio 主循环（owner Rust 进程的直接请求）
    while True:
        try:
            req = read_frame()
        except (ValueError, json.JSONDecodeError) as e:
            send({"ok": False, "error": f"帧解析失败: {e}"})
            continue
        if req is None:
            break  # stdin 关闭，owner 进程已退出
        _touch()
        with _model_lock:
            try:
                result = handle(req)
                send({"ok": True, "req_id": req.get("req_id"), "result": result})
            except Exception as e:
                log(f"请求失败: {e}")
                send({"ok": False, "req_id": req.get("req_id"), "error": str(e)})
        _touch()


# ---- 代理模式（不加载模型，stdin 帧转发到主实例 TCP） ----

def proxy_mode():
    try:
        sock = socket.create_connection(("127.0.0.1", PRIMARY_PORT), timeout=5)
    except OSError:
        # 竞态：检测到时还在，连接时已退出 → 报错让 Rust 清理后重新 spawn
        send({"type": "error", "error": "primary_gone",
              "detail": "WeMM 主实例已退出，请重试"})
        sys.exit(3)
    # create_connection 的 timeout 会残留在 socket 上作用于后续所有 recv/sendall，
    # 视频 embed 单段 130s+，5s 必触发误报「主实例连接断开」→ 连接成功后立即解除
    sock.settimeout(None)

    send({"type": "ready", "device": "proxy", "dimension": DIMENSION})
    log("代理模式（模型由主实例承载）")

    while True:
        try:
            req = read_frame()
        except (ValueError, json.JSONDecodeError) as e:
            send({"ok": False, "error": f"帧解析失败: {e}"})
            continue
        if req is None:
            break  # stdin 关闭，owner 进程已退出
        if req.get("type") == "shutdown":
            send({"ok": True, "req_id": req.get("req_id")})
            break  # 只退自己，不杀主实例
        try:
            write_frame_tcp(sock, req)
            resp = read_frame_tcp(sock)
            if resp is None:
                send({"ok": False, "req_id": req.get("req_id"),
                      "error": "WeMM 主实例连接断开"})
                break
            send(resp)  # 主实例响应已是完整格式，直接透传
        except OSError:
            send({"ok": False, "req_id": req.get("req_id"),
                  "error": "WeMM 主实例连接断开"})
            break
    sock.close()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    # SO_EXCLUSIVEADDRUSE：Windows 上保证端口绑定即进程唯一（防 SO_REUSEADDR 劫持）
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        listener.bind(("127.0.0.1", PRIMARY_PORT))
        listener.listen(4)
    except OSError:
        listener.close()
        proxy_mode()
        return
    primary_mode(listener)


if __name__ == "__main__":
    main()
