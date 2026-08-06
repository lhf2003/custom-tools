import { MessageCircle, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ShellView } from '@/types';
import type { ViewPlugin, PluginTrigger } from './types';

/**
 * 插件注册表：import.meta.glob 编译期静态展开（非运行时扫描），
 * 目录中存在 plugin.ts 即成为插件，零登记。manifest eager、视图本体 lazy。
 */
const modules = import.meta.glob<{ default: ViewPlugin }>('../modules/*/plugin.ts', { eager: true });

const plugins: ViewPlugin[] = Object.values(modules).map((m) => m.default);

const byId = new Map<string, ViewPlugin>();
for (const plugin of plugins) {
  if (byId.has(plugin.id)) {
    console.error(`[plugins] 重复插件 id「${plugin.id}」，后注册者被忽略`);
    continue;
  }
  byId.set(plugin.id, plugin);
}

const byShortcutModuleId = new Map<string, ViewPlugin>();
for (const plugin of plugins) {
  if (plugin.shortcutModuleId) {
    byShortcutModuleId.set(plugin.shortcutModuleId, plugin);
  }
}

function byOrder(a: { order?: number }, b: { order?: number }): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
}

/** 全部插件，按 order 排序（缺的排最后） */
export function listPlugins(): ViewPlugin[] {
  return [...byId.values()].sort(byOrder);
}

export function getPlugin(id: string): ViewPlugin | undefined {
  return byId.get(id);
}

/** 插件视图 id 的唯一运行时校验入口；未知 id 的渲染回退 launcher */
export function isPluginView(id: string): boolean {
  return byId.has(id);
}

/** 后端 shortcut:open_module 的 moduleId → 插件（吸收 notes/passwords 旧 id） */
export function getPluginByShortcutModule(moduleId: string): ViewPlugin | undefined {
  return byShortcutModuleId.get(moduleId);
}

/**
 * 启动空闲时预热全部插件 chunk（本地并行拉取，不阻塞主线程）。
 * 预热后首次进入插件的 import() 立即 resolve，加载态消失。
 * 失败静默：预加载失败不影响运行，进入时懒加载仍会触发并走 ErrorBoundary 兜底。
 */
export function preloadPlugins(): void {
  for (const plugin of byId.values()) {
    plugin.load().catch(() => {
      /* 静默 */
    });
  }
}

/** 行首前缀命中某插件 trigger 时返回该插件与剩余参数文本；大小写敏感 */
export function matchTrigger(query: string): { plugin: ViewPlugin; trigger: PluginTrigger; arg: string } | null {
  for (const plugin of byId.values()) {
    for (const trigger of plugin.triggers ?? []) {
      if (query.startsWith(trigger.keyword)) {
        return { plugin, trigger, arg: query.slice(trigger.keyword.length).trim() };
      }
    }
  }
  return null;
}

/** 壳入口：封闭集合（壳自己是自己唯一的登记处，不构成同步点），与注册表插件合并进启动器结果 */
export interface ShellEntry {
  id: ShellView;
  name: string;
  icon: LucideIcon;
  aliases: string[];
  description?: string;
  order?: number;
}

export const SHELL_ENTRIES: readonly ShellEntry[] = [
  {
    id: 'chat',
    name: 'AI 聊天',
    icon: MessageCircle,
    aliases: ['ai', 'chat', 'gpt', 'llm'],
    description:
      '接入 OpenAI / DeepSeek / Ollama 等兼容接口的 AI 对话助手，支持普通聊天、知识问答、文本翻译三种模式，对话记录本地保存。',
    order: 0,
  },
  {
    id: 'settings',
    name: '设置',
    icon: Settings,
    aliases: ['settings', 'config', 'preferences'],
    order: 6,
  },
];
