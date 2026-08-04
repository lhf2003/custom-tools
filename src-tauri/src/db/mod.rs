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
                source_exe TEXT,
                is_favorite BOOLEAN DEFAULT 0,
                is_pinned BOOLEAN DEFAULT 0,
                tags TEXT,
                usage_count INTEGER DEFAULT 0,
                last_used_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Migration: 来源应用 exe 路径（显示名 + 图标均由此派生，老库补列）
        ensure_column(
            &self.conn,
            "clipboard_history",
            "source_exe",
            "ALTER TABLE clipboard_history ADD COLUMN source_exe TEXT",
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
        ensure_column(
            &self.conn,
            "notes",
            "sort_order",
            "ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0",
        )?;

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

        // Settings table（通用 KV：用户偏好 + 陪伴模块状态共存，键空间互不重叠）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Shortcuts table（快捷键用户覆盖；默认配置在 settings::shortcuts 代码里，
        // 表只存 custom_keys/enabled 覆盖项）
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS shortcuts (
                id TEXT PRIMARY KEY,
                custom_keys TEXT,
                enabled BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        ensure_column(
            &self.conn,
            "chat_messages",
            "content_type",
            "ALTER TABLE chat_messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'markdown'",
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
                scene TEXT NOT NULL UNIQUE CHECK (scene IN ('chat', 'qa', 'translate', 'companion', 'memory_extraction', 'diary')),
                provider_id INTEGER REFERENCES llm_providers(id),
                model_id TEXT,
                thinking_mode BOOLEAN DEFAULT 0,
                reasoning_effort TEXT DEFAULT 'medium',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Migration: add thinking_mode column if not exists (for existing tables)
        ensure_column(
            &self.conn,
            "llm_scene_configs",
            "thinking_mode",
            "ALTER TABLE llm_scene_configs ADD COLUMN thinking_mode BOOLEAN DEFAULT 0",
        )?;

        // Migration: 场景思考强度（reasoning_effort：low/medium/high，DeepSeek/OpenAI 系生效）
        ensure_column(
            &self.conn,
            "llm_scene_configs",
            "reasoning_effort",
            "ALTER TABLE llm_scene_configs ADD COLUMN reasoning_effort TEXT DEFAULT 'medium'",
        )?;

        // Migration: 模型单价（每百万 token 人民币，可选；填了成本面板才算金额）
        ensure_column(
            &self.conn,
            "llm_models",
            "input_price_per_m",
            "ALTER TABLE llm_models ADD COLUMN input_price_per_m REAL",
        )?;
        ensure_column(
            &self.conn,
            "llm_models",
            "output_price_per_m",
            "ALTER TABLE llm_models ADD COLUMN output_price_per_m REAL",
        )?;

        // Migration: 聊天历史增量摘要（回退通道上下文组装用）——
        // summary = 已压缩的历史摘要；summarized_up_to = 摘要覆盖到的消息 id 水位
        ensure_column(
            &self.conn,
            "chat_sessions",
            "summary",
            "ALTER TABLE chat_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &self.conn,
            "chat_sessions",
            "summarized_up_to",
            "ALTER TABLE chat_sessions ADD COLUMN summarized_up_to INTEGER NOT NULL DEFAULT 0",
        )?;

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
                cost_cny REAL DEFAULT 0,
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

        // Shell 命令确认审计：每条用户确认/拒绝落痕（命令全文 + 决策 + 当时权限模式）。
        // 系统原生弹窗防伪造点击，审计表保证事后可追溯
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS shell_confirm_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command TEXT NOT NULL,
                allowed INTEGER NOT NULL,
                mode TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime'))
            )",
            [],
        )?;

        // Migration: 统计页观测增强——缓存命中 token 与工具调用次数
        ensure_column(
            &self.conn,
            "llm_call_logs",
            "cached_input_tokens",
            "ALTER TABLE llm_call_logs ADD COLUMN cached_input_tokens INTEGER DEFAULT 0",
        )?;
        ensure_column(
            &self.conn,
            "llm_call_logs",
            "tool_call_count",
            "ALTER TABLE llm_call_logs ADD COLUMN tool_call_count INTEGER DEFAULT 0",
        )?;

        // Migration: 成本单位美元 → 人民币（cost_usd → cost_cny）。
        // 改名成功即首次迁移（之后启动列已不存在会报错跳过）：历史美元成本清零、
        // 已填美元单价清空——用户重新按人民币填单价，成本重新累计。
        let cost_col_renamed = self
            .conn
            .execute(
                "ALTER TABLE llm_call_logs RENAME COLUMN cost_usd TO cost_cny",
                [],
            )
            .is_ok();
        if cost_col_renamed {
            self.conn
                .execute("UPDATE llm_call_logs SET cost_cny = 0", [])?;
            self.conn.execute(
                "UPDATE llm_models SET input_price_per_m = NULL, output_price_per_m = NULL",
                [],
            )?;
        }

        // Migration: 老库的 CHECK 约束不含 'companion'，SQLite 无法改 CHECK，需重建表
        self.migrate_scene_configs_check()?;

        // Insert default scene configs if not exists (provider_id and model_id are NULL initially)
        let default_scenes = [
            "chat",
            "qa",
            "translate",
            "companion",
            "memory_extraction",
            "diary",
        ];
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

    /// 一次性迁移：settings.db / shortcuts.db 两个独立小库并回 flowhub.db。
    /// 合并成功后旧文件改名 .bak-YYYYMMDD 保留（不删，防迁移有遗漏时无据可查）；
    /// 失败只记日志不阻断启动——旧文件还在，下次启动自动重试。
    fn migrate_legacy_db_files(&self, app_dir: &Path) {
        let stamp = chrono::Local::now().format("%Y%m%d");
        for file_name in ["settings.db", "shortcuts.db"] {
            let legacy_path = app_dir.join(file_name);
            if !legacy_path.exists() {
                continue;
            }
            if let Err(e) = self.merge_legacy_db(&legacy_path, file_name) {
                log::error!(
                    "合并 {} 进 flowhub.db 失败（保留原文件，下次启动重试）: {}",
                    file_name,
                    e
                );
                continue;
            }
            let bak_path = app_dir.join(format!("{}.bak-{}", file_name, stamp));
            match fs::rename(&legacy_path, &bak_path) {
                Ok(_) => log::info!(
                    "{} 已并入 flowhub.db，原文件备份为 {}",
                    file_name,
                    bak_path.display()
                ),
                // 数据已合并，改名失败不致命；旧文件留着下次启动会幂等重合并
                Err(e) => log::warn!("旧库 {} 改名备份失败: {}", file_name, e),
            }
        }
    }

    /// 把单个旧库文件的数据并入主库（settings.db 是当前用户偏好的真值源，
    /// 同键覆盖主库化石默认值；shortcuts 全量并入覆盖表）
    fn merge_legacy_db(&self, legacy_path: &Path, file_name: &str) -> Result<()> {
        self.conn.execute(
            "ATTACH DATABASE ?1 AS legacy",
            [legacy_path.to_string_lossy().as_ref()],
        )?;
        let merge_result = match file_name {
            "settings.db" => self.conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) SELECT key, value FROM legacy.settings",
                [],
            ),
            "shortcuts.db" => self.conn.execute(
                "INSERT OR REPLACE INTO shortcuts (id, custom_keys, enabled, created_at, updated_at)
                 SELECT id, custom_keys, enabled, created_at, updated_at FROM legacy.shortcuts",
                [],
            ),
            _ => unreachable!("migrate_legacy_db_files 只传入两个固定文件名"),
        };
        let detach_result = self.conn.execute("DETACH DATABASE legacy", []);
        merge_result?;
        detach_result?;
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

