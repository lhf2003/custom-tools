import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type ProviderType = 'openai' | 'ollama' | 'deepseek' | 'bailian' | 'custom';
export type ConnectionStatus = 'unknown' | 'connected' | 'disconnected' | 'error';
export type Scene = 'chat' | 'qa' | 'translate';

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
  base_url: string;
  api_key: string | null;
  providerType: ProviderType;
}

export interface UpdateProviderRequest {
  id: number;
  name?: string;
  label?: string;
  base_url?: string;
  api_key?: string | null;
  is_active?: boolean;
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

  // Scene actions
  loadSceneConfigs: () => Promise<void>;
  setSceneModel: (scene: Scene, providerId: number, modelId: string) => Promise<void>;
  getSceneModelInfo: (scene: Scene) => Promise<SceneModelInfo | null>;
}

export const useLlmProviderStore = create<LlmProviderState>((set, get) => ({
  providers: [],
  models: {},
  sceneConfigs: { chat: null, qa: null, translate: null },
  sceneModelInfo: { chat: null, qa: null, translate: null },
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
      const models = await invoke<Model[]>('refresh_llm_provider_models', { id });
      set((state) => ({
        models: { ...state.models, [id]: models },
      }));
      return models;
    } catch (err) {
      console.error('Failed to refresh models:', err);
      throw err;
    }
  },

  setProviderActive: async (id, isActive) => {
    try {
      const provider = await invoke<Provider>('set_llm_provider_active', { id, isActive });
      set((state) => ({
        providers: state.providers.map((p) => (p.id === provider.id ? provider : p)),
      }));
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
      throw err;
    }
  },

  setModelActive: async (modelId, isActive) => {
    try {
      const model = await invoke<Model>('set_llm_model_active', { modelId, isActive });
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

  loadSceneConfigs: async () => {
    try {
      const configs = await invoke<SceneConfig[]>('get_llm_scene_configs');
      const sceneConfigs: Record<Scene, SceneConfig | null> = { chat: null, qa: null, translate: null };
      configs.forEach((config) => {
        sceneConfigs[config.scene] = config;
      });
      set({ sceneConfigs });
    } catch (err) {
      console.error('Failed to load scene configs:', err);
      throw err;
    }
  },

  setSceneModel: async (scene, providerId, modelId) => {
    try {
      const config = await invoke<SceneConfig>('set_llm_scene_model', {
        scene,
        providerId,
        modelId,
      });
      set((state) => ({
        sceneConfigs: { ...state.sceneConfigs, [scene]: config },
      }));
    } catch (err) {
      console.error('Failed to set scene model:', err);
      throw err;
    }
  },

  getSceneModelInfo: async (scene) => {
    try {
      const info = await invoke<SceneModelInfo | null>('get_llm_scene_model_info', { scene });
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
