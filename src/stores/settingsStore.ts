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
