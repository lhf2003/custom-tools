//! 设置页「统计」页签数据源：模型调用观测（筛选聚合/明细/筛选项）与本地数据空间。

use std::path::{Path, PathBuf};

use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use tauri::{Manager, State};

use crate::db::DatabaseState;

// ── 模型调用观测 ─────────────────────────────────────────────

/// 模型下拉里代表 Claude Code 通道的伪模型值：
/// CC 通道的调用日志 model 字段为 NULL，只能按通道筛
pub const CLAUDE_CODE_MODEL_VALUE: &str = "__claude_code__";

/// 调用观测筛选条件：source/model 为 None = 全部；时间窗 [since, until)
#[derive(Debug, serde::Deserialize)]
pub struct ObserveFilter {
    pub source: Option<String>,
    pub model: Option<String>,
    pub since: i64,
    pub until: i64,
}

#[derive(Debug, Serialize)]
pub struct ObservabilitySummary {
    pub total_tokens: u64,
    pub model_calls: u64,
    pub tool_calls: u64,
    pub errors: u64,
}

#[derive(Debug, Serialize)]
pub struct SourceStatRow {
    pub source: String,
    pub calls: u64,
    pub errors: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub cost_cny: f64,
    pub total_duration_ms: u64,
    pub tool_calls: u64,
}

#[derive(Debug, Serialize)]
pub struct ObservabilityResult {
    pub summary: ObservabilitySummary,
    pub rows: Vec<SourceStatRow>,
}

#[derive(Debug, Serialize)]
pub struct CallLogRow {
    pub id: i64,
    pub source: String,
    pub channel: String,
    pub scene: Option<String>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub cost_cny: f64,
    pub duration_ms: u64,
    pub tool_call_count: u64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ModelOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct ModelGroup {
    pub provider: String,
    pub models: Vec<ModelOption>,
}

#[derive(Debug, Serialize)]
pub struct ObserveOptions {
    pub sources: Vec<String>,
    pub model_groups: Vec<ModelGroup>,
}

/// 组装 WHERE 子句与参数（source/model 可选，时间窗必带）
fn build_where(filter: &ObserveFilter) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut parts = vec!["created_at >= ?".to_string(), "created_at < ?".to_string()];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(filter.since), Box::new(filter.until)];
    if let Some(source) = &filter.source {
        parts.push("source = ?".to_string());
        params.push(Box::new(source.clone()));
    }
    match &filter.model {
        Some(m) if m == CLAUDE_CODE_MODEL_VALUE => {
            parts.push("channel = 'claude_code'".to_string());
        }
        Some(m) => {
            parts.push("model = ?".to_string());
            params.push(Box::new(m.clone()));
        }
        None => {}
    }
    (parts.join(" AND "), params)
}

/// 调用观测：看板四数（token 总计/模型调用/工具调用/调用错误）+ 按来源聚合行
#[tauri::command]
pub fn get_llm_observability(
    db_state: State<'_, DatabaseState>,
    filter: ObserveFilter,
) -> Result<ObservabilityResult, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let (where_sql, params) = build_where(&filter);
    let params_ref: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let summary_sql = format!(
        "SELECT COUNT(*),
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(tool_call_count), 0)
         FROM llm_call_logs WHERE {}",
        where_sql
    );
    let summary = conn
        .query_row(&summary_sql, params_from_iter(params_ref.iter()), |row| {
            let calls = row.get::<_, i64>(0)? as u64;
            let input = row.get::<_, i64>(2)? as u64;
            let output = row.get::<_, i64>(3)? as u64;
            Ok(ObservabilitySummary {
                total_tokens: input + output,
                model_calls: calls,
                tool_calls: row.get::<_, i64>(4)? as u64,
                errors: row.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
            })
        })
        .map_err(|e| format!("汇总查询失败: {}", e))?;

    let rows_sql = format!(
        "SELECT source,
                COUNT(*),
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(cached_input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cost_cny), 0),
                COALESCE(SUM(duration_ms), 0),
                COALESCE(SUM(tool_call_count), 0)
         FROM llm_call_logs WHERE {}
         GROUP BY source
         ORDER BY COUNT(*) DESC",
        where_sql
    );
    let mut stmt = conn
        .prepare(&rows_sql)
        .map_err(|e| format!("准备聚合查询失败: {}", e))?;
    let rows = stmt
        .query_map(params_from_iter(params_ref.iter()), |row| {
            Ok(SourceStatRow {
                source: row.get(0)?,
                calls: row.get::<_, i64>(1)? as u64,
                errors: row.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                input_tokens: row.get::<_, i64>(3)? as u64,
                cached_input_tokens: row.get::<_, i64>(4)? as u64,
                output_tokens: row.get::<_, i64>(5)? as u64,
                cost_cny: row.get(6)?,
                total_duration_ms: row.get::<_, i64>(7)? as u64,
                tool_calls: row.get::<_, i64>(8)? as u64,
            })
        })
        .map_err(|e| format!("聚合查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取聚合结果失败: {}", e))?;

    Ok(ObservabilityResult { summary, rows })
}

