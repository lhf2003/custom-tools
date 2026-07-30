//! 版本快照：任何程序化写入前先把当前版快照到 companion/backups/<文件>/<时间戳>.md，
//! 每文件滚动保留 20 份。回滚前也会先快照当前版——回滚本身可回滚。
//!
//! 目录布局：backups/evolution/20260730_143022.md 对应 evolution.md；
//! backups/skills/reporter/20260730_150111.md 对应 skills/reporter.md。

use std::path::{Path, PathBuf};

/// 每文件保留的快照份数（超出删最旧）
const KEEP: usize = 20;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BackupEntry {
    /// 被备份文件的 companion 相对路径（如 evolution.md / skills/reporter.md）
    pub file: String,
    /// 快照时间戳（yyyymmdd_HHMMSS，同秒连写带 _N 后缀）
    pub stamp: String,
}

fn backups_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("companion").join("backups")
}

/// 对 companion/ 下的相对路径做快照。文件不存在时跳过（Ok(None)）。
/// rel_path 只允许普通相对路径，拒绝父目录引用。
pub fn backup_file(app_data_dir: &Path, rel_path: &str) -> Result<Option<PathBuf>, String> {
    if rel_path.contains("..") || rel_path.starts_with(['/', '\\']) {
        return Err("非法备份路径".to_string());
    }
    let src = app_data_dir.join("companion").join(rel_path);
    if !src.exists() {
        return Ok(None);
    }
    let dir = backups_dir(app_data_dir).join(rel_path.trim_end_matches(".md"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {}", e))?;

    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    // 同秒连写防覆盖（滚动摘要/连续提案场景）
    let mut dest = dir.join(format!("{}.md", stamp));
    let mut seq = 1;
    while dest.exists() {
        dest = dir.join(format!("{}_{}.md", stamp, seq));
        seq += 1;
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("快照失败: {}", e))?;
    prune(&dir);
    Ok(Some(dest))
}

/// 列出全部备份（新的在前），按文件分组由前端负责。
pub fn list_backups(app_data_dir: &Path) -> Vec<BackupEntry> {
    let root = backups_dir(app_data_dir);
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    out
}

/// 回滚：先把当前版快照（可再回滚），再用备份覆盖。
pub fn rollback_backup(app_data_dir: &Path, file: &str, stamp: &str) -> Result<(), String> {
    if file.contains("..") || stamp.contains(['/', '\\']) || stamp.contains("..") {
        return Err("非法备份标识".to_string());
    }
    let src = backups_dir(app_data_dir)
        .join(file.trim_end_matches(".md"))
        .join(format!("{}.md", stamp));
    if !src.exists() {
        return Err("备份不存在".to_string());
    }
    backup_file(app_data_dir, file)?;
    let dest = app_data_dir.join("companion").join(file);
    std::fs::copy(&src, &dest).map_err(|e| format!("回滚失败: {}", e))?;
    Ok(())
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<BackupEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let (Some(stamp), Ok(rel)) = (
            path.file_stem().and_then(|s| s.to_str()),
            path.strip_prefix(root),
        ) else {
            continue;
        };
        // 目录部分 + .md 还原被备份文件的相对路径（统一为正斜杠）
        let Some(parent) = rel.parent() else { continue };
        let file = format!(
            "{}.md",
            parent
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        );
        out.push(BackupEntry {
            file,
            stamp: stamp.to_string(),
        });
    }
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    files.sort();
    while files.len() > KEEP {
        let _ = std::fs::remove_file(files.remove(0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_and_rollback_roundtrip() {
        let dir = std::env::temp_dir().join(format!("backup_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("companion/skills")).unwrap();
        std::fs::write(dir.join("companion/skills/a.md"), "v1").unwrap();

        // 快照 → 改写 → 回滚
        backup_file(&dir, "skills/a.md").unwrap();
        std::fs::write(dir.join("companion/skills/a.md"), "v2").unwrap();
        let backups = list_backups(&dir);
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].file, "skills/a.md");
        rollback_backup(&dir, "skills/a.md", &backups[0].stamp).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("companion/skills/a.md")).unwrap(),
            "v1"
        );
        // 回滚前的 v2 也被快照（回滚可回滚）
        assert_eq!(list_backups(&dir).len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = std::env::temp_dir();
        assert!(backup_file(&dir, "../evil.md").is_err());
        assert!(rollback_backup(&dir, "../evil.md", "x").is_err());
        assert!(rollback_backup(&dir, "a.md", "../x").is_err());
    }
}
