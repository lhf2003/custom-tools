//! 记忆检索命令（知识索引插件：启动器命中探测 k=20 + 知识页全量检索/最近索引浏览）
//! 设计: docs/architecture/2026-09-02-CASE-001-知识索引插件化裁决_01.md（D5 内嵌列表已退役）
//! 二期 N1: bge 进程内 ONNX → WeMM sidecar（CASE-007; 首次查询承担 sidecar 拉起+模型加载 ~15s）。
//!
//! 延迟预算: 查询 embed ~42ms(GPU) + vec0 暴力扫描 ~10ms, spawn_blocking 不阻塞主线程。

use crate::db::DatabaseState;
use nervis_memory::sidecar::{MemoryEmbedder, SidecarEmbedder};
use nervis_memory::store::{self, MemoryItem};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

/// SidecarEmbedder 懒加载容器（首次检索时路径解析, sidecar 子进程按需拉起）
pub struct MemoryEmbedderState(pub std::sync::Arc<Mutex<Option<SidecarEmbedder>>>);

#[derive(Serialize)]
pub struct MemoryHitDto {
    pub id: i64,
    pub source: String,
    /// 来源关联键（剪贴板 id / 笔记路径等）；知识页对无 url 来源按它聚合分组
    pub source_ref: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub snippet: String,
    pub score: f32,
    /// 模态: text | image | video（N2/N3 展示用）
    pub modality: String,
    /// 剪贴板图片的本地文件路径（source=clipboard + modality=image 时从 source_ref join 解析；
    /// 知识页图片卡直接渲染预览。文件已删/解析失败为 None，前端降级占位）
    pub image_path: Option<String>,
    pub created_at: Option<String>,
    pub indexed_at: String,
}

#[derive(Serialize)]
pub struct MemoryOpenResult {
    /// opened_url: 已在后端打开浏览器 | copy_content: 前端复制 content | open_note: 前端跳笔记
    pub action: String,
    pub content: Option<String>,
    pub source_ref: Option<String>,
}

/// 剪贴板图片路径批量解析：source_ref=clipboard-<id> → clipboard_history.content
/// （一次 IN 查询，避免逐条 join；仅收集图片条目，文本剪贴板不查。
///  文件已删（剪贴板历史过期清理）的不给路径，前端走占位降级）
fn resolve_clip_image_paths(
    conn: &Connection,
    items: &[MemoryItem],
) -> Result<std::collections::HashMap<i64, String>, String> {
    let clip_ids: Vec<i64> = items
        .iter()
        .filter(|it| it.source == "clipboard" && it.modality == "image")
        .filter_map(|it| {
            it.source_ref
                .as_deref()
                .and_then(|s| s.strip_prefix("clipboard-"))
                .and_then(|s| s.parse::<i64>().ok())
        })
        .collect();
    if clip_ids.is_empty() {
        return Ok(Default::default());
    }
    let placeholders = vec!["?"; clip_ids.len()].join(",");
    let sql = format!("SELECT id, content FROM clipboard_history WHERE id IN ({placeholders})");
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params_from_iter(clip_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter(|(_, p)| std::path::Path::new(p).exists())
        .collect())
}

/// MemoryItem → DTO（浏览态无相似度，score 填 0）
fn item_to_dto(
    item: MemoryItem,
    score: f32,
    clip_paths: &std::collections::HashMap<i64, String>,
) -> MemoryHitDto {
    let image_path = if item.source == "clipboard" && item.modality == "image" {
        item.source_ref
            .as_deref()
            .and_then(|s| s.strip_prefix("clipboard-"))
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(|cid| clip_paths.get(&cid).cloned())
    } else {
        None
    };
    MemoryHitDto {
        id: item.id,
        source: item.source,
        source_ref: item.source_ref,
        title: item.title,
        url: item.url,
        domain: item.domain,
        snippet: item.content.chars().take(120).collect(),
        score,
        modality: item.modality,
        image_path,
        created_at: item.created_at,
        indexed_at: item.indexed_at,
    }
}

#[tauri::command]
pub async fn memory_search(
    query: String,
    k: Option<usize>,
    state: State<'_, MemoryEmbedderState>,
    db: State<'_, DatabaseState>,
) -> Result<Vec<MemoryHitDto>, String> {
    let db_path = db.0.clone();
    let embedder_arc = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = embedder_arc.lock().map_err(|e| format!("embedder lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(SidecarEmbedder::resolve_default().map_err(|e| e.to_string())?);
        }
        let embedder = guard.as_mut().expect("embedder just initialized");
        let emb = embedder.embed_query(&query).map_err(|e| e.to_string())?;
        drop(guard); // 检索不占用 embedder 锁

        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let hits = store::search(&conn, &emb, k.unwrap_or(5), None).map_err(|e| e.to_string())?;

        let items: Vec<MemoryItem> = hits.iter().map(|h| h.item.clone()).collect();
        let clip_paths = resolve_clip_image_paths(&conn, &items)?;
        Ok(hits
            .into_iter()
            .map(|h| item_to_dto(h.item, h.score, &clip_paths))
            .collect())
    })
    .await
    .map_err(|e| format!("memory_search join: {e}"))?
}