/// 展开行明细：某来源在筛选条件下的逐条调用日志（按时间倒序）
#[tauri::command]
pub fn get_llm_call_logs(
    db_state: State<'_, DatabaseState>,
    filter: ObserveFilter,
    limit: Option<u32>,
) -> Result<Vec<CallLogRow>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let (where_sql, params) = build_where(&filter);
    let mut params_ref: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let limit_value = limit.unwrap_or(50).min(500) as i64;
    params_ref.push(&limit_value);

    let sql = format!(
        "SELECT id, source, channel, scene, model,
                input_tokens, cached_input_tokens, output_tokens,
                cost_cny, duration_ms, tool_call_count, status, error, created_at
         FROM llm_call_logs WHERE {}
         ORDER BY created_at DESC
         LIMIT ?",
        where_sql
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备日志查询失败: {}", e))?;
    let rows = stmt
        .query_map(params_from_iter(params_ref), |row| {
            Ok(CallLogRow {
                id: row.get(0)?,
                source: row.get(1)?,
                channel: row.get(2)?,
                scene: row.get(3)?,
                model: row.get(4)?,
                input_tokens: row.get::<_, i64>(5)? as u64,
                cached_input_tokens: row.get::<_, i64>(6)? as u64,
                output_tokens: row.get::<_, i64>(7)? as u64,
                cost_cny: row.get(8)?,
                duration_ms: row.get::<_, i64>(9)? as u64,
                tool_call_count: row.get::<_, i64>(10)? as u64,
                status: row.get(11)?,
                error: row.get(12)?,
                created_at: row.get(13)?,
            })
        })
        .map_err(|e| format!("日志查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取日志结果失败: {}", e))?;
    Ok(rows)
}

/// 筛选项：有真实调用记录的来源列表 + 有记录的模型（按提供商分组，含 CC 通道伪组）
#[tauri::command]
pub fn get_llm_observe_options(
    db_state: State<'_, DatabaseState>,
) -> Result<ObserveOptions, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| format!("打开数据库失败: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT DISTINCT source FROM llm_call_logs ORDER BY source")
        .map_err(|e| format!("准备来源查询失败: {}", e))?;
    let sources = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("来源查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取来源失败: {}", e))?;

    // 日志中真实出现过的模型
    let mut stmt = conn
        .prepare("SELECT DISTINCT model FROM llm_call_logs WHERE model IS NOT NULL ORDER BY model")
        .map_err(|e| format!("准备模型查询失败: {}", e))?;
    let logged_models = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("模型查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取模型失败: {}", e))?;

    // 已配置模型的显示名与提供商归属
    let mut stmt = conn
        .prepare(
            "SELECT m.model_id, m.name, p.label
             FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id",
        )
        .map_err(|e| format!("准备配置查询失败: {}", e))?;
    let configured = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("配置查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取配置失败: {}", e))?;

    // 按提供商分组；日志里有但配置已删的模型归入「未配置」
    let mut groups: Vec<ModelGroup> = Vec::new();
    let mut unconfigured: Vec<ModelOption> = Vec::new();
    for model_id in logged_models {
        match configured.iter().find(|(id, _, _)| id == &model_id) {
            Some((_, name, provider_label)) => {
                let group = match groups.iter_mut().find(|g| g.provider == *provider_label) {
                    Some(g) => g,
                    None => {
                        groups.push(ModelGroup {
                            provider: provider_label.clone(),
                            models: Vec::new(),
                        });
                        groups.last_mut().expect("刚刚 push 的分组必然存在")
                    }
                };
                group.models.push(ModelOption {
                    value: model_id,
                    label: name.clone(),
                });
            }
            None => unconfigured.push(ModelOption {
                label: model_id.clone(),
                value: model_id,
            }),
        }
    }
    if !unconfigured.is_empty() {
        groups.push(ModelGroup {
            provider: "未配置".to_string(),
            models: unconfigured,
        });
    }

    let has_cc: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM llm_call_logs WHERE channel = 'claude_code')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if has_cc {
        groups.insert(
            0,
            ModelGroup {
                provider: "Claude Code".to_string(),
                models: vec![ModelOption {
                    value: CLAUDE_CODE_MODEL_VALUE.to_string(),
                    label: "Claude Code CLI".to_string(),
                }],
            },
        );
    }

    Ok(ObserveOptions {
        sources,
        model_groups: groups,
    })
}

