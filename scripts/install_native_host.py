# M2: 注册 native messaging host（Chrome + Edge）
# 用法:
#   python scripts/install_native_host.py --extension-id <扩展ID>   # 安装/更新
#   python scripts/install_native_host.py --uninstall               # 卸载
# 说明: 扩展 ID 在 chrome://extensions 开发者模式加载扩展后可见；
#       manifest 写入 extension/native-host/，注册表 HKCU 无需管理员权限。
import argparse
import json
import sys
import winreg
from pathlib import Path

HOST_NAME = "com.nervis.memory"
REPO = Path(__file__).resolve().parent.parent
MANIFEST_DIR = REPO / "extension" / "native-host"
DEFAULT_HOST_BIN = REPO / "src-tauri" / "target" / "release" / "memory-host.exe"

REG_PATHS = [
    "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
    "Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME,
]


def install(extension_id: str, host_bin: Path) -> None:
    if not host_bin.exists():
        sys.exit(f"host 二进制不存在: {host_bin}\n先执行: cargo build -p nervis-memory --release")

    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = MANIFEST_DIR / f"{HOST_NAME}.json"
    manifest = {
        "name": HOST_NAME,
        "description": "Nervis memory indexing host (native messaging)",
        "path": str(host_bin),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"manifest -> {manifest_path}")

    for reg_path in REG_PATHS:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path)
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
        winreg.CloseKey(key)
        print(f"registry -> HKCU\\{reg_path}")
    print("完成。重启浏览器后扩展即可连接 memory-host。")


def uninstall() -> None:
    for reg_path in REG_PATHS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, reg_path)
            print(f"removed HKCU\\{reg_path}")
        except FileNotFoundError:
            print(f"skip(不存在) HKCU\\{reg_path}")
    manifest_path = MANIFEST_DIR / f"{HOST_NAME}.json"
    if manifest_path.exists():
        manifest_path.unlink()
        print(f"removed {manifest_path}")
    print("卸载完成。")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--extension-id", help="扩展 ID（chrome://extensions 可见）")
    ap.add_argument("--host-bin", type=Path, default=DEFAULT_HOST_BIN, help="memory-host.exe 路径")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    if args.uninstall:
        uninstall()
    else:
        if not args.extension_id:
            ap.error("安装必须提供 --extension-id")
        install(args.extension_id, args.host_bin)


if __name__ == "__main__":
    main()