/// 最近索引条目（知识页空查询浏览态, P3）：indexed_at 倒序，复用检索的 DTO 组装
#[tauri::command]
pub async fn memory_recent(
    limit: Option<i64>,
    db: State<'_, DatabaseState>,
) -> Result<Vec<MemoryHitDto>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let items = store::recent_items(&conn, limit.unwrap_or(60)).map_err(|e| e.to_string())?;
        let clip_paths = resolve_clip_image_paths(&conn, &items)?;
        Ok(items
            .into_iter()
            .map(|item| item_to_dto(item, 0.0, &clip_paths))
            .collect())
    })
    .await
    .map_err(|e| format!("memory_recent join: {e}"))?
}

#[tauri::command]
pub async fn memory_open(id: i64, db: State<'_, DatabaseState>) -> Result<MemoryOpenResult, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let row = conn.query_row(
            "SELECT source, url, content, source_ref, modality FROM memory_items WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        );
        let (source, url, content, source_ref, modality) = match row {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Err("记忆条目不存在".to_string()),
            Err(e) => return Err(e.to_string()),
        };

        // N2: 剪贴板图片条目——从 source_ref 解析剪贴板 id → 打开图片文件
        if source == "clipboard" && modality == "image" {
            if let Some(ref sref) = source_ref {
                if let Some(clip_id) = sref.strip_prefix("clipboard-").and_then(|s| s.parse::<i64>().ok()) {
                    let path: Option<String> = conn
                        .query_row(
                            "SELECT content FROM clipboard_history WHERE id = ?1",
                            [clip_id],
                            |r| r.get(0),
                        )
                        .ok();
                    if let Some(p) = path {
                        if std::path::Path::new(&p).exists() {
                            open::that(&p).map_err(|e| format!("打开图片失败: {e}"))?;
                            return Ok(MemoryOpenResult { action: "opened_file".into(), content: Some(p), source_ref: None });
                        }
                    }
                }
            }
            // 图片文件已删/解析失败 → 回落复制描述文本
            return Ok(MemoryOpenResult { action: "copy_content".into(), content: Some(content), source_ref });
        }

        match source.as_str() {
            // 浏览页/字幕段: 后端直接开浏览器（字幕 url 自带 #t= 秒级锚点）
            "browser" | "subtitle" => {
                let url = url.ok_or("该条目没有 URL")?;
                open::that(&url).map_err(|e| format!("打开链接失败: {e}"))?;
                Ok(MemoryOpenResult { action: "opened_url".into(), content: None, source_ref: None })
            }
            // 笔记: 前端跳笔记视图
            "note" => Ok(MemoryOpenResult { action: "open_note".into(), content: None, source_ref }),
            // 剪贴板及其他: 内容交回前端复制
            _ => Ok(MemoryOpenResult { action: "copy_content".into(), content: Some(content), source_ref }),
        }
    })
    .await
    .map_err(|e| format!("memory_open join: {e}"))?
}

// ---------- M4: 隐私控制（黑名单/一键清除/统计, SQLite 单真源; Q9 全永久后保留期配置已撤除） ----------

#[tauri::command]
pub async fn memory_get_blacklist(db: State<'_, DatabaseState>) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_get_blacklist join: {e}"))?
}

/// 拉黑域名：入库 + 物理清除该域存量索引（与扩展「不再索引此站点」同一语义, D10）
#[tauri::command]
pub async fn memory_add_blacklist(
    domain: String,
    db: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::add_blacklist(&conn, &domain).map_err(|e| e.to_string())?;
        store::delete_by_domain(&conn, &domain).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_add_blacklist join: {e}"))?
}

#[tauri::command]
pub async fn memory_remove_blacklist(
    domain: String,
    db: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::remove_blacklist(&conn, &domain).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_remove_blacklist join: {e}"))?
}

/// 一键清除浏览索引（页面 + 字幕, 剪贴板/笔记/记忆不受影响, D10）
#[tauri::command]
pub async fn memory_clear_browsing(db: State<'_, DatabaseState>) -> Result<usize, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let n = store::clear_source(&conn, "browser").map_err(|e| e.to_string())?
            + store::clear_source(&conn, "subtitle").map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
    .map_err(|e| format!("memory_clear_browsing join: {e}"))?
}

