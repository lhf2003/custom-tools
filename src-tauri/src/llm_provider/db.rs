use rusqlite::{Connection, OptionalExtension, Result};
use std::path::Path;

use super::models::*;
use super::crypto::encrypt;

pub struct LlmProviderDb;

impl LlmProviderDb {
    // Provider CRUD
    pub fn create_provider(
        &self,
        conn: &Connection,
        req: CreateProviderRequest,
        app_data_dir: &Path,
    ) -> Result<Provider, String> {
        let api_key_encrypted = req
            .api_key
            .as_ref()
            .filter(|k| !k.is_empty())
            .map(|k| encrypt(k, app_data_dir))
            .transpose()?;

        let provider_type_str = req.provider_type.to_string();
        let now = chrono::Local::now().to_rfc3339();

        let api_key_for_insert = api_key_encrypted.clone().unwrap_or_default();

        conn.execute(
            "INSERT INTO llm_providers (
                name, label, base_url, api_key_encrypted, provider_type,
                is_active, connection_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            [
                &req.name,
                &req.label,
                &req.base_url,
                &api_key_for_insert,
                &provider_type_str,
                "1",
                "unknown",
                &now,
                &now,
            ],
        )
        .map_err(|e| format!("创建提供商失败: {}", e))?;

        let id = conn.last_insert_rowid();

        Ok(Provider {
            id,
            name: req.name,
            label: req.label,
            base_url: req.base_url,
            api_key_encrypted,
            provider_type: req.provider_type,
            is_active: true,
            connection_status: ConnectionStatus::Unknown,
            last_connected_at: None,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn get_provider(&self, conn: &Connection, id: i64) -> Result<Option<Provider>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, label, base_url, api_key_encrypted, provider_type,
                        is_active, connection_status, last_connected_at, created_at, updated_at
                 FROM llm_providers WHERE id = ?1",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let provider = stmt
            .query_row([id], |row| {
                let provider_type_str: String = row.get(5)?;
                let connection_status_str: String = row.get(7)?;

                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    label: row.get(2)?,
                    base_url: row.get(3)?,
                    api_key_encrypted: row.get(4)?,
                    provider_type: provider_type_str.parse().unwrap_or_default(),
                    is_active: row.get(6)?,
                    connection_status: connection_status_str.parse().unwrap_or_default(),
                    last_connected_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .optional()
            .map_err(|e| format!("查询提供商失败: {}", e))?;

        Ok(provider)
    }

    pub fn get_all_providers(&self, conn: &Connection) -> Result<Vec<Provider>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, label, base_url, api_key_encrypted, provider_type,
                        is_active, connection_status, last_connected_at, created_at, updated_at
                 FROM llm_providers ORDER BY created_at DESC",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let providers = stmt
            .query_map([], |row| {
                let provider_type_str: String = row.get(5)?;
                let connection_status_str: String = row.get(7)?;

                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    label: row.get(2)?,
                    base_url: row.get(3)?,
                    api_key_encrypted: row.get(4)?,
                    provider_type: provider_type_str.parse().unwrap_or_default(),
                    is_active: row.get(6)?,
                    connection_status: connection_status_str.parse().unwrap_or_default(),
                    last_connected_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("查询提供商列表失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集提供商数据失败: {}", e))?;

        Ok(providers)
    }

    pub fn update_provider(
        &self,
        conn: &Connection,
        req: UpdateProviderRequest,
        app_data_dir: &Path,
    ) -> Result<Provider, String> {
        let provider = self
            .get_provider(conn, req.id)?
            .ok_or_else(|| "提供商不存在".to_string())?;

        let name = req.name.unwrap_or(provider.name);
        let label = req.label.unwrap_or(provider.label);
        let base_url = req.base_url.unwrap_or(provider.base_url);
        let is_active = req.is_active.unwrap_or(provider.is_active);

        let api_key_encrypted = if let Some(api_key) = req.api_key {
            if api_key.is_empty() {
                None
            } else {
                Some(encrypt(&api_key, app_data_dir)?)
            }
        } else {
            provider.api_key_encrypted
        };

        let now = chrono::Local::now().to_rfc3339();

        let is_active_str = if is_active { "1".to_string() } else { "0".to_string() };
        let api_key_str = api_key_encrypted.as_deref().unwrap_or("").to_string();

        conn.execute(
            "UPDATE llm_providers SET
                name = ?1,
                label = ?2,
                base_url = ?3,
                api_key_encrypted = ?4,
                is_active = ?5,
                updated_at = ?6
             WHERE id = ?7",
            [
                &name,
                &label,
                &base_url,
                &api_key_str,
                &is_active_str,
                &now,
                &req.id.to_string(),
            ],
        )
        .map_err(|e| format!("更新提供商失败: {}", e))?;

        Ok(Provider {
            id: req.id,
            name,
            label,
            base_url,
            api_key_encrypted,
            provider_type: provider.provider_type,
            is_active,
            connection_status: provider.connection_status,
            last_connected_at: provider.last_connected_at,
            created_at: provider.created_at,
            updated_at: now,
        })
    }

    pub fn delete_provider(&self, conn: &Connection, id: i64) -> Result<bool, String> {
        let rows_affected = conn
            .execute("DELETE FROM llm_providers WHERE id = ?1", [id])
            .map_err(|e| format!("删除提供商失败: {}", e))?;

        Ok(rows_affected > 0)
    }

    pub fn update_connection_status(
        &self,
        conn: &Connection,
        id: i64,
        status: ConnectionStatus,
    ) -> Result<(), String> {
        let now = chrono::Local::now().to_rfc3339();
        let status_str = status.to_string();

        let sql = if status == ConnectionStatus::Connected {
            "UPDATE llm_providers SET connection_status = ?1, last_connected_at = ?2, updated_at = ?3 WHERE id = ?4"
        } else {
            "UPDATE llm_providers SET connection_status = ?1, updated_at = ?2 WHERE id = ?3"
        };

        if status == ConnectionStatus::Connected {
            conn.execute(sql, [&status_str, &now, &now, &id.to_string()])
        } else {
            conn.execute(sql, [&status_str, &now, &id.to_string()])
        }
        .map_err(|e| format!("更新连接状态失败: {}", e))?;

        Ok(())
    }

    // Model 操作
    pub fn save_models(
        &self,
        conn: &Connection,
        provider_id: i64,
        models: Vec<ModelInfo>,
    ) -> Result<Vec<Model>, String> {
        let now = chrono::Local::now().to_rfc3339();
        let mut saved_models = Vec::new();

        for model_info in models {
            let description_str = model_info.description.as_deref().unwrap_or("").to_string();

            // Use INSERT ... ON CONFLICT DO UPDATE to preserve is_active status
            conn.execute(
                "INSERT INTO llm_models (
                    provider_id, model_id, name, description, is_active, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(provider_id, model_id) DO UPDATE SET
                    name = excluded.name,
                    description = excluded.description,
                    updated_at = excluded.updated_at
                -- Note: is_active is NOT updated, preserving user's preference",
                [
                    &provider_id.to_string(),
                    &model_info.id,
                    &model_info.name,
                    &description_str,
                    "0", // Default is_active for new records
                    &now,
                ],
            )
            .map_err(|e| format!("保存模型失败: {}", e))?;

            // Query the model to get its current state (including is_active)
            let model = conn.query_row(
                "SELECT id, provider_id, model_id, name, description, is_active, created_at, updated_at
                 FROM llm_models WHERE provider_id = ?1 AND model_id = ?2",
                [&provider_id.to_string(), &model_info.id],
                |row| {
                    Ok(Model {
                        id: row.get(0)?,
                        provider_id: row.get(1)?,
                        model_id: row.get(2)?,
                        name: row.get(3)?,
                        description: row.get(4)?,
                        is_active: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            ).map_err(|e| format!("查询保存的模型失败: {}", e))?;

            saved_models.push(model);
        }

        Ok(saved_models)
    }

    pub fn get_models_by_provider(&self, conn: &Connection, provider_id: i64) -> Result<Vec<Model>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider_id, model_id, name, description, is_active, created_at, updated_at
                 FROM llm_models WHERE provider_id = ?1 ORDER BY name",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let models = stmt
            .query_map([provider_id], |row| {
                Ok(Model {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    model_id: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    is_active: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询模型列表失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集模型数据失败: {}", e))?;

        Ok(models)
    }

    pub fn get_model_by_id(&self, conn: &Connection, model_id: i64) -> Result<Option<Model>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider_id, model_id, name, description, is_active, created_at, updated_at
                 FROM llm_models WHERE id = ?1",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let model = stmt
            .query_row([model_id], |row| {
                Ok(Model {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    model_id: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    is_active: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .optional()
            .map_err(|e| format!("查询模型失败: {}", e))?;

        Ok(model)
    }

    pub fn activate_model(&self, conn: &Connection, model_id: i64) -> Result<bool, String> {
        let rows_affected = conn
            .execute(
                "UPDATE llm_models SET is_active = 1, updated_at = ?1 WHERE id = ?2",
                [chrono::Local::now().to_rfc3339(), model_id.to_string()],
            )
            .map_err(|e| format!("激活模型失败: {}", e))?;

        Ok(rows_affected > 0)
    }

    pub fn deactivate_model(&self, conn: &Connection, model_id: i64) -> Result<bool, String> {
        let rows_affected = conn
            .execute(
                "UPDATE llm_models SET is_active = 0, updated_at = ?1 WHERE id = ?2",
                [chrono::Local::now().to_rfc3339(), model_id.to_string()],
            )
            .map_err(|e| format!("停用模型失败: {}", e))?;

        Ok(rows_affected > 0)
    }

    pub fn get_active_models(&self, conn: &Connection) -> Result<Vec<Model>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, provider_id, model_id, name, description, is_active, created_at, updated_at
                 FROM llm_models WHERE is_active = 1 ORDER BY name",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let models = stmt
            .query_map([], |row| {
                Ok(Model {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    model_id: row.get(2)?,
                    name: row.get(3)?,
                    description: row.get(4)?,
                    is_active: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询激活模型失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集模型数据失败: {}", e))?;

        Ok(models)
    }

    // SceneConfig 操作
    pub fn get_scene_configs(&self, conn: &Connection) -> Result<Vec<SceneConfig>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, scene, provider_id, model_id, thinking_mode, updated_at
                 FROM llm_scene_configs ORDER BY scene",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let configs = stmt
            .query_map([], |row| {
                let scene_str: String = row.get(1)?;
                Ok(SceneConfig {
                    id: row.get(0)?,
                    scene: scene_str.parse().unwrap_or_default(),
                    provider_id: row.get(2)?,
                    model_id: row.get(3)?,
                    thinking_mode: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("查询场景配置失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集场景配置数据失败: {}", e))?;

        Ok(configs)
    }

    pub fn set_scene_model(
        &self,
        conn: &Connection,
        scene: Scene,
        provider_id: i64,
        model_id: &str,
        thinking_mode: bool,
    ) -> Result<SceneConfig, String> {
        let scene_str = scene.to_string();
        let now = chrono::Local::now().to_rfc3339();
        let thinking_mode_val = if thinking_mode { "1" } else { "0" };

        conn.execute(
            "INSERT INTO llm_scene_configs (scene, provider_id, model_id, thinking_mode, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(scene) DO UPDATE SET
                provider_id = excluded.provider_id,
                model_id = excluded.model_id,
                thinking_mode = excluded.thinking_mode,
                updated_at = excluded.updated_at",
            [&scene_str, &provider_id.to_string(), model_id, thinking_mode_val, &now],
        )
        .map_err(|e| format!("设置场景模型失败: {}", e))?;

        let id = conn.last_insert_rowid();

        Ok(SceneConfig {
            id,
            scene,
            provider_id,
            model_id: model_id.to_string(),
            thinking_mode,
            updated_at: now,
        })
    }

    pub fn get_scene_thinking_mode(&self, conn: &Connection, scene: Scene) -> Result<bool, String> {
        let scene_str = scene.to_string();
        let thinking_mode: bool = conn.query_row(
            "SELECT thinking_mode FROM llm_scene_configs WHERE scene = ?1",
            [&scene_str],
            |row| row.get(0),
        ).unwrap_or(false);
        Ok(thinking_mode)
    }

    pub fn get_scene_model(&self, conn: &Connection, scene: Scene) -> Result<Option<(Provider, Model)>, String> {
        let scene_str = scene.to_string();

        let result = conn.query_row(
            "SELECT
                p.id, p.name, p.label, p.base_url, p.api_key_encrypted, p.provider_type,
                p.is_active, p.connection_status, p.last_connected_at, p.created_at, p.updated_at,
                m.id, m.provider_id, m.model_id, m.name, m.description, m.is_active, m.created_at, m.updated_at
             FROM llm_scene_configs sc
             JOIN llm_providers p ON sc.provider_id = p.id
             JOIN llm_models m ON sc.provider_id = m.provider_id AND sc.model_id = m.model_id
             WHERE sc.scene = ?1 AND p.is_active = 1 AND m.is_active = 1",
            [&scene_str],
            |row| {
                let provider_type_str: String = row.get(5)?;
                let connection_status_str: String = row.get(7)?;

                let provider = Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    label: row.get(2)?,
                    base_url: row.get(3)?,
                    api_key_encrypted: row.get(4)?,
                    provider_type: provider_type_str.parse().unwrap_or_default(),
                    is_active: row.get(6)?,
                    connection_status: connection_status_str.parse().unwrap_or_default(),
                    last_connected_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                };

                let model = Model {
                    id: row.get(11)?,
                    provider_id: row.get(12)?,
                    model_id: row.get(13)?,
                    name: row.get(14)?,
                    description: row.get(15)?,
                    is_active: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                };

                Ok((provider, model))
            },
        ).optional().map_err(|e| format!("查询场景模型失败: {}", e))?;

        Ok(result)
    }
}
