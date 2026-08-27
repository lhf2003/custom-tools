//! remember_fact 两级流水线（D12 记忆系统并入一期）：
//! 向量召回 → 命中（score ≥ RECALL_THRESHOLD）走 LLM 裁决 ADD/UPDATE/NOOP；
//! 无命中直接写入。全链路隐身降级：Embedder/LLM 任一不可用 → 回落原 bigram 查重。
//!
//! 阈值不拍脑袋：每次 remember 的 top-score 与决策路径写进审计事件 source 字段
//! （格式 explicit|vec=0.83|llm:update），跑一段时间后按实测分布收阈值。
//!
//! facts 的向量索引：source='memory_fact', dedup_key='fact:{id}'（占用 source_ref），
//! remember/forget 后调 sync_fact_index 差异对账（未变更不重复 embed）。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use nervis_memory::chunk::content_hash;
use nervis_memory::embed::{init_ort, resolve_model_dir, Embedder};
use nervis_memory::store::{self, DocMeta};
use rusqlite::Connection;

use super::{analyzer, db};
use crate::llm_provider::models::Scene;

/// 召回门槛初值：只决定「是否打扰 LLM」不决定正确性——偏低让 LLM 多裁几次,
/// 分数分布落审计后按实测收（标定依据见 llm_call_logs source=remember_fact_arbitrate）
pub(crate) const RECALL_THRESHOLD: f32 = 0.65;

/// LLM 裁决结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Add,
    Update,
    Noop,
}

/// 进程级懒加载 Embedder：模型 95MB, remember/forget 低频, 首次用到才加载;
/// 模型/ORT 缺失时返回 None → 调用方回落 bigram（隐身降级）
fn shared_embedder() -> Option<&'static Mutex<Embedder>> {
    static EMB: OnceLock<Option<Mutex<Embedder>>> = OnceLock::new();
    EMB.get_or_init(|| {
        let model_dir = resolve_model_dir().ok()?;
        init_ort(None).ok()?;
        let e = Embedder::new(&model_dir)
            .map_err(|err| log::warn!("fact_pipeline Embedder 初始化失败: {err:#}"))
            .ok()?;
        Some(Mutex::new(e))
    })
    .as_ref()
}

/// 向量召回最相似的一条记忆事实：Some((fact_id, 当前文本, score))
/// 索引文本以 memory_facts 表为准（防索引漂移）
pub(crate) fn vector_recall(conn: &Connection, new_fact: &str) -> Option<(i64, String, f32)> {
    let emb = shared_embedder()?
        .lock()
        .ok()?
        .embed_query(new_fact)
        .map_err(|e| log::warn!("fact_pipeline embed_query 失败: {e:#}"))
        .ok()?;
    let hits = store::search(conn, &emb, 3, Some("memory_fact"))
        .map_err(|e| log::warn!("fact_pipeline 向量检索失败: {e:#}"))
        .ok()?;
    let top = hits.into_iter().next()?;
    let fact_id: i64 = top
        .item
        .source_ref
        .as_deref()?
        .strip_prefix("fact:")?
        .parse()
        .ok()?;
    let current_text: String = conn
        .query_row(
            "SELECT fact FROM memory_facts WHERE id = ?1",
            [fact_id],
            |r| r.get(0),
        )
        .ok()?;
    Some((fact_id, current_text, top.score))
}

