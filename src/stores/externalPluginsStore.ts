import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { refreshExternalPlugins } from '@/plugins/external';
import type { ExternalPluginManifest } from '@/plugins/external';

/**
 * 外部插件扫描结果的共享 store：设置页侧边导航（动态插件设置 tab）与
 * 插件市场列表共用同一数据源——市场页的启用/禁用/卸载/安装操作后 refresh，
 * 导航 tab 随 store 响应式增减，无需事件总线。
 */

/** 合并启用状态的外部插件条目 */
export interface ExternalPluginItem {
  manifest: ExternalPluginManifest;
  dirPath: string;
  error: string | null;
  enabled: boolean;
}

interface ExternalPluginsState {
  items: ExternalPluginItem[];
  /** 仅首次扫描完成前为 true（后续刷新不回到加载态，避免列表闪烁） */
  loading: boolean;
  /**
   * 完整刷新：Rust 扫描 → 注册表合流（含快捷键同步）→ 合并启用状态。
   * 失败仍会结束 loading 并抛错，由调用方决定如何提示（市场页 toast / 导航仅 console）。
   */
  refresh: () => Promise<void>;
}

export const useExternalPluginsStore = create<ExternalPluginsState>((set) => ({
  items: [],
  loading: true,

  refresh: async () => {
    try {
      const scanItems = await refreshExternalPlugins();
      const items: ExternalPluginItem[] = [];
      for (const item of scanItems) {
        if (!item.manifest) continue;
        const enabled = await invoke<string | null>('get_setting', {
          key: `plugins.${item.manifest.id}.enabled`,
        });
        items.push({
          manifest: item.manifest,
          dirPath: item.dir_path,
          error: item.error,
          enabled: enabled === '1',
        });
      }
      set({ items, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },
}));
