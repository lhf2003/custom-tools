//! LLM 调用观测：所有通道（Claude Code CLI / 场景模型）的调用统一登记到
//! llm_call_logs 表，成本面板按来源聚合。登记失败只记日志绝不阻塞主流程——
//! 观测是旁路，不能成为单点故障。

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

/// 一次 LLM 调用的登记条目
pub struct LlmCallEntry<'a> {
    /// 调用来源：chat/analysis/report/recall/diary/focus/intent_parse/translate/qa/test
    pub source: &'a str,
    /// 通道：claude_code | scene_model
    pub channel: &'a str,
    /// 场景模型场景（chat/qa/translate/companion/memory_extraction）；CC 通道为 None
    pub scene: Option<&'a str>,
    /// 模型 id；CC 通道记 None（由用户 CLI 配置决定，面板显示通道即可）
    pub model: Option<&'a str>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// 美元成本：CC 通道为 CLI 实报；场景模型为 token×单价（未配单价记 0）
    pub cost_usd: f64,
    pub duration_ms: u64,
    /// "ok" | "error"
    pub status: &'a str,
    pub error: Option<&'a str>,
}

/// 登记一条调用日志。任何失败仅 log::warn——观测绝不能打断业务调用链。
pub fn log_call(db_path: &Path, entry: &LlmCallEntry) {
    let now = chrono::Local::now().timestamp();
    let result = Connection::open(db_path).and_then(|conn| {
        conn.execute(
            "INSERT INTO llm_call_logs
             (source, channel, scene, model, input_tokens, output_tokens, cost_usd,
              duration_ms, status, error, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                entry.source,
                entry.channel,
                entry.scene,
                entry.model,
                entry.input_tokens as i64,
                entry.output_tokens as i64,
                entry.cost_usd,
                entry.duration_ms as i64,
                entry.status,
                entry.error,
                now,
            ],
        )
    });
    if let Err(e) = result {
        log::warn!("LLM 调用日志登记失败（{}）: {}", entry.source, e);
    }
}

/// 按来源聚合的统计行（成本面板）
#[derive(Debug, Clone, Serialize)]
pub struct SourceStat {
    pub source: String,
    pub calls: u64,
    pub errors: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub total_duration_ms: u64,
}

/// 聚合 [since, until) 时间窗内的调用统计（按来源分组）
pub fn summarize(db_path: &Path, since: i64, until: i64) -> Result<Vec<SourceStat>, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT source,
                    COUNT(*),
                    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cost_usd), 0),
                    COALESCE(SUM(duration_ms), 0)
             FROM llm_call_logs
             WHERE created_at >= ?1 AND created_at < ?2
             GROUP BY source
             ORDER BY COUNT(*) DESC",
        )
        .map_err(|e| format!("准备统计查询失败: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params![since, until], |row| {
            Ok(SourceStat {
                source: row.get(0)?,
                calls: row.get::<_, i64>(1)? as u64,
                errors: row.get::<_, i64>(2)? as u64,
                input_tokens: row.get::<_, i64>(3)? as u64,
                output_tokens: row.get::<_, i64>(4)? as u64,
                cost_usd: row.get(5)?,
                total_duration_ms: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|e| format!("统计查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取统计结果失败: {}", e))?;

    Ok(rows)
}
