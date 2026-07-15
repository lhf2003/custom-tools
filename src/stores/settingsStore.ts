import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface AppSettings {
  always_on_top: boolean;
  hide_on_blur: boolean;
  startup_launch: boolean;
  theme: string;
  window_opacity: number;
  clipboard_keep_days: number;
  auto_update: boolean;
  clipboard_auto_paste: boolean;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
  llm_thinking_mode: boolean;
  wormhole_enabled: boolean;
  wormhole_max_items: number;
  wormhole_auto_hide_seconds: number;
  claude_code_bin_path: string;
  claude_code_work_dir: string;
}

export interface ShortcutConfig {
  id: string;
  name: string;
  description: string;
  default_keys: string;
  custom_keys: string | null;
  enabled: boolean;
}

interface SettingsState extends AppSettings {
  isLoading: boolean;
  shortcuts: ShortcutConfig[];
  shortcutsLoading: boolean;

  // Actions
  loadSettings: () => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  toggleAlwaysOnTop: () => Promise<boolean>;
  setHideOnBlur: (enabled: boolean) => Promise<void>;
  toggleHideOnBlur: () => Promise<boolean>;
  setStartupLaunch: (enabled: boolean) => Promise<void>;
  toggleStartupLaunch: () => Promise<boolean>;
  setSetting: (key: string, value: string) => Promise<void>;
  setClipboardKeepDays: (days: number) => Promise<void>;
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  toggleAutoUpdate: () => Promise<boolean>;
  setClipboardAutoPaste: (enabled: boolean) => Promise<void>;
  toggleClipboardAutoPaste: () => Promise<boolean>;
  setLlmBaseUrl: (url: string) => Promise<void>;
  setLlmApiKey: (key: string) => Promise<void>;
  setLlmModel: (model: string) => Promise<void>;
  setLlmThinkingMode: (enabled: boolean) => Promise<void>;
  toggleLlmThinkingMode: () => Promise<boolean>;
  testLlmConnection: () => Promise<string>;

  // Wormhole Actions
  setWormholeEnabled: (enabled: boolean) => Promise<void>;
  setWormholeMaxItems: (count: number) => Promise<void>;
  setWormholeAutoHideSeconds: (seconds: number) => Promise<void>;
  setClaudeCodeBinPath: (path: string) => Promise<void>;
  setClaudeCodeWorkDir: (dir: string) => Promise<void>;

  // Shortcut Actions
  loadShortcuts: () => Promise<void>;
  updateShortcut: (id: string, customKeys: string | null, enabled: boolean) => Promise<void>;
  resetShortcut: (id: string) => Promise<void>;
  resetAllShortcuts: () => Promise<void>;
  checkShortcutConflict: (keys: string, excludeId?: string) => Promise<ShortcutConfig | null>;
}

