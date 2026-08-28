//! sidecar 最小复现测试：单条 embed_query + 32 条真实文本 embed_documents
//! 用法: cargo run -p nervis-memory --example sidecar_smoke
//! 环境变量: NERVIS_WEMM_MODEL_DIR / NERVIS_WEMM_PYTHON / NERVIS_WEMM_SERVER / NERVIS_DB_PATH

use nervis_memory::sidecar::{MemoryEmbedder, SidecarEmbedder};
use rusqlite::Connection;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let mut emb = SidecarEmbedder::resolve_default()?;

    let t0 = Instant::now();
    emb.ping()?;
    println!("[ok] ping 耗时 {:?}", t0.elapsed());

    let t0 = Instant::now();
    let v = emb.embed_query("IVR 项目部署用的 kubectl 命令")?;
    println!("[ok] embed_query dim={} 耗时 {:?}", v.len(), t0.elapsed());

    let db = std::env::var("NERVIS_DB_PATH")
        .unwrap_or_else(|_| r"C:\Users\23851\AppData\Roaming\com.flowhub.app\flowhub.db".into());
    let conn = Connection::open(&db)?;
    let mut st = conn.prepare("SELECT content FROM memory_items ORDER BY id LIMIT 32")?;
    let texts: Vec<String> = st
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    println!("[..] embed_documents 32 条真实文本...");
    let t0 = Instant::now();
    let vs = emb.embed_documents(&texts)?;
    println!("[ok] embed_documents n={} dim={} 耗时 {:?}", vs.len(), vs[0].len(), t0.elapsed());
    Ok(())
}
