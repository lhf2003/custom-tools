// 壳视图：App 对它们有真实分支逻辑（无导航栏 home 布局等），保持字面量
export type ShellView = 'launcher' | 'chat' | 'settings';

// 全量视图 id：壳字面量 + 任意插件 id。
// (string & {}) 保留字面量自动补全，同时接受注册表里的插件 id 字符串；
// 插件 id 的运行时校验收敛在 src/plugins/registry.ts 的 isPluginView。
export type ViewMode = ShellView | (string & {});

// `app:open-view` custom event 的 detail：请求切换到指定视图，可携带载荷。
// 载荷形状由目标视图自己定义并 narrow（如 markdown 的 { notePath: string }），壳不感知。
export interface OpenViewDetail {
  view: ViewMode;
  payload?: unknown;
}

// Navigation menu item
export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ElementType;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onClick: () => void;
}

// View configuration for navigation bar
export interface ViewConfig {
  title: string;
  icon?: React.ElementType;
  menuItems: MenuItem[];
}

// Clipboard types
export type ClipboardType = 'text' | 'image' | 'file';

export interface ClipboardItem {
  id: number;
  content: string;
  contentType: ClipboardType;
  contentHash?: string;
  sourceApp?: string;
  isFavorite: boolean;
  isPinned: boolean;
  tags?: string[];
  createdAt: string;
}

// Note types
export interface Note {
  id: number;
  title: string;
  path: string;
  parentId?: number;
  isFolder: boolean;
  isPinned: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

// Password types
export interface PasswordCategory {
  id: number;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
}

export interface PasswordEntry {
  id: number;
  title: string;
  username?: string;
  encryptedPassword: string;
  encryptedNotes?: string;
  url?: string;
  categoryId?: number;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Tool definition
export interface Tool {
  id: ViewMode;
  icon: React.ElementType;
  label: string;
  color: string;
}

// Recent item
export interface RecentItem {
  id: string;
  name: string;
  icon: string;
  type: 'app' | 'tool';
}
// Settings
export interface Settings {
  theme: 'light' | 'dark' | 'system';
  shortcutShow: string;
  clipboardMaxItems: number;
  clipboardKeepDays: number;
  passwordAutoLock: number;
  noteAutoSave: boolean;
}
