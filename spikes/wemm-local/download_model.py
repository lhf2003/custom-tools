# N0 spike 轨2：下载 WeMM-Embedding-2B（走 hf-mirror 镜像，官方站国内不可达）
import os
import sys

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_DISABLE_XET"] = "1"  # xet 后端不走镜像，401，回退普通 HTTP

from huggingface_hub import snapshot_download

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def main():
    path = snapshot_download(
        "tencent/WeMM-Embedding-2B",
        local_dir=TARGET,
        max_workers=4,
    )
    print("downloaded to:", path)


if __name__ == "__main__":
    sys.exit(main())
