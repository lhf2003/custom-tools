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

  // JSON Formatter data (set when pasting JSON in launcher)
  jsonFormatterData: string | null;
  setJsonFormatterData: (data: string | null) => void;

  // Loading states
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
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

  // JSON Formatter
  jsonFormatterData: null,
  setJsonFormatterData: (data) => set({ jsonFormatterData: data }),

  // Loading
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
}));
