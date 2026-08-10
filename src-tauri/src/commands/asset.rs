//! asset 协议（asset://）的运行时授权。
//!
//! 静态 scope（tauri.conf.json）只放行插件目录（图标用）；剪贴板媒体文件在
//! 用户任意路径，无法静态穷举——播放前由前端先调本命令按需放行单个文件，
//! 再经 convertFileSrc 读取。避免全局 `**` 放开任意本地文件读取。

use tauri::{AppHandle, Manager};

/// 放行 asset 协议读取单个文件（剪贴板音频/视频播放用）。
/// 只注册该文件本身，不递归放行目录；重复放行幂等。
#[tauri::command]
pub fn allow_asset_file(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| format!("放行资源失败: {}", e))
}