// ── 本地数据空间 ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DataCategory {
    pub key: String,
    pub label: String,
    pub description: String,
    pub bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub cleanable: bool,
}

#[derive(Debug, Serialize)]
pub struct LocalDataStats {
    pub total_bytes: u64,
    pub disk_free_bytes: Option<u64>,
    pub categories: Vec<DataCategory>,
    pub scanned_at: i64,
}

/// 递归统计目录：返回 (字节数, 文件数, 目录数)；跳过符号链接防环
fn walk_size(dir: &Path) -> (u64, u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                dirs += 1;
                stack.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (bytes, files, dirs)
}

/// 核心数据库文件（含 SQLite 的 -wal/-shm 伴生文件）
fn core_db_size(app_data: &Path) -> (u64, u64) {
    const DB_NAMES: [&str; 3] = ["flowhub.db", "settings.db", "shortcuts.db"];
    let mut bytes = 0u64;
    let mut files = 0u64;
    if let Ok(rd) = std::fs::read_dir(app_data) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_db = DB_NAMES
                .iter()
                .any(|db| name == *db || name.starts_with(&format!("{}-", db)));
            if is_db {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        files += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
    }
    (bytes, files)
}

#[cfg(windows)]
fn disk_free_bytes(dir: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root = dir.ancestors().last()?;
    let mut free_bytes: u64 = 0;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            &HSTRING::from(root.as_os_str().to_string_lossy().as_ref()),
            None,
            None,
            Some(&mut free_bytes as *mut u64),
        )
    };
    result.ok().map(|_| free_bytes)
}

#[cfg(not(windows))]
fn disk_free_bytes(_dir: &Path) -> Option<u64> {
    None
}

