use tauri::{AppHandle, Manager, State};
use rusqlite::Connection;

use crate::db::DatabaseState;
use super::db::LlmProviderDb;
use super::fetcher;
use super::models::*;

#[tauri::command]
pub async fn get_llm_providers(
    db: State<'_, DatabaseState>,
) -> Result<Vec<Provider>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.get_all_providers(&conn)
}

#[tauri::command]
pub async fn create_llm_provider(
    db: State<'_, DatabaseState>,
    app_handle: AppHandle,
    req: CreateProviderRequest,
) -> Result<Provider, String> {
    log::info!("create_llm_provider called with name: {}, type: {}", req.name, req.provider_type);

    let conn = Connection::open(&db.0).map_err(|e| {
        log::error!("Failed to open database: {}", e);
        format!("打开数据库失败: {}", e)
    })?;
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| {
            log::error!("Failed to get app data dir: {}", e);
            format!("获取应用数据目录失败: {}", e)
        })?;

    let db_ops = LlmProviderDb;
    let result = db_ops.create_provider(&conn, req, &app_data_dir);
    log::info!("create_provider result: {:?}", result.is_ok());
    result
}

#[tauri::command]
pub async fn update_llm_provider(
    db: State<'_, DatabaseState>,
    app_handle: AppHandle,
    req: UpdateProviderRequest,
) -> Result<Provider, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let db_ops = LlmProviderDb;
    db_ops.update_provider(&conn, req, &app_data_dir)
}

#[tauri::command]
pub async fn delete_llm_provider(
    db: State<'_, DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.delete_provider(&conn, id)
}

#[tauri::command]
pub async fn test_llm_provider_connection(
    db: State<'_, DatabaseState>,
    app_handle: AppHandle,
    id: i64,
) -> Result<TestConnectionResult, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;

    let provider = db_ops.get_provider(&conn, id)?
        .ok_or_else(|| "提供商不存在".to_string())?;

    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    match fetcher::test_connection(&provider, &app_data_dir).await {
        Ok(models) => {
            db_ops.update_connection_status(&conn, id, ConnectionStatus::Connected)?;
            Ok(TestConnectionResult {
                success: true,
                message: format!("连接成功，获取到 {} 个模型", models.len()),
                models: Some(models),
            })
        }
        Err(e) => {
            db_ops.update_connection_status(&conn, id, ConnectionStatus::Error)?;
            Ok(TestConnectionResult {
                success: false,
                message: e,
                models: None,
            })
        }
    }
}

#[tauri::command]
pub async fn get_llm_models(
    db: State<'_, DatabaseState>,
    provider_id: i64,
) -> Result<Vec<Model>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.get_models_by_provider(&conn, provider_id)
}

#[tauri::command]
pub async fn fetch_llm_models(
    db: State<'_, DatabaseState>,
    app_handle: AppHandle,
    provider_id: i64,
) -> Result<Vec<Model>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;

    let provider = db_ops.get_provider(&conn, provider_id)?
        .ok_or_else(|| "提供商不存在".to_string())?;

    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    // Fetch models from provider API
    let models = fetcher::fetch_models(&provider, &app_data_dir).await?;

    // Save to database (preserves is_active status)
    db_ops.save_models(&conn, provider_id, models)?;

    // Return models from database (with is_active status)
    db_ops.get_models_by_provider(&conn, provider_id)
}

#[tauri::command]
pub async fn activate_llm_model(
    db: State<'_, DatabaseState>,
    model_id: i64,
) -> Result<Model, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.activate_model(&conn, model_id)?;
    // Return the updated model
    db_ops.get_model_by_id(&conn, model_id)?
        .ok_or_else(|| "模型不存在".to_string())
}

#[tauri::command]
pub async fn deactivate_llm_model(
    db: State<'_, DatabaseState>,
    model_id: i64,
) -> Result<Model, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.deactivate_model(&conn, model_id)?;
    // Return the updated model
    db_ops.get_model_by_id(&conn, model_id)?
        .ok_or_else(|| "模型不存在".to_string())
}

#[tauri::command]
pub async fn get_active_llm_models(
    db: State<'_, DatabaseState>,
) -> Result<Vec<Model>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.get_active_models(&conn)
}

#[tauri::command]
pub async fn get_scene_configs(
    db: State<'_, DatabaseState>,
) -> Result<Vec<SceneConfig>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.get_scene_configs(&conn)
}

#[tauri::command]
pub async fn set_scene_model(
    db: State<'_, DatabaseState>,
    req: SetSceneModelRequest,
) -> Result<SceneConfig, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;
    db_ops.set_scene_model(&conn, req.scene, req.provider_id, &req.model_id, req.thinking_mode)
}

#[tauri::command]
pub async fn get_scene_model(
    db: State<'_, DatabaseState>,
    scene: Scene,
) -> Result<Option<SceneModelInfo>, String> {
    let conn = Connection::open(&db.0).map_err(|e| format!("打开数据库失败: {}", e))?;
    let db_ops = LlmProviderDb;

    let result = db_ops.get_scene_model(&conn, scene)?;

    Ok(result.map(|(provider, model)| SceneModelInfo { provider, model }))
}
