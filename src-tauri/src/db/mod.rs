use rusqlite::{Connection, Result};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod app_cache;
pub mod app_usage;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    pub fn init_tables(&self) -> Result<()> {
        // Clipboard history table
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                content_type TEXT NOT NULL CHECK (content_type IN ('text', 'image', 'file')),
                content_hash TEXT,
                source_app TEXT,
                is_favorite BOOLEAN DEFAULT 0,
                is_pinned BOOLEAN DEFAULT 0,
                tags TEXT,
                usage_count INTEGER DEFAULT 0,
                last_used_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Create indexes
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_history(created_at DESC)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_clipboard_type ON clipboard_history(content_type)",
            [],
        )?;

        // Notes metadata table
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                parent_id INTEGER,
                is_folder BOOLEAN DEFAULT 0,
                is_pinned BOOLEAN DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                tags TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (parent_id) REFERENCES notes(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Migration: add sort_order column if not exists
        let _ = self.conn.execute(
            "ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0",
            [],
        );

        // Create index for sort_order
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_notes_sort_order ON notes(sort_order)",
            [],
        )?;

        // Password categories
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS password_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT DEFAULT 'folder',
                color TEXT DEFAULT '#6366f1',
                sort_order INTEGER DEFAULT 0
            )",
            [],
        )?;

        // Password entries
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS password_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                username TEXT,
                encrypted_password TEXT NOT NULL,
                encrypted_notes TEXT,
                url TEXT,
                category_id INTEGER,
                favorite BOOLEAN DEFAULT 0,
                usage_count INTEGER DEFAULT 0,
                last_used_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES password_categories(id) ON DELETE SET NULL
            )",
            [],
        )?;

        // App usage tracking table (for "recently used" feature)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS app_usage (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                launch_count INTEGER DEFAULT 0,
                last_launch INTEGER,  -- unix timestamp
                search_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_app_usage_last_launch ON app_usage(last_launch DESC)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_app_usage_launch_count ON app_usage(launch_count DESC)",
            [],
        )?;

        // App cache table (for fast startup)
        app_cache::init_table(&self.conn)?;

        // Settings table
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Changelog table - stores version history and update notes
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS changelog (
                version TEXT PRIMARY KEY,
                release_date TEXT,
                content TEXT NOT NULL,
                is_read BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Chat sessions table
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL DEFAULT 'chat',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Chat messages table
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)",
            [],
        )?;

        // Insert default settings
        let defaults = [
            ("theme", "system"),
            ("shortcut_show", "Alt+Space"),
            ("clipboard_max_items", "100"),
            ("clipboard_keep_days", "30"),
            ("password_auto_lock", "300"),
            ("note_auto_save", "true"),
        ];

        for (key, value) in &defaults {
            self.conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
                [key, value],
            )?;
        }

        // LLM Providers table - stores provider configurations with encrypted API keys
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key_encrypted TEXT,
                provider_type TEXT NOT NULL DEFAULT 'openai',
                is_active BOOLEAN DEFAULT 1,
                connection_status TEXT DEFAULT 'unknown',
                last_connected_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // LLM Models table - stores models fetched from providers
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id INTEGER NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
                model_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(provider_id, model_id)
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_models_provider ON llm_models(provider_id)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_models_active ON llm_models(is_active)",
            [],
        )?;

        // LLM Scene Configs table - maps scenes to models
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_scene_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scene TEXT NOT NULL UNIQUE CHECK (scene IN ('chat', 'qa', 'translate')),
                provider_id INTEGER REFERENCES llm_providers(id),
                model_id TEXT,
                thinking_mode BOOLEAN DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Migration: add thinking_mode column if not exists (for existing tables)
        let _ = self.conn.execute(
            "ALTER TABLE llm_scene_configs ADD COLUMN thinking_mode BOOLEAN DEFAULT 0",
            [],
        );

        // Insert default scene configs if not exists (provider_id and model_id are NULL initially)
        let default_scenes = ["chat", "qa", "translate"];
        for scene in &default_scenes {
            self.conn.execute(
                "INSERT OR IGNORE INTO llm_scene_configs (scene, provider_id, model_id) VALUES (?1, NULL, NULL)",
                [scene],
            )?;
        }

        Ok(())
    }
}

pub fn init(app_handle: &tauri::AppHandle) -> Result<()> {
    let app_dir = get_app_dir(app_handle);
    fs::create_dir_all(&app_dir).map_err(|e| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some(format!("Failed to create app directory: {}", e)),
        )
    })?;

    let db_path = app_dir.join("custom-tools.db");
    let conn = Connection::open(&db_path)?;

    let db = Database::new(conn);
    db.init_tables()?;

    // Store database connection in app state
    app_handle.manage(DatabaseState(db_path));

    Ok(())
}

pub struct DatabaseState(pub PathBuf);

fn get_app_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    path
}
