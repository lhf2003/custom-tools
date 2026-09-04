//! 文本切块与内容哈希
//!
//! 语义分片（CASE-003）：
//! - 句级切分（\n 拆段 + 句末标点切句）贪心打包到 CHUNK_SIZE，单句超长硬切兜底；
//!   取代原按 char 机械切分（句子被劈开 → embedding 质量与 snippet 展示双损）
//! - 块尾整句 overlap（≤OVERLAP_CHARS）仅进 embed_text，不进 content：
//!   content 保持纯块文本（snippet 干净），去重哈希不受前块变更扩散
//! - 标题注入 embed_text（≤TITLE_CHARS）：块内「它」「这个功能」等指代获得主题锚点；
//!   content 不含标题，展示不冗余
//! - 无块数上限：采集端各有上限（网页 2 万字符 ≈ 17 块），host 帧长 MAX_FRAME_BYTES 兜底；
//!   原 MAX_CHUNKS=8 使长文后半永不入索引（召回漏洞），已删除
//!
//! chunk 大小取 1200 字符: spike 在此粒度下验证了 top-3 88%（设计文档原估 500，
//! 实测 1200 已达标且切块数减半，索引体积更省）。

/// 单块字符数（按 char 计，非字节）
pub const CHUNK_SIZE: usize = 1200;
/// overlap 前缀的最大字符数（块尾最后一句 ≤ 此值时整句带进下一块 embed_text）
pub const OVERLAP_CHARS: usize = 150;
/// 标题注入 embed_text 的最大字符数
pub const TITLE_CHARS: usize = 100;
/// 短于此长度的内容不索引（无检索价值）
pub const MIN_TEXT_LEN: usize = 30;

/// 分块结果：content 入库展示，embed_text 送 embedding（含标题/overlap 前缀，不入库）
#[derive(Debug, Clone)]
pub struct Chunk {
    /// 入库文本：纯块内容（句 join "\n"，无重叠无前缀）
    pub content: String,
    /// embed 输入：[标题\n\n][前块尾句\n]content
    pub embed_text: String,
}

/// xxh3 内容哈希，用于 D11 去重（对 embed_text 计算：标题/overlap 变更同样触发重 embed）
pub fn content_hash(text: &str) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(text.as_bytes()))
}

/// 索引价值预判：过滤纯空白/过短内容
pub fn is_indexable(text: &str) -> bool {
    text.trim().chars().count() >= MIN_TEXT_LEN
}

/// 句末标点判定：中文标点必断；英文标点要求后随非字母数字（避免 example.com / v1.2 误切）
fn is_sentence_end(chars: &[char], i: usize) -> bool {
    match chars[i] {
        '。' | '！' | '？' | '；' | '…' => true,
        '.' | '!' | '?' | ';' => chars.get(i + 1).is_none_or(|n| !n.is_ascii_alphanumeric()),
        _ => false,
    }
}

/// 切句：\n 拆段 → 段内句末标点切句，逐句 trim 去空
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split('\n') {
        let chars: Vec<char> = para.chars().collect();
        let mut start = 0;
        for i in 0..chars.len() {
            if is_sentence_end(&chars, i) {
                let sent = chars[start..=i].iter().collect::<String>().trim().to_string();
                if !sent.is_empty() {
                    out.push(sent);
                }
                start = i + 1;
            }
        }
        if start < chars.len() {
            let sent = chars[start..].iter().collect::<String>().trim().to_string();
            if !sent.is_empty() {
                out.push(sent);
            }
        }
    }
    out
}