/// 幂等迁移：表已有目标列则跳过，没有才执行 ALTER。
/// 旧写法 `let _ = ALTER TABLE ADD COLUMN` 每次启动都执行必然失败的语句
/// （列已存在报 duplicate column name 被吞掉），且吞错会掩盖真实迁移失败——
/// 一旦因磁盘/锁错误没加上列，日志里毫无痕迹，运行时才报 no such column。
/// 失败只记日志不阻断启动（列缺失的后果由后续代码显式暴露）。
pub fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_ddl: &str,
) -> Result<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        [table, column],
        |row| row.get(0),
    )?;

    if exists > 0 {
        return Ok(false);
    }

    match conn.execute(alter_ddl, []) {
        Ok(_) => {
            log::info!("Migrated: added column {}.{}", table, column);
            Ok(true)
        }
        Err(e) => {
            log::error!("Migration failed: add column {}.{}: {}", table, column, e);
            Ok(false)
        }
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
    db.migrate_legacy_db_files(&app_dir);

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
    use crate::DB_FILE_NAME;

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

    /// 旧版独立小库（settings.db / shortcuts.db）并入主库：
    /// 行合并、主库既有键不受损、旧文件改名 .bak 且不再被二次迁移
    #[test]
    fn legacy_db_files_merge_into_main_db() {
        let dir = std::env::temp_dir().join(format!(
            "flowhub_migrate_test_{}_{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();

        // 造旧 settings.db：两行用户偏好
        let legacy_settings = Connection::open(dir.join("settings.db")).unwrap();
        legacy_settings
            .execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO settings VALUES ('debug_mode', 'true'), ('startup_launch', 'true');",
            )
            .unwrap();
        drop(legacy_settings);

        // 造旧 shortcuts.db：一行自定义快捷键
        let legacy_shortcuts = Connection::open(dir.join("shortcuts.db")).unwrap();
        legacy_shortcuts
            .execute_batch(
                "CREATE TABLE shortcuts (
                    id TEXT PRIMARY KEY, custom_keys TEXT, enabled BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO shortcuts (id, custom_keys, enabled) VALUES ('toggle_window', 'Ctrl+Alt+Space', 1);",
            )
            .unwrap();
        drop(legacy_shortcuts);

        // 主库：建表 + 预置一个陪伴模块的键（验证合并不误伤）
        let conn = Connection::open(dir.join(DB_FILE_NAME)).unwrap();
        let db = Database::new(conn);
        db.init_tables().unwrap();
        db.conn
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('daily_focus', '专注写代码')",
                [],
            )
            .unwrap();

        db.migrate_legacy_db_files(&dir);

        // 旧库行并入
        let debug_mode: String = db
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'debug_mode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(debug_mode, "true");
        let startup: String = db
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'startup_launch'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(startup, "true");
        let custom_keys: String = db
            .conn
            .query_row(
                "SELECT custom_keys FROM shortcuts WHERE id = 'toggle_window'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(custom_keys, "Ctrl+Alt+Space");

        // 主库既有键完好
        let focus: String = db
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'daily_focus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(focus, "专注写代码");

        // 旧文件已改名 .bak-*，二次迁移幂等（文件不存在直接跳过）
        assert!(!dir.join("settings.db").exists());
        assert!(!dir.join("shortcuts.db").exists());
        let baks: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".bak-"))
            .collect();
        assert_eq!(baks.len(), 2, "两个旧库都应改名备份");
        db.migrate_legacy_db_files(&dir);

        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }
}