/// 本地数据空间统计：核心数据库/剪贴板/笔记/陪伴/图标缓存/日志/其他
#[tauri::command]
pub fn get_local_data_stats(app_handle: tauri::AppHandle) -> Result<LocalDataStats, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    let app_local = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("获取本地数据目录失败: {}", e))?;
    let logs_dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("获取日志目录失败: {}", e))?;

    let (db_bytes, db_files) = core_db_size(&app_data);

    // 剪贴板 = 图片附件目录；文本历史在 flowhub.db 内，计入核心数据库
    let (clip_bytes, clip_files, clip_dirs) = walk_size(&app_data.join("clipboard-images"));

    let (notes_bytes, notes_files, notes_dirs) = walk_size(&app_data.join("notes"));

    // 陪伴数据 = 人格/配置目录 + Claude Code Agent 工作区
    let (c1, f1, d1) = walk_size(&app_data.join("companion"));
    let (c2, f2, d2) = walk_size(&app_data.join("companion-agent"));
    let (companion_bytes, companion_files, companion_dirs) = (c1 + c2, f1 + f2, d1 + d2);

    let (icon_bytes, icon_files, icon_dirs) = walk_size(&app_local.join("icon-cache"));
    let (log_bytes, log_files, log_dirs) = walk_size(&logs_dir);

    // 其他：app_data 根下未归类的文件与目录
    let mut other_bytes = 0u64;
    let mut other_files = 0u64;
    let mut other_dirs = 0u64;
    const KNOWN_DIRS: [&str; 4] = ["notes", "companion", "companion-agent", "clipboard-images"];
    const DB_PREFIXES: [&str; 3] = ["flowhub.db", "settings.db", "shortcuts.db"];
    if let Ok(rd) = std::fs::read_dir(&app_data) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !KNOWN_DIRS.contains(&name.as_str()) {
                    let (b, f, d) = walk_size(&entry.path());
                    other_bytes += b;
                    other_files += f;
                    other_dirs += d + 1;
                }
            } else if file_type.is_file()
                && !DB_PREFIXES
                    .iter()
                    .any(|db| name == *db || name.starts_with(&format!("{}-", db)))
            {
                other_files += 1;
                other_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }

    let categories = vec![
        DataCategory {
            key: "core_db".to_string(),
            label: "核心数据库".to_string(),
            description: "剪贴板、密码、笔记索引与模型配置".to_string(),
            bytes: db_bytes,
            file_count: db_files,
            dir_count: 0,
            cleanable: false,
        },
        DataCategory {
            key: "clipboard".to_string(),
            label: "剪贴板".to_string(),
            description: "剪贴板历史的图片附件，文本记录计入核心数据库".to_string(),
            bytes: clip_bytes,
            file_count: clip_files,
            dir_count: clip_dirs,
            cleanable: false,
        },
        DataCategory {
            key: "notes".to_string(),
            label: "笔记文件".to_string(),
            description: "Markdown 笔记与图片附件".to_string(),
            bytes: notes_bytes,
            file_count: notes_files,
            dir_count: notes_dirs,
            cleanable: false,
        },
        DataCategory {
            key: "companion".to_string(),
            label: "陪伴数据".to_string(),
            description: "人格设定、Agent 工作区与陪伴记忆".to_string(),
            bytes: companion_bytes,
            file_count: companion_files,
            dir_count: companion_dirs,
            cleanable: false,
        },
        DataCategory {
            key: "icon_cache".to_string(),
            label: "图标缓存".to_string(),
            description: "应用图标磁盘缓存，清理后按需重建".to_string(),
            bytes: icon_bytes,
            file_count: icon_files,
            dir_count: icon_dirs,
            cleanable: true,
        },
        DataCategory {
            key: "logs".to_string(),
            label: "运行日志".to_string(),
            description: "应用运行日志，当前日志自动保留".to_string(),
            bytes: log_bytes,
            file_count: log_files,
            dir_count: log_dirs,
            cleanable: true,
        },
        DataCategory {
            key: "others".to_string(),
            label: "其他".to_string(),
            description: "未归类的配置与数据文件".to_string(),
            bytes: other_bytes,
            file_count: other_files,
            dir_count: other_dirs,
            cleanable: false,
        },
    ];

    let total_bytes = categories.iter().map(|c| c.bytes).sum();
    Ok(LocalDataStats {
        total_bytes,
        disk_free_bytes: disk_free_bytes(&app_data),
        categories,
        scanned_at: chrono::Local::now().timestamp(),
    })
}

/// 删除目录下全部 *.log 文件（被占用的当前日志跳过），返回释放字节数
fn purge_logs(logs_dir: &Path) -> u64 {
    let mut freed = 0u64;
    if let Ok(rd) = std::fs::read_dir(logs_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("log") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&path).is_ok() {
                freed += size;
            }
        }
    }
    freed
}

/// 清理运行日志：正在写入的当前日志文件因占用自动跳过
#[tauri::command]
pub fn cleanup_app_logs(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let logs_dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("获取日志目录失败: {}", e))?;
    Ok(purge_logs(&logs_dir))
}

/// 清理图标缓存：删除磁盘缓存文件，图标按需重新提取
#[tauri::command]
pub fn cleanup_icon_cache() -> Result<u64, String> {
    let cache_dir = dirs::data_local_dir()
        .ok_or("获取本地数据目录失败")?
        .join(crate::APP_DIR_NAME)
        .join("icon-cache");
    let mut freed = 0u64;
    if let Ok(rd) = std::fs::read_dir(&cache_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(&path).is_ok() {
                    freed += size;
                }
            }
        }
    }
    Ok(freed)
}
