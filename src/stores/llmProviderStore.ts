import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { error as logError } from '@tauri-apps/plugin-log';

export type ProviderType = 'openai' | 'ollama' | 'deepseek' | 'bailian' | 'custom';
export type ConnectionStatus = 'unknown' | 'connected' | 'disconnected' | 'error';
export type Scene = 'chat' | 'qa' | 'translate' | 'companion' | 'memory_extraction' | 'diary';

export interface Provider {
  id: number;
  name: string;
  label: string;
  base_url: string;
  api_key_encrypted: string | null;
  provider_type: ProviderType;
  is_active: boolean;
  connection_status: ConnectionStatus;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Model {
  id: number;
  provider_id: number;
  model_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  /** 可选单价（人民币/百万 token），null = 未配置（成本面板只统计 token） */
  input_price_per_m: number | null;
  /** 缓存命中输入单价（人民币/百万 token），null = 未配置（缓存命中按 input_price 计） */
  cached_input_price_per_m: number | null;
  output_price_per_m: number | null;
  created_at: string;
  updated_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string | null;
}

export interface SceneConfig {
  id: number;
  scene: Scene;
  provider_id: number;
  model_id: string;
  thinking_mode: boolean;
  /** 思考强度（low/medium/high/max，档位按提供商能力提供），DeepSeek/OpenAI 系模型生效；缺省 medium */
  reasoning_effort: string;
  updated_at: string;
}

export interface SceneModelInfo {
  provider: Provider;
  model: Model;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  models: ModelInfo[] | null;
}

export interface CreateProviderRequest {
  name: string;
  label: string;
  baseUrl: string;  // camelCase to match Rust serde
  apiKey: string | null;  // camelCase to match Rust serde
  providerType: ProviderType;
}

export interface UpdateProviderRequest {
  id: number;
  name?: string;
  label?: string;
  baseUrl?: string;  // camelCase to match Rust serde
  apiKey?: string | null;  // camelCase to match Rust serde
  isActive?: boolean;  // camelCase to match Rust serde
}

interface LlmProviderState {
  providers: Provider[];
  models: Record<number, Model[]>; // provider_id -> models
  sceneConfigs: Record<Scene, SceneConfig | null>;
  sceneModelInfo: Record<Scene, SceneModelInfo | null>;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadProviders: () => Promise<void>;
  createProvider: (req: CreateProviderRequest) => Promise<Provider>;
  updateProvider: (req: UpdateProviderRequest) => Promise<Provider>;
  deleteProvider: (id: number) => Promise<void>;
  testProviderConnection: (id: number) => Promise<TestConnectionResult>;
  refreshProviderModels: (id: number) => Promise<Model[]>;
  setProviderActive: (id: number, isActive: boolean) => Promise<void>;

  // Model actions
  loadModels: (providerId: number) => Promise<Model[]>;
  setModelActive: (modelId: number, isActive: boolean) => Promise<void>;
  setModelPrice: (modelId: number, inputPrice: number | null, outputPrice: number | null, cachedInputPrice: number | null) => Promise<void>;