/// 语义分片：切句 → 贪心打包（句间 \n 连接）→ 组装 content / embed_text。
/// 全空白输入返回空 Vec（调用方按 too_short 处理）。
pub fn chunk_text(title: Option<&str>, text: &str) -> Vec<Chunk> {
    let sentences = split_sentences(text);
    if sentences.is_empty() {
        return Vec::new();
    }

    // 贪心打包：句累积到 CHUNK_SIZE 封块；单句超长按 CHUNK_SIZE 硬切（独立成片）
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut cur_len = 0usize;
    for s in sentences {
        let slen = s.chars().count();
        if slen > CHUNK_SIZE {
            if !cur.is_empty() {
                blocks.push(std::mem::take(&mut cur));
                cur_len = 0;
            }
            let chars: Vec<char> = s.chars().collect();
            for piece in chars.chunks(CHUNK_SIZE) {
                blocks.push(vec![piece.iter().collect()]);
            }
        } else if !cur.is_empty() && cur_len + slen > CHUNK_SIZE {
            blocks.push(std::mem::take(&mut cur));
            cur.push(s);
            cur_len = slen + 1; // +1: join 的 \n
        } else {
            cur.push(s);
            cur_len += slen + 1;
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }

    let title_prefix = title.and_then(|t| {
        let t = t.chars().take(TITLE_CHARS).collect::<String>().trim().to_string();
        (!t.is_empty()).then(|| format!("{t}\n\n"))
    });

    blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            let content = block.join("\n");
            let mut embed_text = String::new();
            if let Some(tp) = &title_prefix {
                embed_text.push_str(tp);
            }
            // 前块尾句 overlap：整句 ≤OVERLAP_CHARS 用之，否则尾部截断（超长硬切片场景）
            if i > 0 {
                let prev_tail = blocks[i - 1].last().map(String::as_str).unwrap_or("");
                let tail_chars: Vec<char> = prev_tail.chars().collect();
                let tail: String = if tail_chars.len() <= OVERLAP_CHARS {
                    prev_tail.to_string()
                } else {
                    tail_chars[tail_chars.len() - OVERLAP_CHARS..].iter().collect()
                };
                embed_text.push_str(&tail);
                embed_text.push('\n');
            }
            embed_text.push_str(&content);
            Chunk { content, embed_text }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造 n 个不同内容的中文句（每句约 len 字符，含句末标点）
    fn sentences(n: usize, len: usize) -> String {
        (0..n)
            .map(|i| {
                let body = format!("第{i}句").chars().cycle().take(len - 1).collect::<String>();
                format!("{body}。")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn short_text_single_chunk_without_title() {
        let chunks = chunk_text(None, "  这是一段很短的内容。  ");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "这是一段很短的内容。");
        // 无标题无 overlap：embed_text == content
        assert_eq!(chunks[0].embed_text, chunks[0].content);
    }

    #[test]
    fn title_injected_only_into_embed_text() {
        let chunks = chunk_text(Some("Rust 权威指南"), "第一章讲所有权。");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "第一章讲所有权。");
        assert_eq!(chunks[0].embed_text, "Rust 权威指南\n\n第一章讲所有权。");
    }

    #[test]
    fn empty_title_not_injected() {
        let chunks = chunk_text(Some("   "), "内容。");
        assert_eq!(chunks[0].embed_text, "内容。");
    }

    #[test]
    fn packs_at_sentence_boundaries() {
        // 3 句各 600 字符：1200 装不下两句 → 3 块，每块完整句
        let text = sentences(3, 600);
        let chunks = chunk_text(None, &text);
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert!(c.content.ends_with('。'));
            assert!(!c.content.contains("\n\n"));
        }
    }

    #[test]
    fn multiple_sentences_packed_into_one_chunk() {
        let text = sentences(4, 100); // 4×100 < 1200
        let chunks = chunk_text(None, &text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content.matches('。').count(), 4);
    }

    #[test]
    fn overlap_from_previous_tail_sentence() {
        // 13 句 × 100 字符：第一块 11 句，尾句 100 ≤ OVERLAP_CHARS → 整句 overlap
        let text = sentences(13, 100);
        let chunks = chunk_text(None, &text);
        assert_eq!(chunks.len(), 2);
        let first_tail = chunks[0].content.split('\n').next_back().unwrap().to_string();
        // 第二块 embed_text 以第一块尾句开头，content 不含
        assert!(chunks[1].embed_text.starts_with(&first_tail));
        assert!(!chunks[1].content.contains(&first_tail));
        // 第一块无 overlap
        assert_eq!(chunks[0].embed_text, chunks[0].content);
    }

    #[test]
    fn oversized_sentence_hard_split() {
        let long = "字".repeat(2500); // 无标点超长句 → 1200+1200+100
        let chunks = chunk_text(None, &long);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].content.chars().count(), 1200);
        assert_eq!(chunks[2].content.chars().count(), 100);
        // 硬切片的 overlap 是尾部 150 字符截断
        let tail: String = chunks[0].content.chars().rev().take(150).collect::<String>().chars().rev().collect();
        assert!(chunks[1].embed_text.starts_with(&tail));
    }

    #[test]
    fn english_decimal_not_split() {
        let chunks = chunk_text(None, "价格是 3.5 元。第二句。");
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].content.contains("3.5"));
    }

    #[test]
    fn english_sentence_end_split() {
        // 英文句末 ". " 切开（对照组：3.5 小数不切），块内句间以 \n 连接
        let chunks = chunk_text(None, "First sentence. Second one.");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "First sentence.\nSecond one.");
    }

    #[test]
    fn blank_text_returns_empty() {
        assert!(chunk_text(None, "  \n \n ").is_empty());
    }

    #[test]
    fn long_document_no_truncation() {
        // 原 MAX_CHUNKS=8 截断已删：20 句 × 600 字符 = 20 块全保留
        let text = sentences(20, 600);
        let chunks = chunk_text(None, &text);
        assert_eq!(chunks.len(), 20);
    }
}
