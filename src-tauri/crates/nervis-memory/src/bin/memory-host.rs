//! memory-host: native messaging host（浏览器扩展 ⇄ Nervis 记忆索引的唯一通道，D6）
//!
//! 协议: Chrome native messaging —— stdin/stdout 上 [u32 LE 长度][JSON] 帧。
//! M1 范围: 骨架 + index/ping 两类消息；扩展侧 M2 接入。
//! 安全: 无端口无网络，只有浏览器按 manifest 拉起的进程能到达本进程。

use anyhow::{Context, Result};
use nervis_memory::chunk::{chunk_text, content_hash, is_indexable};
use nervis_memory::sidecar::{MemoryEmbedder, SidecarEmbedder};
use nervis_memory::store::{self, DocMeta};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Ping,
    /// 页面正文索引（扩展已做停留阈值/黑名单/密码框过滤）
    Index {
        source: String,
        url: Option<String>,
        domain: Option<String>,
        title: Option<String>,
        content: String,
        created_at: Option<String>,
        /// N2: 页面主图 base64（og:image 优先，>5MB 扩展侧已跳过）
        image_base64: Option<String>,
        image_mime: Option<String>,
    },
    /// 视频字幕索引（段级, start 秒用于 ?t= 跳转, D3）
    IndexSubtitle {
        url: String,
        domain: Option<String>,
        title: Option<String>,
        segments: Vec<SubtitleSegment>,
        created_at: Option<String>,
    },
    /// N3: 视频画面分片索引（opt-in 录制, 10s webm base64 ~2.7MB）
    IndexVideo {
        url: String,
        domain: Option<String>,
        title: Option<String>,
        start_seconds: i64,
        end_seconds: i64,
        video_base64: String,
        created_at: Option<String>,
    },
    /// D10: 一键清除浏览索引
    ClearBrowsing,
    /// D10: 按域名删除
    DeleteDomain { domain: String },
    /// 黑名单全量（SQLite 单真源, 扩展启动时同步本地缓存）
    GetBlacklist,
    /// 拉黑域名：入库 + 物理清除该域存量索引
    BlockDomain { domain: String },
    UnblockDomain { domain: String },
    /// popup「打开记忆库」: 拉起主 exe, 由单例插件聚焦已有窗口
    FocusApp,
}

#[derive(Debug, Deserialize)]
struct SubtitleSegment {
    start: f64,
    text: String,
}

/// 秒 → mm:ss（视频画面段描述用）
fn fmt_secs(s: i64) -> String {
    format!("{}:{:02}", s / 60, s % 60)
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    /// 请求侧 req_id 原样回显（扩展区分「入队消息的无意义回包」与「请求-响应调用」）
    #[serde(skip_serializing_if = "Option::is_none")]
    req_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn db_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("NERVIS_DB_PATH") {
        return Ok(PathBuf::from(p));
    }
    let base = dirs::data_dir().context("无法定位 app_data")?;
    Ok(base.join("com.flowhub.app").join("flowhub.db"))
}

/// 帧长上限：协议消息最大不过数百 KB（正文 2 万字符）, 截断的流/异常对端
/// 申报的 u32 长度可达 4GB, 不设限会直接把内存吃爆
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

fn read_frame(stdin: &mut impl Read) -> Result<Option<String>> {
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    anyhow::ensure!(len <= MAX_FRAME_BYTES, "帧长 {len} 超过上限 {MAX_FRAME_BYTES}");
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    Ok(Some(String::from_utf8(buf)?))
}

fn write_frame(stdout: &mut impl Write, resp: &Response) -> Result<()> {
    let body = serde_json::to_vec(resp)?;
    stdout.write_all(&(body.len() as u32).to_le_bytes())?;
    stdout.write_all(&body)?;
    stdout.flush()?;
    Ok(())
}