/// 各来源条目统计（隐私仪表盘）
#[tauri::command]
pub async fn memory_source_stats(db: State<'_, DatabaseState>) -> Result<Vec<(String, i64)>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::source_stats(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_source_stats join: {e}"))?
}

// ---------- 二期 N1: schema v1->v2 迁移（WeMM 重 embed） ----------

/// 是否存在待重 embed 的存量数据（前端据此显示「记忆索引升级中」）
#[tauri::command]
pub async fn memory_migration_pending(db: State<'_, DatabaseState>) -> Result<bool, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Ok(store::migration_pending(&conn))
    })
    .await
    .map_err(|e| format!("memory_migration_pending join: {e}"))?
}

// ---------- 二期 N1-5: 本地模型环境（GPU/依赖/模型 状态灯 + 一键安装引导） ----------
// 三要素：GPU（nvidia-smi 可见）→ venv 依赖（uv sync, ~2.5GB 清华镜像）→ 模型（~5.1GB hf-mirror）。
// venv 落 {app_data}/wemm-venv（安装目录 Program Files 不可写），模型落 {app_data}/models/。

/// 模型完整下载后的体积基准（实测 5.46GB，进度估算分母留余量）
const EXPECTED_MODEL_BYTES: u64 = 5_400_000_000;
/// 完整性判定阈值：目录总大小超过即视为已下全（低于此值视为半成品继续下载）
const MODEL_COMPLETE_BYTES: u64 = 5_000_000_000;

#[derive(Serialize, Clone)]
pub struct MemoryEnvStatus {
    /// nvidia-smi 可见 GPU
    pub gpu: bool,
    /// venv python 就位
    pub deps: bool,
    /// 模型完整就位
    pub model: bool,
    /// 安装流水线进行中
    pub installing: bool,
    /// 模型目录当前字节数（进度展示）
    pub model_bytes: u64,
    pub model_expected_bytes: u64,
}

#[derive(Serialize, Clone)]
struct MemoryEnvProgress {
    /// deps | model | done | error
    stage: &'static str,
    percent: Option<u8>,
    message: String,
}

static ENV_INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn app_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join(crate::APP_DIR_NAME))
        .ok_or_else(|| "无法定位 app_data".to_string())
}

fn venv_python(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("wemm-venv").join("Scripts").join("python.exe")
}

fn wemm_model_dir(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("models").join("wemm-embedding-2b")
}

/// uv.exe 解析：exe 同目录（生产打包形态）> PATH（开发形态）
fn resolve_uv() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("uv.exe");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }
    std::process::Command::new("uv")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .filter(|s| s.success())
        .map(|_| std::path::PathBuf::from("uv"))
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        stack.push(p);
                    } else {
                        total += meta.len();
                    }
                }
            }
        }
    }
    total
}

fn model_complete(model_dir: &std::path::Path) -> bool {
    model_dir.join("config.json").exists()
        && model_dir.join("model.safetensors").exists()
        && dir_size(model_dir) >= MODEL_COMPLETE_BYTES
}

