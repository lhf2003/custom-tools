//! 文本切块与内容哈希
//!
//! chunk 大小取 1200 字符: spike 在此粒度下验证了 top-3 88%（设计文档原估 500，
//! 实测 1200 已达标且切块数减半，索引体积更省）。超长文档截断上限防止单 URL 灌爆库。

/// 单块字符数（按 char 计，非字节）
pub const CHUNK_SIZE: usize = 1200;
/// 单文档最大块数
pub const MAX_CHUNKS: usize = 8;
/// 短于此长度的内容不索引（无检索价值）
pub const MIN_TEXT_LEN: usize = 30;

pub fn chunk_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= CHUNK_SIZE * 2 {
        return vec![text.trim().to_string()];
    }
    chars
        .chunks(CHUNK_SIZE)
        .take(MAX_CHUNKS)
        .map(|c| c.iter().collect::<String>())
        .collect()
}

/// xxh3 内容哈希，用于 D11 去重（同 URL 内容变更才重 embed）
pub fn content_hash(text: &str) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(text.as_bytes()))
}

/// 索引价值预判：过滤纯空白/过短内容
pub fn is_indexable(text: &str) -> bool {
    text.trim().chars().count() >= MIN_TEXT_LEN
}
