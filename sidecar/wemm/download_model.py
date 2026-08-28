# WeMM 模型下载脚本（生产引导用，随 sidecar 分发）
#
# 用法: python download_model.py <目标目录>
# 走 hf-mirror（官站国内不可达）+ 禁用 xet（xet 后端不走镜像会 401, N0 坑1）。
# snapshot_download 自带断点续传：中断后重跑会跳过已下完的分片。
# 进度由调用方（Rust）轮询目标目录大小估算，本脚本只负责把模型下全。

import os
import sys

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_DISABLE_XET"] = "1"

REPO_ID = "tencent/WeMM-Embedding-2B"


def main():
    if len(sys.argv) < 2:
        print("usage: download_model.py <target_dir>", file=sys.stderr)
        return 1
    target = sys.argv[1]
    os.makedirs(target, exist_ok=True)

    from huggingface_hub import snapshot_download

    path = snapshot_download(REPO_ID, local_dir=target, max_workers=4)
    print(f"downloaded to: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
