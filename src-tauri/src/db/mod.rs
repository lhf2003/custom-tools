use rusqlite::{Connection, Result};
use std::fs;
use std::path::{Path, PathBuf};
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
                content_type TEXT NOT NULL DEFAULT 'markdown',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Migration: A2UI 界面卡片消息（content_type='a2ui' 时 content 为协议 JSON）
        let _ = self.conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'markdown'",
            [],
        );

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
                scene TEXT NOT NULL UNIQUE CHECK (scene IN ('chat', 'qa', 'translate', 'companion', 'memory_extraction', 'diary')),
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

        // Migration: 模型单价（每百万 token 美元，可选；填了成本面板才算金额）
        let _ = self
            .conn
            .execute("ALTER TABLE llm_models ADD COLUMN input_price_per_m REAL", []);
        let _ = self
            .conn
            .execute("ALTER TABLE llm_models ADD COLUMN output_price_per_m REAL", []);

        // Migration: 聊天历史增量摘要（回退通道上下文组装用）——
        // summary = 已压缩的历史摘要；summarized_up_to = 摘要覆盖到的消息 id 水位
        let _ = self.conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN summarized_up_to INTEGER NOT NULL DEFAULT 0",
            [],
        );

        // LLM 调用观测日志：每次调用登记来源/通道/token/耗时/成本（成本面板数据源）
        // cached_input_tokens = 命中缓存的输入 token（含在 input_tokens 内）；
        // tool_call_count = 本次响应请求的工具调用次数（工具循环每轮各记一条）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_call_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                channel TEXT NOT NULL,
                scene TEXT,
                model TEXT,
                input_tokens INTEGER DEFAULT 0,
                cached_input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cost_usd REAL DEFAULT 0,
                duration_ms INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
                error TEXT,
                created_at INTEGER NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_call_logs_created ON llm_call_logs(created_at)",
            [],
        )?;

        // Migration: 统计页观测增强——缓存命中 token 与工具调用次数
        let _ = self.conn.execute(
            "ALTER TABLE llm_call_logs ADD COLUMN cached_input_tokens INTEGER DEFAULT 0",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE llm_call_logs ADD COLUMN tool_call_count INTEGER DEFAULT 0",
            [],
        );

        // Migration: 老库的 CHECK 约束不含 'companion'，SQLite 无法改 CHECK，需重建表
        self.migrate_scene_configs_check()?;

        // Insert default scene configs if not exists (provider_id and model_id are NULL initially)
        let default_scenes = ["chat", "qa", "translate", "companion", "memory_extraction", "diary"];
        for scene in &default_scenes {
            self.conn.execute(
                "INSERT OR IGNORE INTO llm_scene_configs (scene, provider_id, model_id) VALUES (?1, NULL, NULL)",
                [scene],
            )?;
        }

        // Companion tables (activity_log / habit_patterns / suggestions)
        crate::companion::db::init_tables(&self.conn)?;

        Ok(())
    }

    /// 老库 llm_scene_configs 的 CHECK 场景值列表不全（缺 companion / memory_extraction），
    /// SQLite 无法修改 CHECK，需 RENAME → 重建 → 显式列名拷贝 → DROP。
    /// 失败只记日志，不阻断启动（后果仅是新场景行插不进去，不丢老数据）。
    fn migrate_scene_configs_check(&self) -> Result<()> {
        let table_sql: Option<String> = self
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_scene_configs'",
                [],
                |row| row.get(0),
            )
            .ok();

        let needs_migration = table_sql
            .map(|sql| !sql.contains("'diary'"))
            .unwrap_or(false);
        if !needs_migration {
            return Ok(());
        }

        let result = (|| -> Result<()> {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(
                "ALTER TABLE llm_scene_configs RENAME TO llm_scene_configs_old;
                 CREATE TABLE llm_scene_configs (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     scene TEXT NOT NULL UNIQUE CHECK (scene IN ('chat', 'qa', 'translate', 'companion', 'memory_extraction', 'diary')),
                     provider_id INTEGER REFERENCES llm_providers(id),
                     model_id TEXT,
                     thinking_mode BOOLEAN DEFAULT 0,
                     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO llm_scene_configs (id, scene, provider_id, model_id, thinking_mode, updated_at)
                     SELECT id, scene, provider_id, model_id, thinking_mode, updated_at
                     FROM llm_scene_configs_old;
                 DROP TABLE llm_scene_configs_old;",
            )?;
            tx.commit()
        })();

        match result {
            Ok(_) => log::info!("llm_scene_configs 迁移完成：CHECK 约束已包含 diary"),
            Err(e) => log::error!("llm_scene_configs 迁移失败（旧约束保留）: {}", e),
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

    let db_path = app_dir.join(crate::DB_FILE_NAME);
    let conn = Connection::open(&db_path)?;

    let db = Database::new(conn);
    db.init_tables()?;

    // Store database connection in app state
    app_handle.manage(DatabaseState(db_path));

    Ok(())
}

pub struct DatabaseState(pub PathBuf);

/// 打开主库连接并启用外键约束。
/// SQLite 默认关闭外键（连接级开关，不持久化到库文件），不开则
/// `ON DELETE CASCADE` 形同虚设、向已删除父行的孤儿写入也不会被拒绝——
/// 聊天会话删除后 chat_messages 残留的根因。凡写 chat_sessions/chat_messages
/// 的路径必须走这里。
pub fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(conn)
}

fn get_app_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = app_handle
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_chat_tables(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL DEFAULT 'chat',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .unwrap();
    }

    #[test]
    fn open_connection_enables_foreign_keys() {
        let conn = open_connection(Path::new(":memory:")).unwrap();
        let enabled: bool = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert!(enabled, "open_connection 必须启用外键约束");
    }

    #[test]
    fn deleting_session_cascades_messages() {
        let conn = open_connection(Path::new(":memory:")).unwrap();
        setup_chat_tables(&conn);
        conn.execute("INSERT INTO chat_sessions (mode) VALUES ('chat')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'user', '你好')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM chat_sessions WHERE id = 1", [])
            .unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "删除会话应级联删除其全部消息");
    }

    #[test]
    fn orphan_message_insert_is_rejected() {
        let conn = open_connection(Path::new(":memory:")).unwrap();
        setup_chat_tables(&conn);

        let result = conn.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (999, 'user', '幽灵消息')",
            [],
        );
        assert!(result.is_err(), "向已删除/不存在的会话写消息必须被外键拒绝");
    }
}
