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
  // autoSend=true:语音输入「发送给 AI」等场景——填入即直接发送,不进输入框草稿
  chatPrefill: string | null;
  chatPrefillAutoSend: boolean;
  setChatPrefill: (data: string | null, autoSend?: boolean) => void;
  /** 原子取走 prefill（取值+清除一步完成），已消费/无 prefill 返回 null */
  consumeChatPrefill: () => { text: string; autoSend: boolean } | null;

  // 剪贴板「发送给AI」→ 聊天附件管线：待附加的本地文件路径列表。
  // 与 chatPrefill 平行，但走 addFiles（图片压缩/文本读内容/视觉门槛），
  // 不再把图片路径当作纯文本塞进输入框。
  chatPendingFiles: string[];
  setChatPendingFiles: (paths: string[]) => void;
  /** 原子取走待附加文件路径（取值+清空一步完成） */
  consumeChatPendingFiles: () => string[];

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
  chatPrefillAutoSend: false,
  setChatPrefill: (data, autoSend = false) =>
    set({ chatPrefill: data, chatPrefillAutoSend: data !== null && autoSend }),
  // 原子消费（与 consumePayload 同模式）：StrictMode 双执行/热重挂载下第二次拿到
  // null 直接跳过——若先清后读分两步，第二次会用渲染闭包里的旧 chatPrefill +
  // 已被清空的 autoSend 标记把代发误判成预填（语音直发文本落进输入框）
  consumeChatPrefill: () => {
    const { chatPrefill, chatPrefillAutoSend } = get();
    if (chatPrefill === null) return null;
    set({ chatPrefill: null, chatPrefillAutoSend: false });
    return { text: chatPrefill, autoSend: chatPrefillAutoSend };
  },

  // 待附加文件路径（与 consumeChatPrefill 同模式的原子消费）
  chatPendingFiles: [],
  setChatPendingFiles: (paths) => set({ chatPendingFiles: paths }),
  consumeChatPendingFiles: () => {
    const { chatPendingFiles } = get();
    if (chatPendingFiles.length === 0) return [];
    set({ chatPendingFiles: [] });
    return chatPendingFiles;
  },

  // Loading
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
}));