fn handle(req: Request, conn: &mut Connection, embedder: &mut SidecarEmbedder) -> Result<serde_json::Value> {
    match req {
        Request::Ping => Ok(serde_json::json!({"pong": true})),
        Request::Index { source, url, domain, title, content, created_at, image_base64, image_mime } => {
            if !is_indexable(&content) {
                return Ok(serde_json::json!({"outcome": "too_short"}));
            }
            // 二期 Q9: 全永久, expires_at 恒 NULL（一期 90 天滚动已废）
            let meta = DocMeta {
                source: &source,
                source_ref: None,
                url: url.as_deref(),
                domain: domain.as_deref(),
                title: title.as_deref(),
                modality: None,
                dedup_key: None,
                created_at: created_at.as_deref(),
                expires_at: None,
            };
            let chunks = chunk_text(&content);
            let embeddings = embedder.embed_documents(&chunks)?;
            let rows: Vec<_> = chunks
                .iter()
                .enumerate()
                .map(|(i, c)| (i as i64, c.clone(), content_hash(c), embeddings[i].clone()))
                .collect();
            let outcome = store::index_document(conn, &meta, &rows)?;

            // N2: 页面主图单独索引一条 modality=image 记录（dedup_key 加 #img 后缀与正文区分）
            let mut image_indexed = false;
            if let (Some(b64), Some(page_url)) = (&image_base64, &url) {
                if let Ok(emb) = embedder.embed_image(b64, image_mime.as_deref().unwrap_or("image/jpeg")) {
                    let img_desc = format!("[页面主图] {}", title.as_deref().unwrap_or(""));
                    let img_dedup = format!("{page_url}#img");
                    let img_meta = DocMeta {
                        source: &source,
                        source_ref: None,
                        url: url.as_deref(),
                        domain: domain.as_deref(),
                        title: title.as_deref(),
                        modality: Some("image"),
                        dedup_key: Some(&img_dedup),
                        created_at: created_at.as_deref(),
                        expires_at: None,
                    };
                    let img_rows = vec![(0i64, img_desc.clone(), content_hash(&img_desc), emb)];
                    image_indexed = matches!(
                        store::index_document(conn, &img_meta, &img_rows)?,
                        store::IndexOutcome::Indexed(_)
                    );
                }
                // embed_image 失败不阻塞正文索引（sidecar 可能不支持/图片损坏）
            }

            Ok(serde_json::json!({"outcome": format!("{outcome:?}"), "image_indexed": image_indexed}))
        }
        Request::IndexSubtitle { url, domain, title, segments, created_at } => {
            // D7: 字幕按 45 秒窗口合并切段（单行字幕太短, 无独立检索价值）, 窗口起始秒支撑 ?t= 跳转
            const WINDOW_SECS: u64 = 45;
            let mut windows: std::collections::BTreeMap<u64, Vec<&str>> = std::collections::BTreeMap::new();
            for seg in &segments {
                windows
                    .entry((seg.start as u64) / WINDOW_SECS * WINDOW_SECS)
                    .or_default()
                    .push(seg.text.trim());
            }
            let mut indexed = 0usize;
            for (win_start, texts) in windows {
                let content = texts.join(" ");
                if !is_indexable(&content) {
                    continue;
                }
                let seg_url = format!("{url}#t={win_start}");
                let meta = DocMeta {
                    source: "subtitle",
                    source_ref: None,
                    url: Some(&seg_url),
                    domain: domain.as_deref(),
                    title: title.as_deref(),
                    modality: None,
                    dedup_key: None,
                    created_at: created_at.as_deref(),
                    expires_at: None,
                };
                let emb = embedder.embed_documents(std::slice::from_ref(&content))?;
                let rows = vec![(0i64, content.clone(), content_hash(&content), emb[0].clone())];
                if let store::IndexOutcome::Indexed(_) = store::index_document(conn, &meta, &rows)? {
                    indexed += 1;
                }
            }
            Ok(serde_json::json!({"indexed_segments": indexed}))
        }
        Request::IndexVideo { url, domain, title, start_seconds, end_seconds, video_base64, created_at } => {
            // N3: 整段 10s webm 直送 WeMM（弃抽帧, CASE-007 Q1）；每段一条 modality=video
            let emb = embedder.embed_video(&video_base64, "video/webm")?;
            let seg_url = format!("{url}#t={start_seconds}");
            let desc = format!(
                "[视频画面] {} {}-{}",
                title.as_deref().unwrap_or(""),
                fmt_secs(start_seconds),
                fmt_secs(end_seconds)
            );
            let meta = DocMeta {
                source: "browser",
                source_ref: None,
                url: Some(&seg_url),
                domain: domain.as_deref(),
                title: title.as_deref(),
                modality: Some("video"),
                dedup_key: Some(&seg_url), // 段级去重：url+起始秒天然区分
                created_at: created_at.as_deref(),
                expires_at: None,
            };
            let rows = vec![(0i64, desc.clone(), content_hash(&desc), emb)];
            let outcome = store::index_document(conn, &meta, &rows)?;
            Ok(serde_json::json!({"outcome": format!("{outcome:?}")}))
        }
        Request::ClearBrowsing => {
            let n = store::clear_source(conn, "browser")? + store::clear_source(conn, "subtitle")?;
            Ok(serde_json::json!({"deleted": n}))
        }
        Request::DeleteDomain { domain } => {
            let n = store::delete_by_domain(conn, &domain)?;
            Ok(serde_json::json!({"deleted": n}))
        }
        Request::GetBlacklist => {
            let list = store::list_blacklist(conn)?;
            Ok(serde_json::json!({"blacklist": list}))
        }
        Request::BlockDomain { domain } => {
            store::add_blacklist(conn, &domain)?;
            // 拉黑即物理清除该域存量（与扩展「不再索引此站点」语义一致, D10）
            let deleted = store::delete_by_domain(conn, &domain)?;
            let list = store::list_blacklist(conn)?;
            Ok(serde_json::json!({"blacklist": list, "deleted": deleted}))
        }
        Request::UnblockDomain { domain } => {
            store::remove_blacklist(conn, &domain)?;
            let list = store::list_blacklist(conn)?;
            Ok(serde_json::json!({"blacklist": list}))
        }
        Request::FocusApp => focus_main_app(),
    }
}

