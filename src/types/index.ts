// View modes
type ViewMode = 'launcher' | 'clipboard' | 'markdown' | 'password' | 'settings' | 'everything';

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
  favorite: boolean;
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

export type { ViewMode };