const defaultSettings: AppSettings = {
  always_on_top: false,
  hide_on_blur: true,
  startup_launch: false,
  theme: 'system',
  window_opacity: 0.95,
  clipboard_keep_days: 30,
  auto_update: true,
  clipboard_auto_paste: true,
  llm_base_url: 'https://api.openai.com/v1',
  llm_api_key: '',
  llm_model: 'gpt-4o-mini',
  llm_thinking_mode: false,
  wormhole_enabled: true,
  wormhole_max_items: 20,
  wormhole_auto_hide_seconds: 30,
  claude_code_bin_path: 'claude',
  claude_code_work_dir: '',
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...defaultSettings,
  isLoading: true,
  shortcuts: [],
  shortcutsLoading: false,

  loadSettings: async () => {
    try {
      const settings = await invoke<AppSettings>('get_settings');
      set({ ...settings, isLoading: false });
    } catch (err) {
      console.error('Failed to load settings:', err);
      set({ isLoading: false });
    }
  },

  setAlwaysOnTop: async (enabled: boolean) => {
    try {
      await invoke('set_always_on_top', { enabled });
      set({ always_on_top: enabled });
    } catch (err) {
      console.error('Failed to set always_on_top:', err);
    }
  },

  toggleAlwaysOnTop: async () => {
    try {
      const newValue = await invoke<boolean>('toggle_always_on_top');
      set({ always_on_top: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle always_on_top:', err);
      return get().always_on_top;
    }
  },

  setHideOnBlur: async (enabled: boolean) => {
    try {
      await invoke('set_setting', { key: 'hide_on_blur', value: enabled.toString() });
      set({ hide_on_blur: enabled });
    } catch (err) {
      console.error('Failed to set hide_on_blur:', err);
    }
  },

  toggleHideOnBlur: async () => {
    try {
      const newValue = await invoke<boolean>('toggle_hide_on_blur');
      set({ hide_on_blur: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle hide_on_blur:', err);
      return get().hide_on_blur;
    }
  },

  setStartupLaunch: async (enabled: boolean) => {
    try {
      await invoke('set_startup_launch', { enabled });
      set({ startup_launch: enabled });
    } catch (err) {
      console.error('Failed to set startup_launch:', err);
    }
  },

  toggleStartupLaunch: async () => {
    try {
      const newValue = await invoke<boolean>('toggle_startup_launch');
      set({ startup_launch: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle startup_launch:', err);
      return get().startup_launch;
    }
  },

  setSetting: async (key: string, value: string) => {
    try {
      await invoke('set_setting', { key, value });
      // Update local state if it's a known setting
      if (key in get()) {
        set({ [key]: value } as Partial<SettingsState>);
      }
    } catch (err) {
      console.error('Failed to set setting:', err);
    }
  },

  setClipboardKeepDays: async (days: number) => {
    try {
      await invoke('set_setting', { key: 'clipboard_keep_days', value: days.toString() });
      set({ clipboard_keep_days: days });
    } catch (err) {
      console.error('Failed to set clipboard_keep_days:', err);
    }
  },

  setAutoUpdate: async (enabled: boolean) => {
    try {
      await invoke('set_setting', { key: 'auto_update', value: enabled.toString() });
      set({ auto_update: enabled });
    } catch (err) {
      console.error('Failed to set auto_update:', err);
    }
  },

  toggleAutoUpdate: async () => {
    try {
      const newValue = await invoke<boolean>('toggle_auto_update');
      set({ auto_update: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle auto_update:', err);
      return get().auto_update;
    }
  },

  setClipboardAutoPaste: async (enabled: boolean) => {
    try {
      await invoke('set_setting', { key: 'clipboard_auto_paste', value: enabled.toString() });
      set({ clipboard_auto_paste: enabled });
    } catch (err) {
      console.error('Failed to set clipboard_auto_paste:', err);
    }
  },

  toggleClipboardAutoPaste: async () => {
    try {
      const currentValue = get().clipboard_auto_paste;
      const newValue = !currentValue;
      await invoke('set_setting', { key: 'clipboard_auto_paste', value: newValue.toString() });
      set({ clipboard_auto_paste: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle clipboard_auto_paste:', err);
      return get().clipboard_auto_paste;
    }
  },

  setLlmBaseUrl: async (url: string) => {
    try {
      await invoke('set_setting', { key: 'llm_base_url', value: url });
      set({ llm_base_url: url });
    } catch (err) {
      console.error('Failed to set llm_base_url:', err);
    }
  },

  setLlmApiKey: async (key: string) => {
    try {
      await invoke('set_setting', { key: 'llm_api_key', value: key });
      set({ llm_api_key: key });
    } catch (err) {
      console.error('Failed to set llm_api_key:', err);
    }
  },

  setLlmModel: async (model: string) => {
    try {
      await invoke('set_setting', { key: 'llm_model', value: model });
      set({ llm_model: model });
    } catch (err) {
      console.error('Failed to set llm_model:', err);
    }
  },

  setLlmThinkingMode: async (enabled: boolean) => {
    try {
      await invoke('set_setting', { key: 'llm_thinking_mode', value: enabled.toString() });
      set({ llm_thinking_mode: enabled });
    } catch (err) {
      console.error('Failed to set llm_thinking_mode:', err);
    }
  },

  toggleLlmThinkingMode: async () => {
    try {
      const currentValue = get().llm_thinking_mode;
      const newValue = !currentValue;
      await invoke('set_setting', { key: 'llm_thinking_mode', value: newValue.toString() });
      set({ llm_thinking_mode: newValue });
      return newValue;
    } catch (err) {
      console.error('Failed to toggle llm_thinking_mode:', err);
      return get().llm_thinking_mode;
    }
  },

  // ==================== Wormhole Settings Actions ====================

  setWormholeEnabled: async (enabled: boolean) => {
    try {
      await invoke('set_setting', { key: 'wormhole_enabled', value: enabled.toString() });
      set({ wormhole_enabled: enabled });
    } catch (err) {
      console.error('Failed to set wormhole_enabled:', err);
    }
  },

  setWormholeMaxItems: async (count: number) => {
    try {
      await invoke('set_setting', { key: 'wormhole_max_items', value: count.toString() });
      set({ wormhole_max_items: count });
    } catch (err) {
      console.error('Failed to set wormhole_max_items:', err);
    }
  },

  setWormholeAutoHideSeconds: async (seconds: number) => {
    try {
      await invoke('set_setting', { key: 'wormhole_auto_hide_seconds', value: seconds.toString() });
      set({ wormhole_auto_hide_seconds: seconds });
    } catch (err) {
      console.error('Failed to set wormhole_auto_hide_seconds:', err);
    }
  },

  setClaudeCodeBinPath: async (path: string) => {
    try {
      await invoke('set_setting', { key: 'claude_code_bin_path', value: path });
      set({ claude_code_bin_path: path });
    } catch (err) {
      console.error('Failed to set claude_code_bin_path:', err);
    }
  },

  setClaudeCodeWorkDir: async (dir: string) => {
    try {
      await invoke('set_setting', { key: 'claude_code_work_dir', value: dir });
      set({ claude_code_work_dir: dir });
    } catch (err) {
      console.error('Failed to set claude_code_work_dir:', err);
    }
  },

  testLlmConnection: async () => {
    const result = await invoke<string>('test_llm_connection');
    return result;
  },

  // ==================== Shortcut Actions ====================

  loadShortcuts: async () => {
    set({ shortcutsLoading: true });
    try {
      const shortcuts = await invoke<ShortcutConfig[]>('get_shortcuts');
      set({ shortcuts, shortcutsLoading: false });
    } catch (err) {
      console.error('Failed to load shortcuts:', err);
      set({ shortcutsLoading: false });
    }
  },

  updateShortcut: async (id: string, customKeys: string | null, enabled: boolean) => {
    try {
      await invoke('update_shortcut', {
        id,
        customKeys,
        enabled,
      });
      // Reload shortcuts to reflect changes
      await get().loadShortcuts();
    } catch (err) {
      console.error('Failed to update shortcut:', err);
      throw err;
    }
  },

  resetShortcut: async (id: string) => {
    try {
      await invoke('reset_shortcut', { id });
      // Reload shortcuts to reflect changes
      await get().loadShortcuts();
    } catch (err) {
      console.error('Failed to reset shortcut:', err);
      throw err;
    }
  },

  resetAllShortcuts: async () => {
    try {
      await invoke('reset_all_shortcuts');
      // Reload shortcuts to reflect changes
      await get().loadShortcuts();
    } catch (err) {
      console.error('Failed to reset all shortcuts:', err);
      throw err;
    }
  },

  checkShortcutConflict: async (keys: string, excludeId?: string) => {
    try {
      const conflict = await invoke<ShortcutConfig | null>('check_shortcut_conflict', {
        keys,
        excludeId,
      });
      return conflict;
    } catch (err) {
      console.error('Failed to check shortcut conflict:', err);
      return null;
    }
  },
}));
