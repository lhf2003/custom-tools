import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ViewMode } from '@/types';

interface AppState {
  // Current active view
  activeView: ViewMode;
  setActiveView: (view: ViewMode) => void;

  // Window state
  isWindowVisible: boolean;
  showWindow: () => Promise<void>;
  hideWindow: () => Promise<void>;
  toggleWindow: () => Promise<void>;

  // Search state (for launcher)
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // 插件打开载荷：pluginId → 待消费载荷（unknown，插件自己 narrow）。
  // 覆盖「打开插件并携带数据」的通用需求，替代旧的 jsonFormatterData /
  // pendingOpenNotePath 专用字段（壳不再持有插件专属状态）。
  payloads: Record<string, unknown>;
  openPluginView: (id: string, payload?: unknown) => void;
  consumePayload: (id: string) => unknown;

  // Chat prefill (set by companion "AI 分析" suggestion)
  chatPrefill: string | null;
  setChatPrefill: (data: string | null) => void;

  // Loading states
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Default to launcher view
  activeView: 'launcher',
  setActiveView: (view) => set({ activeView: view }),

  // Window state
  isWindowVisible: false,
  showWindow: async () => {
    await invoke('show_window');
    set({ isWindowVisible: true });
  },
  hideWindow: async () => {
    await invoke('hide_window');
    set({ isWindowVisible: false });
  },
  toggleWindow: async () => {
    const visible = await invoke<boolean>('toggle_window');
    set({ isWindowVisible: visible });
  },

  // Search
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  // 插件打开载荷：写载荷（可选）+ 切视图；订阅式存储同时覆盖
  // 「插件未挂载（挂载时消费）」与「已挂载（订阅直接触发）」两种时序
  payloads: {},
  openPluginView: (id, payload) =>
    set((state) => ({
      activeView: id,
      payloads: payload === undefined
        ? state.payloads
        : { ...state.payloads, [id]: payload },
    })),
  // 读后清除：与旧 pendingOpenNotePath 的消费语义一致
  consumePayload: (id) => {
    const payload = get().payloads[id];
    if (payload !== undefined) {
      set((state) => {
        const next = { ...state.payloads };
        delete next[id];
        return { payloads: next };
      });
    }
    return payload;
  },

  // Chat prefill
  chatPrefill: null,
  setChatPrefill: (data) => set({ chatPrefill: data }),

  // Loading
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
}));
