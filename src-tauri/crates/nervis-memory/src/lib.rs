//! nervis-memory: 多模态记忆检索共享 crate
//!
//! 设计来源: docs/architecture/2026-08-27-CASE-001-多模态记忆检索系统设计_01.md
//! 二期 N1 起 embedding 引擎为 WeMM sidecar（CASE-007; 一期 bge/ONNX 已完全卸载, Q6）

pub mod chunk;
pub mod sidecar;
pub mod store;

pub use sidecar::{MemoryEmbedder, SidecarEmbedder};
pub use store::{MemoryItem, SearchHit};
