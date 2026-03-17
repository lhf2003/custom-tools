use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use nucleo::pattern::{CaseMatching, Normalization, Pattern};

pub mod icon;

use crate::db::app_usage::{AppUsage, calculate_frequency_score};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppItem {
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
}

pub struct SearchIndex {
    apps: Vec<AppItem>,
    indexed: bool,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
        }
    }

    pub fn index_apps(&mut self) -> anyhow::Result<()> {
        if self.indexed {
            return Ok(());
        }

        let mut apps = Vec::new();
        let mut seen = HashSet::new();

        // System start menu
        let system_start_menu = PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        if system_start_menu.exists() {
            self.scan_directory(&system_start_menu, &mut apps, &mut seen)?;
        }

        // User start menu
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile)
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            if user_start_menu.exists() {
                self.scan_directory(&user_start_menu, &mut apps, &mut seen)?;
            }
        }

        // Desktop shortcuts
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let desktop = PathBuf::from(user_profile).join("Desktop");
            if desktop.exists() {
                self.scan_directory(&desktop, &mut apps, &mut seen)?;
            }
        }

        // Sort by name alphabetically
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        self.apps = apps;
        self.indexed = true;

        log::info!("Indexed {} applications", self.apps.len());

        Ok(())
    }

    fn scan_directory(
        &self,
        dir: &Path,
        apps: &mut Vec<AppItem>,
        seen: &mut HashSet<String>,
    ) -> anyhow::Result<()> {
        let entries = std::fs::read_dir(dir)?;

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                // Recursively scan subdirectories
                self.scan_directory(&path, apps, seen)?;
            } else if let Some(ext) = path.extension() {
                if ext.eq_ignore_ascii_case("lnk") {
                    if let Some(app) = self.parse_shortcut(&path) {
                        let key = format!("{}|{}", app.name.to_lowercase(), app.path.to_lowercase());
                        if seen.insert(key) {
                            apps.push(app);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn parse_shortcut(&self, path: &Path) -> Option<AppItem> {
        let file_stem = path.file_stem()?;
        let name = file_stem.to_string_lossy().to_string();

        // Clean up common suffixes
        let name = name
            .replace(" - 快捷方式", "")
            .replace(" - Shortcut", "")
            .trim()
            .to_string();

        if name.is_empty() {
            return None;
        }

        Some(AppItem {
            name,
            path: path.to_string_lossy().to_string(),
            icon: None,
        })
    }

    pub fn search(&self, query: &str) -> Vec<AppItem> {
        if query.is_empty() {
            return self.get_all();
        }

        // 使用 nucleo 进行模糊匹配
        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut matcher = nucleo::Matcher::new(nucleo::Config::DEFAULT);

        let mut scored: Vec<(u32, AppItem)> = self
            .apps
            .iter()
            .filter_map(|app| {
                let mut buf = Vec::new();
                pattern.score(nucleo::Utf32Str::new(&app.name, &mut buf), &mut matcher)
                    .map(|score| (score, app.clone()))
            })
            .collect();

        // 按匹配分数降序排列
        scored.sort_by(|a, b| b.0.cmp(&a.0));

        scored.into_iter().map(|(_, app)| app).collect()
    }

    /// Search with frequency-based ranking
    pub fn search_with_frequency(&self, query: &str, usages: &[AppUsage]) -> Vec<AppItem> {
        if query.is_empty() {
            return self.get_recently_used(usages);
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Build usage lookup map
        let usage_map: HashMap<&str, &AppUsage> = usages
            .iter()
            .map(|u| (u.path.as_str(), u))
            .collect();

        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut matcher = nucleo::Matcher::new(nucleo::Config::DEFAULT);

        let mut scored: Vec<(f64, AppItem)> = self
            .apps
            .iter()
            .filter_map(|app| {
                let mut buf = Vec::new();
                pattern.score(nucleo::Utf32Str::new(&app.name, &mut buf), &mut matcher)
                    .map(|match_score| {
                        // Base match score (normalized to 0-1)
                        let base_score = match_score as f64 / u32::MAX as f64;

                        // Frequency bonus (30% weight)
                        let freq_bonus = usage_map
                            .get(app.path.as_str())
                            .map(|u| calculate_frequency_score(u, now))
                            .unwrap_or(0.0) * 0.3;

                        let total_score = base_score * 0.7 + freq_bonus;
                        (total_score, app.clone())
                    })
            })
            .collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().map(|(_, app)| app).collect()
    }

    /// Get apps sorted by recency (for empty query)
    pub fn get_recently_used(&self, usages: &[AppUsage]) -> Vec<AppItem> {
        let usage_map: HashMap<&str, &AppUsage> = usages
            .iter()
            .map(|u| (u.path.as_str(), u))
            .collect();

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Sort all apps by frequency score
        let mut scored: Vec<(f64, &AppItem)> = self
            .apps
            .iter()
            .map(|app| {
                let score = usage_map
                    .get(app.path.as_str())
                    .map(|u| calculate_frequency_score(u, now))
                    .unwrap_or(0.0);
                (score, app)
            })
            .collect();

        // Sort by score descending
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // Return sorted apps
        scored.into_iter().map(|(_, app)| app.clone()).collect()
    }

    pub fn get_all(&self) -> Vec<AppItem> {
        self.apps.clone()
    }

    pub fn refresh(&mut self) -> anyhow::Result<()> {
        self.indexed = false;
        self.apps.clear();
        self.index_apps()
    }
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Launch an application by its shortcut path
#[cfg(windows)]
pub fn launch_app(path: &str) -> anyhow::Result<()> {
    use std::process::Command;

    Command::new("cmd")
        .args(["/c", "start", "", path])
        .spawn()?;

    Ok(())
}

#[cfg(not(windows))]
pub fn launch_app(_path: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!("Launching apps is only supported on Windows"))
}
