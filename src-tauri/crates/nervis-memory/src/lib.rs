//! nervis-memory: 多模态记忆检索共享 crate
//!
//! 设计来源: docs/architecture/2026-08-27-CASE-001-多模态记忆检索系统设计_01.md
//! 模型选型: docs/analysis/2026-08-27-CASE-002-bge中文检索spike报告_01.md (bge-small-zh-v1.5 fp32)

pub mod chunk;
pub mod embed;
pub mod store;

pub use embed::Embedder;
pub use store::{MemoryItem, SearchHit};
