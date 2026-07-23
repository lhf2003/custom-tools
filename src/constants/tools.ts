import {
  Command,
  FileText,
  Lock,
  HardDrive,
  Settings,
  Braces,
  MessageCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Descriptor for a built-in tool shown in the launcher grid and
 * in the operations manual inside SettingsView.
 *
 * `description` is optional so that the launcher can use this array
 * without requiring prose copy for every entry.
 */
export interface BuiltInTool {
  /** Identifier used as the `builtin://` path segment and as the view key. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** Lowercase search aliases (English/short forms) matched alongside `name`. */
  aliases?: string[];
  /** Optional prose description shown in the operations manual. */
  description?: string;
}

/**
 * Canonical list of built-in tools.
 *
 * This replaces the two divergent local definitions that existed in
 * LauncherView (6 entries, no description) and in the ManualSettings
 * section of SettingsView (4 entries, with description).
 *
 * LauncherView should use the full array; ManualSettings can filter to
 * entries that carry a `description` field.
 */
export const BUILT_IN_TOOLS: readonly BuiltInTool[] = [
  {
    id: 'chat',
    name: 'AI 聊天',
    icon: MessageCircle,
    aliases: ['ai', 'chat', 'gpt', 'llm'],
    description:
      '接入 OpenAI / DeepSeek / Ollama 等兼容接口的 AI 对话助手，支持普通聊天、知识问答、文本翻译三种模式，对话记录本地保存。',
  },
  {
    id: 'json_formatter',
    name: 'JSON格式化',
    icon: Braces,
    aliases: ['json', 'format', 'jq'],
    description:
      '本地格式化与校验 JSON 数据，树形视图折叠/展开，语法错误定位到行与列，支持复制结果或导出为图片。',
  },
  {
    id: 'everything',
    name: '文件搜索',
    icon: HardDrive,
    aliases: ['everything', 'file', 'search', 'find'],
    description:
      '集成Everything搜索引擎，毫秒级查找本地文件。支持模糊匹配、快速打开文件所在位置。',
  },
  {
    id: 'clipboard',
    name: '剪贴板',
    icon: Command,
    aliases: ['clipboard', 'clip', 'paste', 'copy'],
    description:
      '记录并管理您的剪贴板历史，支持文本、图片、文件等多种格式。可收藏常用内容，快速粘贴历史记录。',
  },
  {
    id: 'markdown',
    name: 'Markdown笔记',
    icon: FileText,
    aliases: ['markdown', 'md', 'note'],
    description:
      '轻量级Markdown编辑器，支持实时预览。适合快速记录想法、待办事项或撰写文档。',
  },
  {
    id: 'password',
    name: '密码管理',
    icon: Lock,
    aliases: ['password', 'pwd', 'vault'],
    description:
      '安全存储账号密码，使用AES-GCM加密保护。支持分类管理、快速复制，一键填充网站登录信息。',
  },
  {
    id: 'settings',
    name: '设置',
    icon: Settings,
    aliases: ['settings', 'config', 'preferences'],
  },
];
