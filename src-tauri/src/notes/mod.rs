use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod fs;

/// Order metadata for a directory
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OrderMetadata {
    /// Map of item name to sort index
    order: HashMap<String, usize>,
}

/// Note item (file or folder)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    pub children: Option<Vec<NoteItem>>,
}

/// Note content with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteContent {
    pub path: String,
    pub name: String,
    pub content: String,
    pub last_modified: u64,
}

/// Notes manager
pub struct NotesManager {
    root_path: PathBuf,
}

/// Order info for items
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReorderRequest {
    pub parent_path: String,
    pub item_names: Vec<String>,
}

impl NotesManager {
    pub fn new(root_path: PathBuf) -> Self {
        Self { root_path }
    }

    /// Get order metadata file path for a directory
    fn get_order_file_path(&self, dir: &Path) -> PathBuf {
        dir.join(".order.json")
    }

    /// Load order metadata for a directory
    fn load_order_metadata(&self, dir: &Path) -> OrderMetadata {
        let order_file = self.get_order_file_path(dir);
        if order_file.exists() {
            if let Ok(content) = std::fs::read_to_string(&order_file) {
                if let Ok(metadata) = serde_json::from_str(&content) {
                    return metadata;
                }
            }
        }
        OrderMetadata::default()
    }

    /// Save order metadata for a directory
    fn save_order_metadata(&self, dir: &Path, metadata: &OrderMetadata) -> anyhow::Result<()> {
        let order_file = self.get_order_file_path(dir);
        let content = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&order_file, content)?;
        Ok(())
    }

    pub fn get_root_path(&self) -> &Path {
        &self.root_path
    }

    pub fn set_root_path(&mut self, path: PathBuf) {
        self.root_path = path;
    }

    /// Build note tree recursively
    pub fn build_tree(&self) -> anyhow::Result<Vec<NoteItem>> {
        self.read_dir_recursive(&self.root_path, "")
    }

    fn read_dir_recursive(
        &self,
        dir: &Path,
        relative_path: &str,
    ) -> anyhow::Result<Vec<NoteItem>> {
        let mut items = Vec::new();

        if !dir.exists() {
            std::fs::create_dir_all(dir)?;
            return Ok(items);
        }

        // Load order metadata
        let order_metadata = self.load_order_metadata(dir);

        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files and common non-note files
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }

            let is_folder = path.is_dir();
            let item_relative_path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", relative_path, name)
            };

            let children = if is_folder {
                Some(self.read_dir_recursive(&path, &item_relative_path)?)
            } else {
                None
            };

            items.push(NoteItem {
                id: item_relative_path.clone(),
                name,
                path: item_relative_path,
                is_folder,
                children,
            });
        }

        // Sort by custom order first, then folders first, then by name
        items.sort_by(|a, b| {
            let order_a = order_metadata.order.get(&a.name).copied().unwrap_or(usize::MAX);
            let order_b = order_metadata.order.get(&b.name).copied().unwrap_or(usize::MAX);

            if order_a != order_b {
                return order_a.cmp(&order_b);
            }

            match (a.is_folder, b.is_folder) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            }
        });

        Ok(items)
    }

    /// Read note content
    pub fn read_note(&self, relative_path: &str) -> anyhow::Result<NoteContent> {
        let full_path = self.root_path.join(relative_path);

        if !full_path.exists() {
            return Err(anyhow::anyhow!("Note not found: {}", relative_path));
        }

        let content = std::fs::read_to_string(&full_path)?;
        let metadata = std::fs::metadata(&full_path)?;
        let last_modified = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();

        let name = full_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".to_string());

        Ok(NoteContent {
            path: relative_path.to_string(),
            name,
            content,
            last_modified,
        })
    }

    /// Write note content
    pub fn write_note(&self, relative_path: &str, content: &str) -> anyhow::Result<()> {
        let full_path = self.root_path.join(relative_path);

        // Ensure parent directory exists
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        std::fs::write(&full_path, content)?;

        Ok(())
    }

    /// Create new note
    pub fn create_note(&self, relative_path: &str) -> anyhow::Result<()> {
        let full_path = self.root_path.join(relative_path);

        // Add .md extension if not present
        let full_path = if !full_path.extension().is_some_and(|ext| ext == "md") {
            full_path.with_extension("md")
        } else {
            full_path
        };

        if full_path.exists() {
            return Err(anyhow::anyhow!("Note already exists"));
        }

        // Ensure parent directory exists
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Create with default content
        let file_name = full_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".to_string());

        let default_content = format!("# {}\n\n", file_name);
        std::fs::write(&full_path, default_content)?;

        Ok(())
    }

    /// Create new folder
    pub fn create_folder(&self, relative_path: &str) -> anyhow::Result<()> {
        let full_path = self.root_path.join(relative_path);

        if full_path.exists() {
            return Err(anyhow::anyhow!("Folder already exists"));
        }

        std::fs::create_dir_all(&full_path)?;

        Ok(())
    }

    /// Rename note or folder
    pub fn rename(&self, old_path: &str, new_name: &str) -> anyhow::Result<String> {
        let old_full_path = self.root_path.join(old_path);

        if !old_full_path.exists() {
            return Err(anyhow::anyhow!("Item not found"));
        }

        let parent = old_full_path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Cannot rename root"))?;

        let new_full_path = parent.join(new_name);

        if new_full_path.exists() {
            return Err(anyhow::anyhow!("An item with this name already exists"));
        }

        std::fs::rename(&old_full_path, &new_full_path)?;

        // Calculate new relative path
        let new_relative_path = new_full_path
            .strip_prefix(&self.root_path)?
            .to_string_lossy()
            .to_string();

        Ok(new_relative_path)
    }

    /// Delete note or folder
    pub fn delete(&self, relative_path: &str) -> anyhow::Result<()> {
        let full_path = self.root_path.join(relative_path);

        if !full_path.exists() {
            return Err(anyhow::anyhow!("Item not found"));
        }

        if full_path.is_dir() {
            std::fs::remove_dir_all(&full_path)?;
        } else {
            std::fs::remove_file(&full_path)?;
        }

        Ok(())
    }

    /// Reorder items in a directory
    /// parent_path: empty string means root directory
    pub fn reorder_items(&self, parent_path: &str, item_names: &[String]) -> anyhow::Result<()> {
        let dir = if parent_path.is_empty() {
            self.root_path.clone()
        } else {
            self.root_path.join(parent_path)
        };

        if !dir.exists() || !dir.is_dir() {
            return Err(anyhow::anyhow!("Directory not found"));
        }

        let mut metadata = OrderMetadata::default();
        for (index, name) in item_names.iter().enumerate() {
            metadata.order.insert(name.clone(), index);
        }

        self.save_order_metadata(&dir, &metadata)?;
        Ok(())
    }

    /// Move note or folder
    /// target_folder: empty string means root directory
    pub fn move_item(&self, source_path: &str, target_folder: &str) -> anyhow::Result<String> {
        let source_full = self.root_path.join(source_path);

        if !source_full.exists() {
            return Err(anyhow::anyhow!("Source not found"));
        }

        // If target_folder is empty, move to root
        let target_full = if target_folder.is_empty() {
            self.root_path.clone()
        } else {
            let target = self.root_path.join(target_folder);
            if !target.exists() || !target.is_dir() {
                return Err(anyhow::anyhow!("Target folder not found"));
            }
            target
        };

        let file_name = source_full
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("Invalid source path"))?;

        let new_full_path = target_full.join(file_name);

        if new_full_path.exists() {
            return Err(anyhow::anyhow!("An item with this name already exists in target folder"));
        }

        std::fs::rename(&source_full, &new_full_path)?;

        let new_relative_path = new_full_path
            .strip_prefix(&self.root_path)?
            .to_string_lossy()
            .to_string();

        Ok(new_relative_path)
    }
}

/// Get default notes directory
pub fn get_default_notes_dir() -> anyhow::Result<PathBuf> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| anyhow::anyhow!("Failed to get data directory"))?;
    Ok(data_dir.join("custom-tools").join("notes"))
}
