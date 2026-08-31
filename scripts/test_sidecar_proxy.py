# sidecar 主/代理双实例测试：spawn 两个 server.py，验证第二个走代理且共享主实例模型
import json
import os
import struct
import subprocess
import sys
import time

PYTHON = r"C:\Users\23851\AppData\Roaming\com.flowhub.app\wemm-venv\Scripts\python.exe"
SERVER = r"D:\workspace\custom-tools\sidecar\wemm\server.py"
ENV = {**os.environ, "NERVIS_WEMM_MODEL_DIR": r"D:\workspace\custom-tools\spikes\wemm-local\models"}


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


def handshake(proc, name):
    """读 loading → ready"""
    t0 = time.time()
    while time.time() - t0 < 120:
        frame = recv(proc)
        if frame is None:
            print(f"[{name}] EOF during handshake")
            return False
        if frame.get("type") == "ready":
            print(f"[{name}] ready (device={frame.get('device')}, {time.time()-t0:.1f}s)")
            return True
        if frame.get("type") == "error":
            print(f"[{name}] error: {frame}")
            return False
        # loading → continue
    print(f"[{name}] handshake timeout")
    return False


def main():
    err1 = open(os.path.join(os.environ["TEMP"], "wemm_s1.log"), "w", encoding="utf-8")
    err2 = open(os.path.join(os.environ["TEMP"], "wemm_s2.log"), "w", encoding="utf-8")

    print("=== spawn instance 1 (expect primary) ===")
    p1 = subprocess.Popen([PYTHON, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=err1, env=ENV)
    if not handshake(p1, "primary"):
        sys.exit(1)

    print("=== spawn instance 2 (expect proxy) ===")
    p2 = subprocess.Popen([PYTHON, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=err2, env=ENV)
    if not handshake(p2, "proxy"):
        sys.exit(1)

    # 代理实例 ping
    send(p2, {"type": "ping", "req_id": 1})
    resp = recv(p2)
    print(f"[proxy] ping -> {resp}")

    # 代理实例 embed_query（走主实例模型）
    send(p2, {"type": "embed_query", "text": "kubectl 部署命令", "req_id": 2})
    resp = recv(p2)
    ok = resp and resp.get("ok") and resp.get("result", {}).get("vector")
    dim = len(resp["result"]["vector"]) if ok else 0
    print(f"[proxy] embed_query -> ok={resp.get('ok') if resp else None}, dim={dim}")

    # 主实例 embed_query（直接）
    send(p1, {"type": "embed_query", "text": "kubectl 部署命令", "req_id": 3})
    resp1 = recv(p1)
    ok1 = resp1 and resp1.get("ok") and resp1.get("result", {}).get("vector")
    dim1 = len(resp1["result"]["vector"]) if ok1 else 0
    print(f"[primary] embed_query -> ok={resp1.get('ok') if resp1 else None}, dim={dim1}")

    # 代理 shutdown：只退自己
    send(p2, {"type": "shutdown", "req_id": 4})
    resp = recv(p2)
    print(f"[proxy] shutdown -> {resp}")
    p2.wait(timeout=5)
    print(f"[proxy] exited, code={p2.returncode}")

    # 主实例还活着
    send(p1, {"type": "ping", "req_id": 5})
    resp = recv(p1)
    print(f"[primary] after proxy shutdown, ping -> {resp}")

    # 主实例 shutdown
    send(p1, {"type": "shutdown", "req_id": 6})
    p1.wait(timeout=5)
    print(f"[primary] exited, code={p1.returncode}")
    print("=== ALL PASS ===")


if __name__ == "__main__":
    main()