  // Scene actions
  loadSceneConfigs: () => Promise<void>;
  setSceneModel: (scene: Scene, providerId: number, modelId: string, thinkingMode?: boolean, reasoningEffort?: string) => Promise<void>;
  setSceneThinkingMode: (scene: Scene, thinkingMode: boolean) => Promise<void>;
  getSceneModelInfo: (scene: Scene) => Promise<SceneModelInfo | null>;
}

export const useLlmProviderStore = create<LlmProviderState>((set, get) => ({
  providers: [],
  models: {},
  sceneConfigs: { chat: null, qa: null, translate: null, companion: null, memory_extraction: null, diary: null },
  sceneModelInfo: { chat: null, qa: null, translate: null, companion: null, memory_extraction: null, diary: null },
  isLoading: false,
  error: null,

  loadProviders: async () => {
    set({ isLoading: true, error: null });
    try {
      const providers = await invoke<Provider[]>('get_llm_providers');
      set({ providers, isLoading: false });
    } catch (err) {
      const error = String(err);
      set({ error, isLoading: false });
      throw err;
    }
  },

  createProvider: async (req) => {
    try {
      const provider = await invoke<Provider>('create_llm_provider', { req });
      set((state) => ({
        providers: [...state.providers, provider],
      }));
      return provider;
    } catch (err) {
      console.error('Failed to create provider:', err);
      throw err;
    }
  },

  updateProvider: async (req) => {
    try {
      const provider = await invoke<Provider>('update_llm_provider', { req });
      set((state) => ({
        providers: state.providers.map((p) => (p.id === provider.id ? provider : p)),
      }));
      return provider;
    } catch (err) {
      console.error('Failed to update provider:', err);
      throw err;
    }
  },

  deleteProvider: async (id) => {
    try {
      await invoke('delete_llm_provider', { id });
      set((state) => ({
        providers: state.providers.filter((p) => p.id !== id),
        models: { ...state.models, [id]: [] },
      }));
    } catch (err) {
      console.error('Failed to delete provider:', err);
      throw err;
    }
  },

  testProviderConnection: async (id) => {
    try {
      const result = await invoke<TestConnectionResult>('test_llm_provider_connection', { id });
      // Refresh providers to get updated connection status
      await get().loadProviders();
      return result;
    } catch (err) {
      console.error('Failed to test connection:', err);
      throw err;
    }
  },

  refreshProviderModels: async (id) => {
    try {
      const models = await invoke<Model[]>('fetch_llm_models', { providerId: id });
      set((state) => ({
        models: { ...state.models, [id]: models },
      }));
      return models;
    } catch (err) {
      console.error('Failed to refresh models:', err);
      // 安装版无 DevTools，错误必须落盘（%LOCALAPPDATA%\com.flowhub.app\logs）才能排查
      logError(`刷新模型列表失败 (providerId=${id}): ${err}`).catch(() => {});
      throw err;
    }
  },

  setProviderActive: async (id, isActive) => {
    try {
      await invoke<void>('update_llm_provider', { req: { id, isActive } });
      await get().loadProviders();
    } catch (err) {
      console.error('Failed to set provider active:', err);
      throw err;
    }
  },

  loadModels: async (providerId) => {
    try {
      const models = await invoke<Model[]>('get_llm_models', { providerId });
      set((state) => ({
        models: { ...state.models, [providerId]: models },
      }));
      return models;
    } catch (err) {
      console.error('Failed to load models:', err);
      logError(`加载模型列表失败 (providerId=${providerId}): ${err}`).catch(() => {});
      throw err;
    }
  },

  setModelActive: async (modelId, isActive) => {
    try {
      const model = await invoke<Model>(isActive ? 'activate_llm_model' : 'deactivate_llm_model', { modelId });
      set((state) => ({
        models: {
          ...state.models,
          [model.provider_id]: state.models[model.provider_id]?.map((m) =>
            m.id === model.id ? model : m
          ) || [model],
        },
      }));
    } catch (err) {
      console.error('Failed to set model active:', err);
      throw err;
    }
  },

  setModelPrice: async (modelId, inputPrice, outputPrice, cachedInputPrice) => {
    try {
      const model = await invoke<Model>('set_llm_model_price', {
        modelId,
        inputPrice,
        outputPrice,
        cachedInputPrice,
      });
      set((state) => ({
        models: {
          ...state.models,
          [model.provider_id]: state.models[model.provider_id]?.map((m) =>
            m.id === model.id ? model : m
          ) || [model],
        },
      }));
    } catch (err) {
      console.error('Failed to set model price:', err);
      throw err;
    }
  },

  loadSceneConfigs: async () => {
    try {
      const configs = await invoke<SceneConfig[]>('get_scene_configs');
      const sceneConfigs: Record<Scene, SceneConfig | null> = { chat: null, qa: null, translate: null, companion: null, memory_extraction: null, diary: null };
      configs.forEach((config) => {
        sceneConfigs[config.scene] = config;
      });
      set({ sceneConfigs });
    } catch (err) {
      console.error('Failed to load scene configs:', err);
      throw err;
    }
  },

  setSceneModel: async (scene, providerId, modelId, thinkingMode = false, reasoningEffort = 'medium') => {
    try {
      const config = await invoke<SceneConfig>('set_scene_model', {
        req: { scene, providerId, modelId, thinkingMode, reasoningEffort },
      });
      set((state) => ({
        sceneConfigs: { ...state.sceneConfigs, [scene]: config },
      }));
    } catch (err) {
      console.error('Failed to set scene model:', err);
      throw err;
    }
  },

  setSceneThinkingMode: async (scene, thinkingMode) => {
    try {
      const currentConfig = get().sceneConfigs[scene];
      if (!currentConfig || !currentConfig.provider_id) {
        throw new Error('请先选择提供商和模型');
      }
      const config = await invoke<SceneConfig>('set_scene_model', {
        req: {
          scene,
          providerId: currentConfig.provider_id,
          modelId: currentConfig.model_id,
          thinkingMode,
          reasoningEffort: currentConfig.reasoning_effort ?? 'medium',
        },
      });
      set((state) => ({
        sceneConfigs: { ...state.sceneConfigs, [scene]: config },
      }));
    } catch (err) {
      console.error('Failed to set scene thinking mode:', err);
      throw err;
    }
  },

  getSceneModelInfo: async (scene) => {
    try {
      const info = await invoke<SceneModelInfo | null>('get_scene_model', { scene });
      set((state) => ({
        sceneModelInfo: { ...state.sceneModelInfo, [scene]: info },
      }));
      return info;
    } catch (err) {
      console.error('Failed to get scene model info:', err);
      throw err;
    }
  },
}));
