use std::time::Duration;

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;

use crate::db::DatabaseState;
use crate::http;

/// 托管仓库（与 tauri.conf.json 的 updater endpoint 保持一致）
const GITHUB_REPO: &str = "lhf2003/custom-tools";

/// GitHub Releases API 响应（只取需要的字段）
#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    published_at: Option<String>,
    body: Option<String>,
    prerelease: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangelogEntry {
    pub version: String,
    pub release_date: Option<String>,
    pub content: String,
    pub is_read: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VersionCheckResult {
    pub current_version: String,
    pub has_new_version: bool,
    pub unread_changelogs: Vec<ChangelogEntry>,
}

/// Get database connection from app state
fn get_db_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_state = app
        .try_state::<DatabaseState>()
        .ok_or("Database state not found")?;
    Connection::open(&db_state.0).map_err(|e| format!("Failed to open database: {}", e))
}

/// Add or update a changelog entry
#[tauri::command]
pub fn add_changelog(
    app: AppHandle,
    version: String,
    release_date: Option<String>,
    content: String,
) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute(
        "INSERT OR REPLACE INTO changelog (version, release_date, content, is_read, created_at)
         VALUES (?1, ?2, ?3, 0, CURRENT_TIMESTAMP)",
        params![version, release_date, content],
    )
    .map_err(|e| format!("Failed to add changelog: {}", e))?;

    Ok(())
}

/// Mark all changelogs as read
#[tauri::command]
pub fn mark_all_changelogs_read(app: AppHandle) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute("UPDATE changelog SET is_read = 1", [])
        .map_err(|e| format!("Failed to mark all changelogs as read: {}", e))?;

    Ok(())
}

/// Check if there are unread changelogs for the current version
#[tauri::command]
pub fn check_version_changelog(app: AppHandle) -> Result<VersionCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let conn = get_db_connection(&app)?;

    // Check if current version has an unread changelog
    let unread_changelogs: Vec<ChangelogEntry> = conn
        .prepare(
            "SELECT version, release_date, content, is_read, created_at FROM changelog
             WHERE version = ?1 AND is_read = 0
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?
        .query_map(params![current_version], |row| {
            Ok(ChangelogEntry {
                version: row.get(0)?,
                release_date: row.get(1)?,
                content: row.get(2)?,
                is_read: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query changelog: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect changelogs: {}", e))?;

    let has_new_version = !unread_changelogs.is_empty();

    Ok(VersionCheckResult {
        current_version,
        has_new_version,
        unread_changelogs,
    })
}

/// Delete old changelog entries (keep only last N versions)
#[tauri::command]
pub fn cleanup_old_changelogs(app: AppHandle, keep_count: i64) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute(
        "DELETE FROM changelog WHERE version NOT IN (
            SELECT version FROM changelog ORDER BY created_at DESC LIMIT ?1
        )",
        params![keep_count],
    )
    .map_err(|e| format!("Failed to cleanup old changelogs: {}", e))?;

    Ok(())
}

/// 拉取 GitHub Releases 并增量合并进 changelog 表。
/// UPSERT 只更新日期与正文，保留既有 is_read（已读状态不能被同步覆盖）。
/// 跳过 prerelease 与无正文（release body 为空）的版本。
#[tauri::command]
pub async fn sync_releases_changelog(app: AppHandle) -> Result<usize, String> {
    let client = http::build_client(Duration::from_secs(15))?;
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=30");
    let resp = client
        .get(&url)
        .header("User-Agent", "FlowHub")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API error: {}", resp.status()));
    }
    let releases: Vec<GithubRelease> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases: {e}"))?;

    let conn = get_db_connection(&app)?;
    let mut synced = 0usize;
    for rel in releases {
        if rel.prerelease {
            continue;
        }
        let body = match rel.body {
            Some(b) if !b.trim().is_empty() => b,
            _ => continue,
        };
        let version = rel.tag_name.trim_start_matches('v').to_string();
        // GitHub 的 published_at 为 UTC ISO8601，按系统时区转为本地日期时间存储
        let release_date = rel
            .published_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string());
        conn.execute(
            "INSERT INTO changelog (version, release_date, content, is_read, created_at)
             VALUES (?1, ?2, ?3, 0, CURRENT_TIMESTAMP)
             ON CONFLICT(version) DO UPDATE SET
               release_date = excluded.release_date,
               content = excluded.content",
            params![version, release_date, body],
        )
        .map_err(|e| format!("Failed to upsert changelog: {e}"))?;
        synced += 1;
    }
    Ok(synced)
}

