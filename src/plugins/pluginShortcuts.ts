import { invoke } from '@tauri-apps/api/core';

/**
 * 快捷键贡献点：启用插件的 manifest.shortcuts → Rust 动态注册（与内置快捷键同批）。
 * 冲突（OS 注册失败 / 格式非法）不阻塞插件使用：模块级缓存冲突表，市场 tab 标记 +
 * 打开插件时 toast 提示。
 */

/** Rust ShortcutConflict（snake_case） */
export interface PluginShortcutConflict {
  plugin_id: string;
  shortcut_id: string;
  key: string;
  reason: string;
}

// 模块级冲突表：pluginId → 冲突列表（每次同步重建）
let conflictsByPlugin: Record<string, PluginShortcutConflict[]> = {};

/** 查询某插件的快捷键冲突（市场行状态标记 / 打开插件时 toast） */
export function getPluginShortcutConflicts(pluginId: string): PluginShortcutConflict[] {
  return conflictsByPlugin[pluginId] ?? [];
}

/** 同步外部插件快捷键（Rust 注销旧的 + 注册新的），返回并缓存冲突列表 */
export async function syncPluginShortcuts(): Promise<PluginShortcutConflict[]> {
  const result = await invoke<PluginShortcutConflict[]>('sync_plugin_shortcuts');
  const byPlugin: Record<string, PluginShortcutConflict[]> = {};
  for (const conflict of result) {
    (byPlugin[conflict.plugin_id] ??= []).push(conflict);
  }
  conflictsByPlugin = byPlugin;
  return result;
}