/// 小模型裁决：新事实 vs 召回到的旧事实 → ADD/UPDATE/NOOP。
/// 调用登记 llm_call_logs（source=remember_fact_arbitrate）；失败由调用方回落 bigram
pub(crate) fn llm_arbitrate(
    db_path: &Path,
    new_fact: &str,
    old_fact: &str,
) -> Result<Verdict, String> {
    let prompt = format!(
        "你在维护一份关于用户的长期记忆清单。判断「新事实」相对「已有记忆」应采取的动作，只回答一个英文单词：\n\n\
         ADD —— 新事实与已有记忆是不同信息，应新增一条\n\
         UPDATE —— 新事实是对已有记忆的纠正或更新（同一主题），应覆盖旧条目\n\
         NOOP —— 新事实与已有记忆语义重复，无需写入\n\n\
         已有记忆：「{old_fact}」\n\
         新事实：「{new_fact}」\n\n\
         只回答 ADD、UPDATE 或 NOOP，不要解释。"
    );
    crate::llm::log_prompt("remember_fact_arbitrate", &prompt);
    let app_data = dirs::data_dir()
        .map(|d| d.join(crate::APP_DIR_NAME))
        .ok_or("无法定位 app_data")?;
    let db = db_path.to_path_buf();
    let reply = block_on_llm(analyzer::call_scene_model_llm_with_dir(
        &db,
        prompt,
        Scene::Companion,
        "remember_fact_arbitrate",
        &app_data,
    ))?;
    let upper = reply.trim().to_uppercase();
    if upper.contains("UPDATE") {
        Ok(Verdict::Update)
    } else if upper.contains("NOOP") {
        Ok(Verdict::Noop)
    } else if upper.contains("ADD") {
        Ok(Verdict::Add)
    } else {
        Err(format!("裁决回复无法解析: {}", reply.chars().take(40).collect::<String>()))
    }
}

/// MCP 进程是同步 stdio 循环（自建 runtime）；app 内场景通道已在 tokio 里
/// （block_in_place 借当前 runtime）。两种调用点都安全。
fn block_on_llm<F: std::future::Future>(fut: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => tokio::task::block_in_place(|| h.block_on(fut)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("创建 runtime 失败: {e}"))
            .and_then(|rt| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rt.block_on(fut)))
                    .map_err(|_| "block_on panic".to_string())
            })
            .expect("fact_pipeline LLM runtime"),
    }
}

/// facts ↔ 向量索引差异对账：变更/新增才 embed，索引有而 facts 无的删行+向量。
/// remember/forget 后调用；Embedder 不可用时静默跳过（下次可用时自愈）。返回 (重写, 删除)。
pub(crate) fn sync_fact_index(conn: &mut Connection) -> (usize, usize) {
    let Some(mx) = shared_embedder() else {
        return (0, 0);
    };
    let facts = db::list_memory_facts(conn, 100_000).unwrap_or_default();
    let live: std::collections::HashSet<String> =
        facts.iter().map(|f| format!("fact:{}", f.id)).collect();

    // 删除索引里的孤儿（forget 的条目）
    let existing: Vec<(i64, String)> = conn
        .prepare("SELECT id, source_ref FROM memory_items WHERE source = 'memory_fact'")
        .and_then(|mut st| {
            let mapped = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    let mut removed = 0;
    for (item_id, sref) in existing {
        if !live.contains(&sref) {
            let _ = conn.execute("DELETE FROM memory_vectors WHERE rowid = ?1", [item_id]);
            removed += conn
                .execute("DELETE FROM memory_items WHERE id = ?1", [item_id])
                .unwrap_or(0);
        }
    }

    // 只 embed 内容有变的（index_document 自身也判哈希, 这里预检省下 embed 开销）
    let pending: Vec<&db::MemoryFact> = facts
        .iter()
        .filter(|f| {
            let key = format!("fact:{}", f.id);
            let old: Option<String> = conn
                .query_row(
                    "SELECT content_hash FROM memory_items WHERE source = 'memory_fact' AND dedup_key = ?1",
                    [key],
                    |r| r.get(0),
                )
                .ok();
            old.as_deref() != Some(content_hash(&f.fact).as_str())
        })
        .collect();
    if pending.is_empty() {
        return (0, removed);
    }
    let texts: Vec<String> = pending.iter().map(|f| f.fact.clone()).collect();
    let Ok(mut guard) = mx.lock() else {
        return (0, removed);
    };
    let Ok(embs) = guard.embed_documents(&texts) else {
        return (0, removed);
    };
    let mut rewritten = 0;
    for (f, emb) in pending.iter().zip(embs) {
        let key = format!("fact:{}", f.id);
        let meta = DocMeta {
            source: "memory_fact",
            source_ref: Some(&key),
            ..Default::default()
        };
        let rows = vec![(0i64, f.fact.clone(), content_hash(&f.fact), emb)];
        if let Ok(store::IndexOutcome::Indexed(_)) = store::index_document(conn, &meta, &rows) {
            rewritten += 1;
        }
    }
    (rewritten, removed)
}