/// GPU 检测：nvidia-smi 随驱动必装且入 PATH，能列出 GPU 即视为可用
fn gpu_available() -> bool {
    std::process::Command::new("nvidia-smi")
        .arg("-L")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("GPU"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn memory_env_status() -> Result<MemoryEnvStatus, String> {
    tokio::task::spawn_blocking(|| {
        let app_data = app_data_dir()?;
        let model_dir = wemm_model_dir(&app_data);
        Ok(MemoryEnvStatus {
            gpu: gpu_available(),
            deps: venv_python(&app_data).exists(),
            model: model_complete(&model_dir),
            installing: ENV_INSTALLING.load(std::sync::atomic::Ordering::SeqCst),
            model_bytes: if model_dir.exists() { dir_size(&model_dir) } else { 0 },
            model_expected_bytes: EXPECTED_MODEL_BYTES,
        })
    })
    .await
    .map_err(|e| format!("memory_env_status join: {e}"))?
}

fn emit_env_progress(app: &tauri::AppHandle, stage: &'static str, percent: Option<u8>, message: impl Into<String>) {
    use tauri::Emitter;
    let _ = app.emit(
        "memory-env-progress",
        MemoryEnvProgress { stage, percent, message: message.into() },
    );
}

/// 一键安装：uv sync 建 venv → 下载模型。后台线程执行，进度走 memory-env-progress 事件。
#[tauri::command]
pub async fn memory_env_install(app: tauri::AppHandle) -> Result<(), String> {
    if ENV_INSTALLING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("安装已在进行中".to_string());
    }
    std::thread::spawn(move || {
        let result = run_env_install(&app);
        ENV_INSTALLING.store(false, std::sync::atomic::Ordering::SeqCst);
        match result {
            Ok(()) => emit_env_progress(&app, "done", Some(100), "本地模型环境就绪".to_string()),
            Err(e) => emit_env_progress(&app, "error", None, e),
        }
    });
    Ok(())
}

fn run_env_install(app: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app_data_dir()?;
    let sidecar_dir = nervis_memory::sidecar::resolve_sidecar_dir();
    let uv = resolve_uv().ok_or("uv.exe 未找到（应随安装包分发或入 PATH）")?;
    let venv_dir = app_data.join("wemm-venv");
    let venv_py = venv_python(&app_data);
    let model_dir = wemm_model_dir(&app_data);

    // 阶段 1: uv sync 建 venv 装依赖（torch 等 ~2.5GB, 清华镜像）
    if !venv_py.exists() {
        emit_env_progress(app, "deps", None, "安装 Python 依赖（约 2.5GB，首次较慢）…");
        let output = std::process::Command::new(&uv)
            .arg("sync")
            .arg("--project")
            .arg(&sidecar_dir)
            .env("UV_PROJECT_ENVIRONMENT", &venv_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("启动 uv 失败: {e}"))?;
        if !output.status.success() || !venv_py.exists() {
            let tail = String::from_utf8_lossy(&output.stderr);
            let tail: String = tail.lines().rev().take(5).collect::<Vec<_>>().join(" | ");
            return Err(format!("依赖安装失败: {tail}"));
        }
    }

    // 阶段 2: 下载模型（~5.1GB, hf-mirror, 断点续传）
    if !model_complete(&model_dir) {
        emit_env_progress(app, "model", Some(0), "下载 WeMM 模型（约 5.1GB）…");
        let mut child = std::process::Command::new(&venv_py)
            .arg(sidecar_dir.join("download_model.py"))
            .arg(&model_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动模型下载失败: {e}"))?;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() || !model_complete(&model_dir) {
                        return Err("模型下载未完成（网络中断可点安装重试，已下部分会续传）".to_string());
                    }
                    break;
                }
                Ok(None) => {
                    let bytes = dir_size(&model_dir);
                    let pct = ((bytes * 100) / EXPECTED_MODEL_BYTES).min(99) as u8;
                    emit_env_progress(
                        app,
                        "model",
                        Some(pct),
                        format!("下载 WeMM 模型… {:.1} / 5.1 GB", bytes as f64 / 1e9),
                    );
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
                Err(e) => return Err(format!("模型下载进程异常: {e}")),
            }
        }
    }
    Ok(())
}

// ---------- 二期 N2: 剪贴板图片 opt-in 索引 ----------

/// 「索引此图」：剪贴板图片 → sidecar embed_image → memory_items (modality=image)
/// CASE-003: plan 先行，内容未变直接跳过 embed_image（省一次图片推理）
#[tauri::command]
pub async fn memory_index_image(
    image_base64: String,
    mime: String,
    source_ref: String,
    label: String,
    state: State<'_, MemoryEmbedderState>,
    db: State<'_, DatabaseState>,
) -> Result<(), String> {
    let db_path = db.0.clone();
    let embedder_arc = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let meta = store::DocMeta {
            source: "clipboard",
            source_ref: Some(&source_ref),
            url: None,
            domain: None,
            title: Some(&label),
            modality: Some("image"),
            dedup_key: Some(&source_ref), // 剪贴板条目 id 即去重键（同一条目重复索引只更新）
            created_at: None,
            expires_at: None,
        };
        let planned = store::plan_index(
            &conn,
            "clipboard",
            &source_ref,
            vec![nervis_memory::chunk::Chunk {
                content: label.clone(),
                embed_text: label.clone(),
            }],
        )
        .map_err(|e| e.to_string())?;
        if planned.iter().all(|p| p.reuse_rowid.is_some()) {
            return store::commit_index(&mut conn, &meta, planned, &std::collections::HashMap::new())
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        let mut guard = embedder_arc.lock().map_err(|e| format!("embedder lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(SidecarEmbedder::resolve_default().map_err(|e| e.to_string())?);
        }
        let emb = guard
            .as_mut()
            .expect("embedder just initialized")
            .embed_image(&image_base64, &mime)
            .map_err(|e| e.to_string())?;
        drop(guard);
        let mut embeddings = std::collections::HashMap::new();
        embeddings.insert(planned[0].chunk_index, emb);
        store::commit_index(&mut conn, &meta, planned, &embeddings).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("memory_index_image join: {e}"))?
}
