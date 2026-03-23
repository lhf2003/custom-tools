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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneConfig {
    pub id: i64,
    pub scene: Scene,
    pub provider_id: i64,
    pub model_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Scene {
    #[default]
    Chat,
    Qa,
    Translate,
}

impl std::fmt::Display for Scene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Scene::Chat => write!(f, "chat"),
            Scene::Qa => write!(f, "qa"),
            Scene::Translate => write!(f, "translate"),
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
