# 模拟浏览器 native messaging：给 memory-host 发 index_video 帧，打印 host 真实响应
# 用法: python scripts/test_index_video.py [webm_path]
import base64
import json
import os
import struct
import subprocess
import sys

WEBM = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\23851\AppData\Local\Temp\test_live.webm"
HOST = r"D:\workspace\custom-tools\src-tauri\target\release\memory-host.exe"


def send(proc, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(data)))
    proc.stdin.write(data)
    proc.stdin.flush()


def recv(proc):
    header = proc.stdout.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(proc.stdout.read(length).decode("utf-8"))


def main():
    b64 = base64.b64encode(open(WEBM, "rb").read()).decode()
    print(f"webm: {WEBM}, base64 len={len(b64)}")

    # stderr 写文件而非 PIPE：sidecar 模型加载进度条输出量大，PIPE 无人读会管道死锁
    err_log = open(os.path.join(os.environ["TEMP"], "test_index_video_stderr.log"), "w", encoding="utf-8")
    proc = subprocess.Popen(
        [HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=err_log,
    )
    req = {
        "type": "index_video",
        "url": "https://www.bilibili.com/video/BV1RqtP6rEXK",
        "domain": "www.bilibili.com",
        "title": "链路测试视频",
        "start_seconds": 18,
        "end_seconds": 28,
        "captured_seconds": 10.0,
        "video_base64": b64,
        "created_at": "2026-08-29T09:30:00",
        "req_id": 99,
    }
    send(proc, req)
    resp = recv(proc)
    print("host response:", json.dumps(resp, ensure_ascii=False)[:500] if resp else None)
    proc.kill()
    err_log.close()
    with open(err_log.name, encoding="utf-8", errors="replace") as f:
        err = f.read()
    if err.strip():
        print("--- stderr tail ---")
        print(err[-2000:])


if __name__ == "__main__":
    main()
