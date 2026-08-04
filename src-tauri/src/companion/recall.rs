//! 聊天记忆提取管道：一段聊天静默后，把「他发的消息」经 LLM 单调用
//! 提炼成长期事实写入 memory_facts（全程审计）。
//!
//! 双触发通道：
//! - 防抖：每条聊天消息落库后 poke，静默 10 分钟无新消息才真正提取
//! - 兜底：0 点调度块无条件补跑一次（水位已最新则空转）
//!
//! 只提取 user 消息（防自我强化），translate 等工具模式会话不参与。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::{analyzer, db, persona};
use crate::llm_provider::models::Scene;

/// 会话静默时长：最后一条消息 10 分钟后触发提取
const RECALL_DEBOUNCE_SECS: u64 = 600;
/// 单次提取的用户消息上限（超出留下次，防成本尖峰）
const RECALL_MSG_LIMIT: i64 = 30;
/// 提取时给模型看的已有记忆上限（两条提取管道共用：recall 与定时分析）
const EXISTING_FACT_LIMIT: i64 = 100;
/// 单条消息进 prompt 的截断长度
const MSG_PREVIEW_CAP: usize = 500;
/// 提取水位 settings key（已提取到的 chat_messages.id）
const WATERMARK_KEY: &str = "companion_recall_watermark";

/// 取已有记忆——recall 与 analyst 定时分析两条提取管道必须看同一份清单，
/// 否则看不见的管道只能不停 add 近义新条（记忆膨胀的根因）
pub(crate) fn load_existing_facts(conn: &Connection) -> Vec<db::MemoryFact> {
    db::list_memory_facts(conn, EXISTING_FACT_LIMIT).unwrap_or_default()
}

/// 「已有记忆」段渲染：带 id 供 update 的 target_id 引用，两管道格式必须一致
pub(crate) fn format_facts_with_ids(facts: &[db::MemoryFact]) -> String {
    if facts.is_empty() {
        return "（还没有已有记忆）".to_string();
    }
    facts
        .iter()
        .map(|f| format!("- [id:{}] ({}) {}", f.id, f.category, f.fact))
        .collect::<Vec<_>>()
        .join("\n")
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
static EXTRACTED: AtomicU64 = AtomicU64::new(0);
static START: Once = Once::new();

/// 每条聊天消息落库后调用：递增代际并确保防抖任务已启动。
/// 代际在静默期内不再变化时才真正提取（期间有新消息则继续等）。
pub fn poke(app_handle: AppHandle, db_path: PathBuf) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    START.call_once(|| {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(RECALL_DEBOUNCE_SECS));
            let gen = GENERATION.load(Ordering::SeqCst);
            if gen == EXTRACTED.load(Ordering::SeqCst) {
                continue;
            }
            match run_recall_blocking(&app_handle, &db_path) {
                Ok(msg) => {
                    EXTRACTED.store(gen, Ordering::SeqCst);
                    log::info!("Companion 记忆提取: {}", msg);
                }
                // 失败不推进代际，下个周期重试
                Err(e) => log::warn!("Companion 记忆提取失败: {}", e),
            }
        });
    });
}

/// 阻塞包装：在普通线程里跑异步提取（防抖线程/调度线程用）
pub fn run_recall_blocking(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    tauri::async_runtime::block_on(run_recall(app_handle, db_path))
}

/// 提取一轮：取水位之后的用户消息，单调用 LLM 判断 add/update，
/// 写库并推进水位。没有待提取消息时直接空转返回。
pub async fn run_recall(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let watermark: i64 = analyzer::load_setting(db_path, WATERMARK_KEY)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.content FROM chat_messages m
             JOIN chat_sessions s ON s.id = m.session_id
             WHERE m.id > ?1 AND m.role = 'user' AND s.mode = 'chat'
             ORDER BY m.id ASC LIMIT ?2",
        )
        .map_err(|e| format!("查询消息失败: {}", e))?;
    let msgs: Vec<(i64, String)> = stmt
        .query_map(params![watermark, RECALL_MSG_LIMIT], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| format!("查询消息失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取消息失败: {}", e))?;

    if msgs.is_empty() {
        return Ok("无待提取消息".to_string());
    }
    let max_id = msgs.last().map(|(id, _)| *id).unwrap_or(watermark);

    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let persona_text = persona::load(&app_data);
    let evolution = persona::load_evolution(&app_data);
    let manual = super::skills::load_skill_body(&app_data, "recall");
    let facts = load_existing_facts(&conn);
    let facts_text = format_facts_with_ids(&facts);
    let msgs_text = msgs
        .iter()
        .map(|(id, c)| {
            let preview: String = c.chars().take(MSG_PREVIEW_CAP).collect();
            format!("- [msg:{}] {}", id, preview)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{manual}\n\n---\n\n\
         # 已有记忆\n{facts}\n\n---\n\n# 本次新增的用户消息（只从这些消息提取，只输出 JSON）\n{msgs}",
        persona = persona_text,
        evolution = evolution,
        manual = manual,
        facts = facts_text,
        msgs = msgs_text
    );

    let reply = analyzer::call_llm_with_scene(
        app_handle,
        db_path,
        prompt,
        Scene::MemoryExtraction,
        "recall",
    )
    .await?;
    let ops = parse_recall_ops(&reply)?;

    let now = chrono::Local::now().timestamp();
    let known: std::collections::HashSet<i64> = facts.iter().map(|f| f.id).collect();
    let mut added = 0usize;
    let mut updated = 0usize;
    for op in &ops {
        let fact = op.fact.trim();
        if fact.is_empty() {
            continue;
        }
        match op.action.as_str() {
            // target_id 对不上已有记忆时降级为 add（宁多记不丢记）
            "update" if op.target_id.map(|t| known.contains(&t)).unwrap_or(false) => {
                db::update_memory_fact(
                    &conn,
                    op.target_id.unwrap(),
                    fact,
                    &op.category,
                    "recall",
                    now,
                )
                .map_err(|e| format!("更新记忆失败: {}", e))?;
                updated += 1;
            }
            _ => {
                db::upsert_memory_fact(&conn, fact, &op.category, "recall", now)
                    .map_err(|e| format!("写入记忆失败: {}", e))?;
                added += 1;
            }
        }
    }

    // 全部落库成功才推进水位（失败则下轮重试这批消息）
    analyzer::save_setting(db_path, WATERMARK_KEY, &max_id.to_string());
    Ok(format!(
        "{} 条消息 → 新增 {} / 更新 {} 条记忆",
        msgs.len(),
        added,
        updated
    ))
}

#[derive(Debug, Deserialize)]
struct RecallOps {
    #[serde(default)]
    ops: Vec<RecallOp>,
}

#[derive(Debug, Deserialize)]
struct RecallOp {
    action: String,
    #[serde(default)]
    fact: String,
    #[serde(default = "default_recall_category")]
    category: String,
    #[serde(default)]
    target_id: Option<i64>,
}

fn default_recall_category() -> String {
    "person".to_string()
}

/// 从 LLM 回复中提取 JSON 操作集（容错：只取首尾花括号之间的内容）
fn parse_recall_ops(reply: &str) -> Result<Vec<RecallOp>, String> {
    let start = reply.find('{').ok_or("提取响应中没有 JSON")?;
    let end = reply.rfind('}').ok_or("提取响应中没有 JSON")?;
    let parsed: RecallOps = serde_json::from_str(&reply[start..=end])
        .map_err(|e| format!("解析提取 JSON 失败: {}", e))?;
    Ok(parsed.ops)
}
