import { invoke } from '@tauri-apps/api/core';
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

/**
 * 内置插件启用状态（内存镜像 settings 表 builtin.<id>.enabled）：
 * 无设置 = 启用（默认），显式 '0' 为禁用。禁用 = 软删除：注册表保留
 * （当前打开的视图可继续渲染），入口层（启动器/trigger/快捷键）过滤。
 */
const disabledBuiltInIds = new Set<string>();

/** 加载内置插件启用状态（App 挂载时调用；外部插件 id 读 builtin key 不存在，自动跳过） */
export async function loadBuiltInPluginStates(): Promise<void> {
  for (const plugin of byId.values()) {
    if (externalIds.has(plugin.id)) continue;
    const enabled = await invoke<string | null>('get_setting', {
      key: `builtin.${plugin.id}.enabled`,
    });
    if (enabled === '0') disabledBuiltInIds.add(plugin.id);
    else disabledBuiltInIds.delete(plugin.id);
  }
}

/** 更新内置插件启用状态（市场页开关后同步内存；落盘由调用方负责） */
export function setBuiltInPluginEnabled(id: string, enabled: boolean): void {
  if (enabled) disabledBuiltInIds.delete(id);
  else disabledBuiltInIds.add(id);
}

/** 插件是否可用：内置插件查禁用集；外部插件恒可用（未启用的不会注册进来） */
export function isBuiltInPluginEnabled(id: string): boolean {
  return !disabledBuiltInIds.has(id);
}

/** 启用的插件（过滤禁用的内置插件），供启动器等入口消费 */
export function listEnabledPlugins(): ViewPlugin[] {
  return listPlugins().filter((p) => isBuiltInPluginEnabled(p.id));
}

export function getPlugin(id: string): ViewPlugin | undefined {
  return byId.get(id);
}

/** 插件视图 id 的唯一运行时校验入口；未知 id 的渲染回退 launcher */
export function isPluginView(id: string): boolean {
  return byId.has(id);
}

/** 已注册的外部插件 id（内置插件不在其中），用于禁用/卸载时的注销 */
const externalIds = new Set<string>();

/**
 * 合流外部插件（仅启用的传入；全部扫描结果供管理器展示，不注册）。
 * 与已注册插件（内置或已注册外部）id 冲突时忽略新注册并 warn。
 */
export function registerExternalPlugins(plugins: ViewPlugin[]): void {
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) {
      console.warn(`[plugins] 插件「${plugin.id}」与已注册插件冲突，忽略外部版本`);
      continue;
    }
    byId.set(plugin.id, plugin);
    externalIds.add(plugin.id);
    if (plugin.shortcutModuleId) {
      byShortcutModuleId.set(plugin.shortcutModuleId, plugin);
    }
  }
}

/** 注销外部插件（禁用/卸载后调用），只作用于外部插件 id */
export function unregisterExternalPlugins(ids: string[]): void {
  for (const id of ids) {
    if (!externalIds.has(id)) continue;
    byId.delete(id);
    externalIds.delete(id);
    for (const [k, v] of byShortcutModuleId) {
      if (v.id === id) {
        byShortcutModuleId.delete(k);
      }
    }
  }
}

/** 当前已注册的外部插件 id（供完整刷新时先注销再合流） */
export function listExternalPluginIds(): string[] {
  return [...externalIds];
}

/** 后端 shortcut:open_module 的 moduleId → 插件（吸收 notes/passwords 旧 id）；禁用的内置插件不响应 */
export function getPluginByShortcutModule(moduleId: string): ViewPlugin | undefined {
  const plugin = byShortcutModuleId.get(moduleId);
  return plugin && isBuiltInPluginEnabled(plugin.id) ? plugin : undefined;
}

/**
 * 启动空闲时预热插件 chunk（本地并行拉取，不阻塞主线程；禁用的内置插件跳过）。
 * 预热后首次进入插件的 import() 立即 resolve，加载态消失。
 * 失败静默：预加载失败不影响运行，进入时懒加载仍会触发并走 ErrorBoundary 兜底。
 */
export function preloadPlugins(): void {
  for (const plugin of byId.values()) {
    if (!isBuiltInPluginEnabled(plugin.id)) continue;
    plugin.load().catch(() => {
      /* 静默 */
    });
  }
}

/** 行首前缀命中某插件 trigger 时返回该插件与剩余参数文本；大小写敏感；禁用的内置插件不参与 */
export function matchTrigger(query: string): { plugin: ViewPlugin; trigger: PluginTrigger; arg: string } | null {
  for (const plugin of byId.values()) {
    if (!isBuiltInPluginEnabled(plugin.id)) continue;
    for (const trigger of plugin.triggers ?? []) {
      if (query.startsWith(trigger.keyword)) {
        return { plugin, trigger, arg: query.slice(trigger.keyword.length).trim() };
      }
    }
  }
  return null;
}

/** @ 前缀模糊联想的单个候选（未完整命中时供启动器联想列表展示/选择） */
export interface TriggerSuggestion {
  plugin: ViewPlugin;
  trigger: PluginTrigger;
  /** 匹配的完整关键词（@time） */
  keyword: string;
  /** 匹配类型：prefix 前缀匹配 > substring 子串包含 */
  matchType: 'prefix' | 'substring';
  /** 剩余参数（query 中「@ 关键词之后」的部分，选中后投递给插件） */
  arg: string;
}

/**
 * @ 前缀联想：query 以 @ 开头且未完整命中 trigger 时，用「@ 后第一段 token」
 * 模糊匹配全部 trigger 关键词（前缀优先、子串兜底）——记不起完整名称（@ti → @time）
 * 也能进入插件。排序：前缀 > 子串；同级按插件 order、关键词长度升序。
 */
export function suggestTriggers(query: string): TriggerSuggestion[] {
  if (!query.startsWith('@')) return [];
  // @ 后第一段 token 作为匹配目标（@time 123 → time）；参数 = @ 后第一个空格起
  const afterAt = query.slice(1);
  const tokenEnd = afterAt.search(/\s/);
  const token = (tokenEnd === -1 ? afterAt : afterAt.slice(0, tokenEnd)).toLowerCase();
  if (!token) return [];
  const argStart = query.indexOf(' ', 1);
  const arg = argStart === -1 ? '' : query.slice(argStart).trim();

  const out: TriggerSuggestion[] = [];
  for (const plugin of byId.values()) {
    if (!isBuiltInPluginEnabled(plugin.id)) continue;
    for (const trigger of plugin.triggers ?? []) {
      const kw = trigger.keyword;
      if (!kw.startsWith('@')) continue;
      const kwBody = kw.slice(1).toLowerCase();
      const matchType = kwBody.startsWith(token) ? 'prefix' : kwBody.includes(token) ? 'substring' : null;
      if (!matchType) continue;
      out.push({ plugin, trigger, keyword: kw, matchType, arg });
    }
  }
  out.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'prefix' ? -1 : 1;
    const orderDiff = (a.plugin.order ?? 100) - (b.plugin.order ?? 100);
    if (orderDiff !== 0) return orderDiff;
    return a.keyword.length - b.keyword.length;
  });
  return out;
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
