import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ViewMode } from '@/types';
import { SHELL_ENTRIES, listEnabledPlugins, listPlugins, type ShellEntry } from './registry';

/**
 * 启动器内置入口枚举：
 * 插件（注册表派生，按 order）+ 壳入口（SHELL_ENTRIES，封闭集合）。
 * 替代已删除的 src/constants/tools.ts（BUILT_IN_TOOLS）。
 * 别名参与搜索匹配。
 */
export interface LauncherEntry {
  id: string;
  name: string;
  icon: LucideIcon | ComponentType<{ className?: string; size?: number | string }>;
  aliases: string[];
  description?: string;
  order?: number;
}

function entryOf(plugin: { id: string; name: string; icon: LucideIcon | ComponentType<{ className?: string; size?: number | string }>; aliases: string[]; description?: string; order?: number }): LauncherEntry {
  return {
    id: plugin.id,
    name: plugin.name,
    icon: plugin.icon,
    aliases: plugin.aliases,
    description: plugin.description,
    order: plugin.order,
  };
}

function shellEntryOf(entry: ShellEntry): LauncherEntry {
  return {
    id: entry.id,
    name: entry.name,
    icon: entry.icon,
    aliases: entry.aliases,
    description: entry.description,
    order: entry.order,
  };
}

function byOrder(a: { order?: number }, b: { order?: number }): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
}

/** 全部内置入口：启用插件 + 壳，按 order 排序（缺的排最后）；禁用的内置插件不出现 */
export function listLauncherEntries(): LauncherEntry[] {
  return [...listEnabledPlugins().map(entryOf), ...SHELL_ENTRIES.map(shellEntryOf)].sort(byOrder);
}

/** 内置视图 id 集合（含壳视图） */
export function isLauncherEntryId(id: string): boolean {
  return [...listPlugins().map((p) => p.id), ...SHELL_ENTRIES.map((s) => s.id)].includes(id);
}

export function getLauncherEntry(id: string): LauncherEntry | undefined {
  return listLauncherEntries().find((entry) => entry.id === id);
}

/** 供打开视图时把入口 id 规整为 ViewMode（含壳视图字面量） */
export function entryIdToViewMode(id: string): ViewMode {
  return id as ViewMode;
}
