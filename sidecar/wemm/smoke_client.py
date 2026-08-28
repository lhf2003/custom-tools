# sidecar 协议 smoke 客户端：发帧验证握手与各类请求（手测工具，非生产代码）
import json
import os
import struct
import subprocess
import sys
import time

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
MODEL = os.environ.get(
    "NERVIS_WEMM_MODEL_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "spikes", "wemm-local", "models"),
)


def send(proc, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    proc.stdin.write(struct.pack("<I", len(data)) + data)
    proc.stdin.flush()


def recv(proc):
    header = proc.stdout.read(4)
    (length,) = struct.unpack("<I", header)
    return json.loads(proc.stdout.read(length).decode("utf-8"))


def main():
    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "NERVIS_WEMM_MODEL_DIR": os.path.abspath(MODEL)},
    )
    while True:
        msg = recv(proc)
        print("<", msg.get("type", msg))
        if msg.get("type") == "ready":
            break
        if msg.get("type") == "error":
            sys.exit(1)

    t0 = time.perf_counter()
    send(proc, {"type": "ping", "req_id": 1})
    print("< ping:", recv(proc), f"({time.perf_counter()-t0:.3f}s)")

    t0 = time.perf_counter()
    send(proc, {"type": "embed_query", "text": "JVM 是解释执行还是编译执行", "req_id": 2})
    resp = recv(proc)
    vec = resp["result"]["vector"]
    print(f"< query: dim={len(vec)} first3={[round(v,4) for v in vec[:3]]} ({time.perf_counter()-t0:.3f}s)")

    t0 = time.perf_counter()
    send(proc, {"type": "embed_documents", "texts": ["第一段测试文本", "第二段明显更长一些的测试文本内容"], "req_id": 3})
    resp = recv(proc)
    print(f"< docs: n={len(resp['result']['vectors'])} dim={len(resp['result']['vectors'][0])} ({time.perf_counter()-t0:.3f}s)")

    send(proc, {"type": "shutdown", "req_id": 4})
    print("<", recv(proc))
    proc.wait(timeout=10)
    print("exit code:", proc.returncode)


if __name__ == "__main__":
    main()
