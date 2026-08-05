use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: i64,
    pub name: String,
    pub label: String,
    pub base_url: String,
    pub api_key_encrypted: Option<String>,
    pub provider_type: ProviderType,
    pub is_active: bool,
    pub connection_status: ConnectionStatus,
    pub last_connected_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// 注意：serde 用 lowercase（OpenAi -> "openai"），与前端 'openai' 字面量一致；
// 不能用 snake_case，否则 OpenAi 会变成 "open_ai"，Tauri 反序列化直接拒绝整个命令
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    #[default]
    OpenAi,
    Ollama,
    DeepSeek,
    Bailian,
    Custom,
}

impl std::fmt::Display for ProviderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderType::OpenAi => write!(f, "openai"),
            ProviderType::Ollama => write!(f, "ollama"),
            ProviderType::DeepSeek => write!(f, "deepseek"),
            ProviderType::Bailian => write!(f, "bailian"),
            ProviderType::Custom => write!(f, "custom"),
        }
    }
}

impl std::str::FromStr for ProviderType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(ProviderType::OpenAi),
            "ollama" => Ok(ProviderType::Ollama),
            "deepseek" => Ok(ProviderType::DeepSeek),
            "bailian" => Ok(ProviderType::Bailian),
            "custom" => Ok(ProviderType::Custom),
            _ => Err(format!("Unknown provider type: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    #[default]
    Unknown,
    Connected,
    Disconnected,
    Error,
}

impl std::fmt::Display for ConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionStatus::Unknown => write!(f, "unknown"),
            ConnectionStatus::Connected => write!(f, "connected"),
            ConnectionStatus::Disconnected => write!(f, "disconnected"),
            ConnectionStatus::Error => write!(f, "error"),
        }
    }
}

impl std::str::FromStr for ConnectionStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "unknown" => Ok(ConnectionStatus::Unknown),
            "connected" => Ok(ConnectionStatus::Connected),
            "disconnected" => Ok(ConnectionStatus::Disconnected),
            "error" => Ok(ConnectionStatus::Error),
            _ => Err(format!("Unknown connection status: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub id: i64,
    pub provider_id: i64,
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_active: bool,
    /// 可选单价（人民币/百万 token）：填了成本面板才估算金额，缺省只统计 token
    pub input_price_per_m: Option<f64>,
    /// 缓存命中输入单价（人民币/百万 token）：null = 未配置（缓存命中按 input_price 计）
    pub cached_input_price_per_m: Option<f64>,
    pub output_price_per_m: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneConfig {
    pub id: i64,
    pub scene: Scene,
    pub provider_id: i64,
    pub model_id: String,
    pub thinking_mode: bool,
    /// 思考强度（low/medium/high/max，档位按提供商能力提供），DeepSeek/OpenAI 系模型生效；缺省 medium
    pub reasoning_effort: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Scene {
    #[default]
    Chat,
    Qa,
    Translate,
    Companion,
    MemoryExtraction,
    Diary,
}

impl std::fmt::Display for Scene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Scene::Chat => write!(f, "chat"),
            Scene::Qa => write!(f, "qa"),
            Scene::Translate => write!(f, "translate"),
            Scene::Companion => write!(f, "companion"),
            Scene::MemoryExtraction => write!(f, "memory_extraction"),
            Scene::Diary => write!(f, "diary"),
        }
    }
}

impl std::str::FromStr for Scene {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "chat" | "闲聊" => Ok(Scene::Chat),
            "qa" | "问答" => Ok(Scene::Qa),
            "translate" | "翻译" => Ok(Scene::Translate),
            "companion" | "陪伴" => Ok(Scene::Companion),
            "memory_extraction" | "记忆提取" => Ok(Scene::MemoryExtraction),
            "diary" | "情感日记" => Ok(Scene::Diary),
            _ => Err(format!("Unknown scene: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProviderRequest {
    pub name: String,
    pub label: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub provider_type: ProviderType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProviderRequest {
    pub id: i64,
    pub name: Option<String>,
    pub label: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSceneModelRequest {
    pub scene: Scene,
    pub provider_id: i64,
    pub model_id: String,
    pub thinking_mode: bool,
    /// 思考强度（low/medium/high/max）；缺省 medium（Option 兼容旧前端不带此字段）
    pub reasoning_effort: Option<String>,
}

/// 思考强度合法值归一：low/medium/high/max 原样返回，其余回退 medium（写入边界防御）
pub fn normalize_reasoning_effort(v: &str) -> String {
    match v {
        "low" | "medium" | "high" | "max" => v.to_string(),
        _ => "medium".to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub models: Option<Vec<ModelInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneModelInfo {
    pub provider: Provider,
    pub model: Model,
}