/// 全量读取 changelog 表（关于页「更新日志」，按发布日期倒序，release_date 为空排最后）
#[tauri::command]
pub fn list_changelogs(app: AppHandle) -> Result<Vec<ChangelogEntry>, String> {
    let conn = get_db_connection(&app)?;

    let entries: Vec<ChangelogEntry> = conn
        .prepare(
            "SELECT version, release_date, content, is_read, created_at FROM changelog
             ORDER BY release_date IS NULL, release_date DESC, created_at DESC
             LIMIT 50",
        )
        .map_err(|e| format!("Failed to prepare query: {e}"))?
        .query_map([], |row| {
            Ok(ChangelogEntry {
                version: row.get(0)?,
                release_date: row.get(1)?,
                content: row.get(2)?,
                is_read: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query changelog: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect changelogs: {e}"))?;

    Ok(entries)
}

/// 内置历史日志（0.1.0~0.3.3，GitHub 上无 Release body 的旧版本，作为归档不触发未读）。
/// INSERT OR IGNORE 幂等，启动时调用无副作用。
pub fn seed_history(app: &AppHandle) -> Result<(), String> {
    const HISTORY: &[(&str, &str, &str)] = &[
        (
            "0.3.3",
            "2026-04-04 00:00:00",
            "- 将 Vditor 静态资源打包到应用，解决生产环境 404 问题",
        ),
        (
            "0.3.2",
            "2026-04-03 00:00:00",
            "- 实现文件日志系统，支持 1MB 轮转、30 天过期清理及前端日志收集\n\
             - 剪贴板历史支持分页加载，默认 100 条，滚动自动加载更多\n\
             - Markdown 编辑器新增全屏模式，优化代码块样式与复制按钮\n\
             - 优化 Markdown 笔记右键菜单\n\
             - 统一更新通知为系统通知，托盘右键「显示」改为「设置」入口",
        ),
        (
            "0.3.1",
            "2026-04-02 00:00:00",
            "- Markdown 笔记记住上次打开的笔记和展开文件夹状态\n\
             - 统一窗口尺寸配置，添加剪贴板键盘导航\n\
             - 统一主题颜色系统，提取硬编码颜色为语义化 Token\n\
             - 优化搜索排序，频率权重从 30% 提升到 50%\n\
             - 修复 launcher 展开时滚动条闪现问题",
        ),
        (
            "0.2.1",
            "2026-04-02 00:00:00",
            "- 剪贴板交互优化：单击仅选中，双击才复制并排序",
        ),
        (
            "0.1.11",
            "2026-03-27 00:00:00",
            "- 剪贴板功能增强：支持复制排序、实时刷新、部分复制",
        ),
        (
            "0.1.10",
            "2026-03-25 00:00:00",
            "- 修复多显示器窗口位置偏移问题，支持在鼠标所在显示器显示\n\
             - 修复拖拽功能导致滚动条无法滚动的 bug\n\
             - 修复窗口拖拽区域无法移动的问题",
        ),
        (
            "0.1.9",
            "2026-03-25 00:00:00",
            "- 修复毛玻璃效果，简化实现并移除固定背景遮挡\n\
             - 笔记页面标题支持编辑与自动重命名，隐藏 .md 后缀\n\
             - AI 对话页面背景优化\n\
             - 删除剪贴板记录时同步清理图片文件\n\
             - 修复 LRU 缓存迭代器失效导致的清理不彻底问题",
        ),
        (
            "0.1.8",
            "2026-03-25 00:00:00",
            "- LLM 提供商功能开发\n\
             - 修复 Ollama think 参数传递问题",
        ),
        (
            "0.1.7",
            "2026-03-25 00:00:00",
            "- 新增 AI 对话页面，支持流式 LLM 响应与聊天历史持久化\n\
             - 应用品牌统一更名为 FlowHub，更新图标与版本号\n\
             - 重构设置页面，拆分为独立 Tab 组件\n\
             - 左侧笔记栏支持文件名模糊搜索\n\
             - Acrylic 背景模糊效果，升级 windows crate 到 0.61\n\
             - 下拉框智能定位，底部空间不足时自动向上展开",
        ),
        (
            "0.1.6",
            "2026-03-20 00:00:00",
            "- 新增 JSON 格式化工具，支持树形视图与图片导出预览\n\
             - 新增搜索设置 Tab，支持注册表/UWP/自定义目录扫描\n\
             - 前端代码全面重构，消除重复、提升健壮性\n\
             - 修复搜索设置添加目录按钮无效问题",
        ),
        (
            "0.1.5",
            "2026-03-20 00:00:00",
            "- 修复 Everything 搜索触发时命令行闪窗问题\n\
             - 优化文件搜索性能",
        ),
        (
            "0.1.4",
            "2026-03-20 00:00:00",
            "- 完善 Everything 文件搜索集成功能\n\
             - 新增更新日志页面，优化自动更新流程\n\
             - 将默认启动快捷键改为 Alt+Space",
        ),
        (
            "0.1.3",
            "2026-03-19 00:00:00",
            "- 修复自动更新无法检测新版本的问题\n\
             - 修复应用启动时弹出 cmd 窗口的问题",
        ),
        (
            "0.1.2",
            "2026-03-19 00:00:00",
            "- 新增拼音首字母搜索支持\n\
             - 修复剪贴板自动粘贴功能\n\
             - 优化 Everything 未安装页面样式",
        ),
        (
            "0.1.1",
            "2026-03-19 00:00:00",
            "- 实现系统级窗口模糊效果（Mica/Blur）与自动更新功能\n\
             - 实现开机自启功能\n\
             - 使用 dnd-kit 重构笔记目录拖拽\n\
             - 优化密码管理 UI，支持系统浏览器打开 URL\n\
             - 优化最近使用排序，点击后立即置顶",
        ),
        (
            "0.1.0",
            "2026-03-19 00:00:00",
            "- 项目初始版本发布\n\
             - 新增剪贴板图片支持（缩略图显示与粘贴功能）\n\
             - Markdown 编辑器集成所见即所得（WYSIWYG）功能\n\
             - 实现搜索使用频率排序与应用索引持久化缓存\n\
             - 集成 Everything 文件搜索（后端 + 前端）",
        ),
    ];

    let conn = get_db_connection(app)?;
    for (version, date, content) in HISTORY {
        conn.execute(
            "INSERT OR IGNORE INTO changelog (version, release_date, content, is_read, created_at)
             VALUES (?1, ?2, ?3, 1, CURRENT_TIMESTAMP)",
            params![version, date, content],
        )
        .map_err(|e| format!("Failed to seed changelog {version}: {e}"))?;
    }
    Ok(())
}