/// 拉起同目录主程序：未运行则启动，已运行由 tauri-plugin-single-instance 聚焦其主窗口。
/// 候选名探测（品牌更名过渡期 productName 未定, 改名后只需把新名放首位）。
fn focus_main_app() -> Result<serde_json::Value> {
    let exe_dir = std::env::current_exe()?
        .parent()
        .context("无法定位 host 所在目录")?
        .to_path_buf();
    const CANDIDATES: [&str; 3] = ["nervis.exe", "FlowHub.exe", "flowhub.exe"];
    let target = CANDIDATES
        .iter()
        .map(|n| exe_dir.join(n))
        .find(|p| p.exists())
        .with_context(|| format!("{} 下未找到主程序 {:?}", exe_dir.display(), CANDIDATES))?;
    std::process::Command::new(target)
        .spawn()
        .context("拉起主程序失败")?;
    Ok(serde_json::json!({"focused": true}))
}

fn main() -> Result<()> {
    store::register_vec_extension(); // 必须先于 Connection::open
    let mut embedder = SidecarEmbedder::resolve_default()?;
    let mut conn = Connection::open(db_path()?)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    store::init_memory_tables(&conn)?;

    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    while let Some(frame) = read_frame(&mut stdin)? {
        let resp = match serde_json::from_str::<serde_json::Value>(&frame) {
            Ok(v) => {
                let req_id = v.get("req_id").and_then(|r| r.as_u64());
                match serde_json::from_value::<Request>(v) {
                    Ok(req) => match handle(req, &mut conn, &mut embedder) {
                        Ok(result) => Response { ok: true, req_id, result: Some(result), error: None },
                        Err(e) => Response { ok: false, req_id, result: None, error: Some(format!("{e:#}")) },
                    },
                    Err(e) => Response { ok: false, req_id, result: None, error: Some(format!("bad request: {e}")) },
                }
            }
            Err(e) => Response { ok: false, req_id: None, result: None, error: Some(format!("bad request: {e}")) },
        };
        write_frame(&mut stdout, &resp)?;
    }
    Ok(())
}
