import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Plus, Copy, Check, Eye, EyeOff, Lock, Trash2, X, Globe, Shield, LayoutGrid, Pencil, ExternalLink, Star, Loader2, User } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Tooltip } from '@/components/Tooltip';
import { MenuPanel } from '@/components/ActionMenu';
import { WINDOW_SIZE } from '../../constants/window';
import { THEME } from '../../constants/theme';
import { immediateResize } from '@/utils/tauri';
import { EntryFormModal, CategoryModal, ConfirmDeleteModal } from './EntryModals';
import { EMPTY_FORM } from './types';
import type { EntryFormData, PasswordCategory, PasswordEntry } from './types';

/** 焦点在输入框/文本域/下拉时不响应单键快捷键（F 收藏 / Del 删除），避免与输入冲突 */
function isTypingTarget(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

type CopyField = 'password' | 'username' | 'url';

/** 时间戳精确到分钟——秒级精度对密码管理是噪声 */
function formatTime(ts: string): string {
  return new Date(ts.replace(' ', 'T')).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 取标题首字符，emoji 等代理对字符安全（charAt(0) 会切出豆腐块） */
function firstChar(title: string): string {
  return [...title][0]?.toUpperCase() ?? '?';
}

export function PasswordView() {
  // Resize window when view mounts
  useEffect(() => {
    immediateResize(WINDOW_SIZE.PASSWORD.height, WINDOW_SIZE.PASSWORD.width);
  }, []);

  const [isUnlocked, setIsUnlocked] = useState(false);
  const [masterPassword, setMasterPassword] = useState('');
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [categories, setCategories] = useState<PasswordCategory[]>([]);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | 'all'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);

  // Modal states
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<PasswordEntry | null>(null);
  const [editInitialForm, setEditInitialForm] = useState<EntryFormData>(EMPTY_FORM);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState<PasswordEntry | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<PasswordCategory | null>(null);
  // 分类 chip 右键菜单：null 即关闭
  const [categoryMenu, setCategoryMenu] = useState<{ cat: PasswordCategory; x: number; y: number } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showPasswordMap, setShowPasswordMap] = useState<Record<number, boolean>>({});
  const [decryptedPasswords, setDecryptedPasswords] = useState<Record<number, string>>({});
  const [copiedField, setCopiedField] = useState<CopyField | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());
  const copyTimerRef = useRef<number | null>(null);
  // 每条目独立的 30 秒自动遮蔽定时器：显示条目 B 不会清掉条目 A 的倒计时
  const hideTimersRef = useRef(new Map<number, number>());

  // 搜索防抖：输入 300ms 后才触发后端查询
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 组件卸载时清理定时器
  useEffect(() => {
    const hideTimers = hideTimersRef.current;
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      hideTimers.forEach((t) => window.clearTimeout(t));
      hideTimers.clear();
    };
  }, []);

  // 切换条目时清除复制反馈，避免对勾残留到另一条目上
  useEffect(() => {
    setCopiedField(null);
  }, [selectedEntryId]);

  // Check unlock status
  const checkUnlockStatus = useCallback(async () => {
    try {
      const unlocked = await invoke<boolean>('is_password_manager_unlocked');
      setIsUnlocked(unlocked);
    } catch (err: unknown) {
      console.error('Failed to check unlock status:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkUnlockStatus();
  }, [checkUnlockStatus]);

  // 解锁成功后焦点落到搜索框（键盘流起点）
  useEffect(() => {
    if (isUnlocked) {
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isUnlocked]);

  const handleLock = useCallback(async () => {
    try {
      await invoke('lock_password_manager');
      setIsUnlocked(false);
      setDecryptedPasswords({});
      setShowPasswordMap({});
      hideTimersRef.current.forEach((t) => window.clearTimeout(t));
      hideTimersRef.current.clear();
      setSelectedEntryId(null);
      setSearchInput('');
      setListError(null);
    } catch (err: unknown) {
      console.error('[Password] Failed to lock:', err);
      setListError('锁定失败，请重试');
    }
  }, []);

  const openCreateModal = useCallback(() => {
    setEditingEntry(null);
    setEditInitialForm(EMPTY_FORM);
    setModalError(null);
    setShowEntryModal(true);
  }, []);

  // Listen for menu actions from navigation bar
  useEffect(() => {
    const openCategoryModal = () => {
      setModalError(null);
      setShowCategoryModal(true);
    };

    window.addEventListener('password:new-entry', openCreateModal);
    window.addEventListener('password:lock', handleLock);
    window.addEventListener('password:new-category', openCategoryModal);

    return () => {
      window.removeEventListener('password:new-entry', openCreateModal);
      window.removeEventListener('password:lock', handleLock);
      window.removeEventListener('password:new-category', openCategoryModal);
    };
  }, [handleLock, openCreateModal]);

  const loadCategories = useCallback(async () => {
    try {
      const cats = await invoke<PasswordCategory[]>('get_password_categories');
      setCategories(cats);
    } catch (err: unknown) {
      console.error('Failed to load categories:', err);
      const message = err instanceof Error ? err.message : String(err);
      setListError(`加载分类失败: ${message}`);
    }
  }, []);

  const loadEntries = useCallback(async () => {
    try {
      const ents = await invoke<PasswordEntry[]>('get_password_entries', {
        categoryId: selectedCategory === 'all' ? undefined : selectedCategory,
        favoriteOnly: false,
        search: searchQuery || undefined,
      });
      setEntries(ents);
      setListError(null);
      // 选中 reconcile：保留仍在结果中的选中项，否则选中第一条（键盘流即达）
      setSelectedEntryId((prev) => {
        if (prev && ents.some((e) => e.id === prev)) return prev;
        return ents.length > 0 ? ents[0].id : null;
      });
    } catch (err: unknown) {
      console.error('[Password] Failed to load entries:', err);
      const message = err instanceof Error ? err.message : String(err);
      setListError(`加载密码列表失败: ${message}`);
    }
  }, [searchQuery, selectedCategory]);

  // Load data when unlocked
  useEffect(() => {
    if (isUnlocked) {
      loadCategories();
      loadEntries();
    }
  }, [isUnlocked, loadCategories, loadEntries]);

  const handleUnlock = async () => {
    if (!masterPassword || isUnlocking) return;

    setIsUnlocking(true);
    try {
      setUnlockError(null);
      const result = await invoke<boolean>('unlock_password_manager', {
        request: { master_password: masterPassword },
      });

      if (result) {
        setIsUnlocked(true);
        setMasterPassword('');
      }
    } catch (err: unknown) {
      // Tauri 命令的错误以 string 形式到达，instanceof Error 永不命中
      setUnlockError(typeof err === 'string' ? err : err instanceof Error ? err.message : '解锁失败');
    } finally {
      setIsUnlocking(false);
    }
  };

  const openEditModal = async (entry: PasswordEntry) => {
    try {
      // 编辑需要明文预填；取不到明文就不该打开表单（否则会覆盖成空密码）
      const password = decryptedPasswords[entry.id]
        ?? await invoke<string>('get_decrypted_password', { id: entry.id });
      setDecryptedPasswords((prev) => ({ ...prev, [entry.id]: password }));
      setEditingEntry(entry);
      setEditInitialForm({
        title: entry.title,
        username: entry.username ?? '',
        password,
        url: entry.url ?? '',
        notes: entry.notes ?? '',
        category_id: entry.category_id ?? undefined,
      });
      setModalError(null);
      setShowEntryModal(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(`读取原密码失败，无法编辑: ${message}`);
    }
  };

  const handleSaveEntry = async (form: EntryFormData) => {
    if (isSaving) return;

    const request = {
      title: form.title.trim(),
      username: form.username || null,
      password: form.password,
      url: form.url || null,
      notes: form.notes || null,
      category_id: form.category_id ?? null,
    };

    setIsSaving(true);
    try {
      setModalError(null);
      if (editingEntry) {
        await invoke('update_password_entry', { id: editingEntry.id, request });
        // 明文缓存同步为新密码，避免保存后展示/复制到旧密码
        setDecryptedPasswords((prev) => ({ ...prev, [editingEntry.id]: form.password }));
      } else {
        const newId = await invoke<number>('create_password_entry', { request });
        setSelectedEntryId(newId);
      }

      setShowEntryModal(false);
      setEditingEntry(null);
      await loadEntries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setModalError(`${editingEntry ? '保存' : '创建'}失败: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateCategory = async (name: string) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      setModalError(null);
      await invoke('create_password_category', { name });
      setShowCategoryModal(false);
      await loadCategories();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setModalError(`创建分类失败: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingEntry || isDeleting) return;

    setIsDeleting(true);
    try {
      setModalError(null);
      await invoke('delete_password_entry', { id: deletingEntry.id });
      setDeletingEntry(null);
      loadEntries();
    } catch (err: unknown) {
      console.error('Failed to delete entry:', err);
      const message = err instanceof Error ? err.message : String(err);
      setModalError(`删除失败: ${message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // 删除分类：条目不丢——后端 FK ON DELETE SET NULL 把它们移回未分类
  const handleConfirmDeleteCategory = async () => {
    if (!deletingCategory || isDeleting) return;

    setIsDeleting(true);
    try {
      setModalError(null);
      await invoke('delete_password_category', { id: deletingCategory.id });
      const removedId = deletingCategory.id;
      setDeletingCategory(null);
      // 正在看被删分类 → 回到「全部」（loadEntries 由 selectedCategory 依赖触发）
      if (selectedCategory === removedId) {
        setSelectedCategory('all');
      } else {
        // 「全部」等视图里被移出的条目要出现，手动刷新
        loadEntries();
      }
      await loadCategories();
    } catch (err: unknown) {
      console.error('Failed to delete category:', err);
      const message = err instanceof Error ? err.message : String(err);
      setModalError(`删除分类失败: ${message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleFavorite = useCallback(async (entry: PasswordEntry) => {
    try {
      await invoke('toggle_password_favorite', { id: entry.id, favorite: !entry.favorite });
      loadEntries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(`收藏操作失败: ${message}`);
    }
  }, [loadEntries]);

  const scheduleAutoHide = useCallback((id: number) => {
    const timers = hideTimersRef.current;
    const existing = timers.get(id);
    if (existing) window.clearTimeout(existing);
    timers.set(id, window.setTimeout(() => {
      setShowPasswordMap((prev) => ({ ...prev, [id]: false }));
      hideTimersRef.current.delete(id);
    }, 30000));
  }, []);

  const cancelAutoHide = useCallback((id: number) => {
    const existing = hideTimersRef.current.get(id);
    if (existing) {
      window.clearTimeout(existing);
      hideTimersRef.current.delete(id);
    }
  }, []);

  const handleShowPassword = async (id: number) => {
    if (showPasswordMap[id]) {
      setShowPasswordMap((prev) => ({ ...prev, [id]: false }));
      cancelAutoHide(id);
      return;
    }

    try {
      let password = decryptedPasswords[id];
      if (!password) {
        password = await invoke<string>('get_decrypted_password', { id });
        setDecryptedPasswords((prev) => ({ ...prev, [id]: password }));
      }
      setShowPasswordMap((prev) => ({ ...prev, [id]: true }));
      // 30 秒后自动重新遮蔽，降低肩窥暴露窗口（per-id 定时器，互不干扰）
      scheduleAutoHide(id);
    } catch (err: unknown) {
      console.error('[Password] Failed to decrypt password:', err);
      const message = err instanceof Error ? err.message : String(err);
      setListError(`解密失败: ${message}`);
    }
  };

  // 复制反馈：对勾图标 2 秒后复位
  const flashCopied = useCallback((field: CopyField) => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    setCopiedField(field);
    copyTimerRef.current = window.setTimeout(() => setCopiedField(null), 2000);
  }, []);

  // 敏感复制（仅密码）：走后端专用命令——抑制剪贴板历史记录 + 60 秒定时清除
  const copySensitive = useCallback(async (text: string, field: CopyField) => {
    try {
      await invoke('copy_password_to_clipboard', { text });
      flashCopied(field);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
      const message = err instanceof Error ? err.message : String(err);
      setListError(`复制失败: ${message}`);
    }
  }, [flashCopied]);

  // 普通复制（用户名/网址）：记入剪贴板历史、不定时清除——行为可预期
  const copyPlain = useCallback(async (text: string, field: CopyField) => {
    try {
      await invoke('copy_text_to_clipboard', { text });
      flashCopied(field);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
      const message = err instanceof Error ? err.message : String(err);
      setListError(`复制失败: ${message}`);
    }
  }, [flashCopied]);

  // 复制密码无需先显示：点击即解密直写剪贴板
  const copyPassword = useCallback(async (entry: PasswordEntry) => {
    try {
      const password = decryptedPasswords[entry.id]
        ?? await invoke<string>('get_decrypted_password', { id: entry.id });
      setDecryptedPasswords((prev) => ({ ...prev, [entry.id]: password }));
      await copySensitive(password, 'password');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(`解密失败: ${message}`);
    }
  }, [decryptedPasswords, copySensitive]);

  // 键盘导航（对齐 ClipboardView）：↑↓ 选择，Enter 复制密码，F 收藏，Delete 删除
  useEffect(() => {
    if (!isUnlocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showEntryModal || showCategoryModal || deletingEntry || deletingCategory || categoryMenu) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && isTypingTarget() && e.key !== 'Enter') return;
      if (entries.length === 0) return;

      const flatIds = entries.map((item) => item.id);
      const currentIndex = selectedEntryId ? flatIds.indexOf(selectedEntryId) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = currentIndex < flatIds.length - 1 ? currentIndex + 1 : 0;
        const nextId = flatIds[nextIndex];
        setSelectedEntryId(nextId);
        itemRefs.current.get(nextId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : flatIds.length - 1;
        const prevId = flatIds[prevIndex];
        setSelectedEntryId(prevId);
        itemRefs.current.get(prevId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'Enter' && selectedEntryId) {
        // 与 ClipboardView 一致：Enter 在搜索框聚焦时也复制当前选中项（搜索→↓→Enter 旗舰链路）
        e.preventDefault();
        const entry = entries.find((item) => item.id === selectedEntryId);
        if (entry) copyPassword(entry);
      } else if (!isTypingTarget() && (e.key === 'f' || e.key === 'F') && selectedEntryId) {
        e.preventDefault();
        const entry = entries.find((item) => item.id === selectedEntryId);
        if (entry) handleToggleFavorite(entry);
      } else if (!isTypingTarget() && e.key === 'Delete' && selectedEntryId) {
        e.preventDefault();
        const entry = entries.find((item) => item.id === selectedEntryId);
        if (entry) setDeletingEntry(entry);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isUnlocked, entries, selectedEntryId, showEntryModal, showCategoryModal, deletingEntry, deletingCategory, categoryMenu, copyPassword, handleToggleFavorite]);

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-app-text-tertiary" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <Loader2 size={18} className="animate-spin mr-2" />
        <span>加载中...</span>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <div className="rounded-2xl p-8 w-80 text-center border border-app-border"
             style={{ backgroundColor: THEME.BG_SECONDARY }}>
          {/* Icon */}
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
               style={{ backgroundColor: THEME.BG_ELEVATED }}>
            <Lock size={32} className="text-app-text-secondary" />
          </div>

          {/* Title */}
          <h2 className="text-sm font-semibold text-app-text-primary mb-2">密码保险库</h2>
          <p className="text-app-text-tertiary text-xs mb-6">请输入主密码解锁</p>

          {/* Error Message */}
          {unlockError && (
            <div className="mb-4 p-3 rounded-lg bg-app-status-error/10 border border-app-status-error/20">
              <p className="text-xs text-app-status-error-text">{unlockError}</p>
            </div>
          )}

          {/* Password Input */}
          <div className="relative mb-4">
            <input
              type="password"
              id="master-password"
              name="master-password"
              aria-label="主密码"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="主密码"
              className="w-full bg-app-bg-tertiary border border-app-border rounded-lg px-4 py-3 text-sm text-app-text-primary placeholder:text-app-text-placeholder outline-none transition-colors duration-200 focus:border-app-border-emphasis"
              onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
              autoFocus
            />
          </div>

          {/* Unlock Button */}
          <button
            onClick={handleUnlock}
            disabled={!masterPassword || isUnlocking}
            className="w-full py-3 rounded-lg bg-app-status-info text-white text-sm font-medium cursor-pointer transition-colors duration-200 hover:bg-app-status-info-deep disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isUnlocking && <Loader2 size={16} className="animate-spin" />}
            {isUnlocking ? '解锁中...' : '解锁'}
          </button>

          {/* Security hint */}
          <p className="text-app-text-tertiary text-xs mt-4">数据已加密存储在本地</p>
        </div>
      </div>
    );
  }

  const selectedEntry = entries.find(e => e.id === selectedEntryId);

  return (
    <div className="w-full h-full flex flex-col" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* 主视图错误条：load/delete/decrypt 失败在这里可见，可重试可关闭 */}
      {listError && (
        <div className="flex items-center gap-3 px-4 py-2 bg-app-status-error/10 border-b border-app-status-error/20 flex-shrink-0">
          <span className="flex-1 text-xs text-app-status-error-text">{listError}</span>
          <button
            onClick={() => { setListError(null); loadCategories(); loadEntries(); }}
            className="px-3 py-1 rounded-md text-xs text-app-text-secondary hover:bg-white/10 transition-colors cursor-pointer"
          >
            重试
          </button>
          <button
            onClick={() => setListError(null)}
            aria-label="关闭错误提示"
            className="p-1 rounded-md text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left Sidebar - Password List Only */}
        <aside className="w-64 border-r border-app-border flex flex-col flex-shrink-0" style={{ backgroundColor: THEME.BG_SECONDARY }}>
          {/* Search Bar（侧栏不再重复标题——TopNavigationBar 已有「密码保险库」） */}
          <div className="p-3 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 bg-app-bg-tertiary rounded-lg px-3 py-2 border border-app-border">
              <Search size={16} className="text-app-text-tertiary" />
              <input
                ref={searchInputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls="pw-listbox"
                aria-activedescendant={selectedEntryId ? `pw-option-${selectedEntryId}` : undefined}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索密码..."
                className="flex-1 bg-transparent text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput('')}
                  aria-label="清空搜索"
                  className="text-app-text-tertiary hover:text-app-text-secondary transition-colors cursor-pointer"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <Tooltip content="新增密码" placement="bottom">
              <button
                onClick={openCreateModal}
                aria-label="新增密码"
                className="p-2 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors duration-200 cursor-pointer"
              >
                <Plus size={16} />
              </button>
            </Tooltip>
          </div>

          {/* Category Filter */}
          {categories.length > 0 && (
            <div className="px-3 pb-2 flex gap-1.5 overflow-x-auto">
              <button
                onClick={() => setSelectedCategory('all')}
                className={`px-2 py-1 rounded-md text-xs whitespace-nowrap transition-colors cursor-pointer ${
                  selectedCategory === 'all'
                    ? 'bg-white/10 text-app-text-primary'
                    : 'text-app-text-tertiary hover:text-app-text-secondary hover:bg-white/5'
                }`}
              >
                全部
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCategoryMenu({ cat, x: e.clientX, y: e.clientY });
                  }}
                  className={`px-2 py-1 rounded-md text-xs whitespace-nowrap transition-colors cursor-pointer ${
                    selectedCategory === cat.id
                      ? 'bg-white/10 text-app-text-primary'
                      : 'text-app-text-tertiary hover:text-app-text-secondary hover:bg-white/5'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}

          {/* Password Items */}
          <div className="flex-1 overflow-y-auto p-2">
            {entries.length === 0 ? (
              searchQuery ? (
                <div className="flex flex-col items-center justify-center h-full text-app-text-tertiary p-6 text-center">
                  <p className="text-xs text-app-text-secondary">没有找到匹配的密码</p>
                  <button
                    onClick={() => setSearchInput('')}
                    className="text-xs mt-2 text-app-text-tertiary hover:text-app-text-secondary underline underline-offset-2 transition-colors cursor-pointer"
                  >
                    清除搜索
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-app-text-tertiary p-6 text-center">
                  <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-3">
                    <Shield size={24} className="opacity-50" />
                  </div>
                  <p className="text-xs text-app-text-secondary">暂无密码</p>
                  <p className="text-xs mt-1 text-app-text-tertiary">点击 + 添加新密码</p>
                </div>
              )
            ) : (
              <div className="space-y-1" role="listbox" id="pw-listbox" aria-label="密码列表">
                {entries.map((item) => (
                  <PasswordListItem
                    key={item.id}
                    item={item}
                    isSelected={selectedEntryId === item.id}
                    onClick={() => setSelectedEntryId(item.id)}
                    itemRef={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                      else itemRefs.current.delete(item.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Bottom Actions */}
          <div className="p-3 border-t border-app-border">
            <button
              onClick={handleLock}
              className="w-full py-2 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors flex items-center justify-center gap-2 text-xs cursor-pointer"
            >
              <Lock size={14} />
              锁定保险库
            </button>
          </div>
        </aside>

        {/* Right - Detail View */}
        <div className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        {selectedEntry ? (
          <PasswordDetail
            entry={selectedEntry}
            decryptedPassword={decryptedPasswords[selectedEntry.id]}
            showPassword={!!showPasswordMap[selectedEntry.id]}
            copiedField={copiedField}
            onTogglePassword={() => handleShowPassword(selectedEntry.id)}
            onCopyPassword={() => copyPassword(selectedEntry)}
            onCopyUsername={() => selectedEntry.username && copyPlain(selectedEntry.username, 'username')}
            onCopyUrl={() => selectedEntry.url && copyPlain(selectedEntry.url, 'url')}
            onToggleFavorite={() => handleToggleFavorite(selectedEntry)}
            onDelete={() => { setModalError(null); setDeletingEntry(selectedEntry); }}
            onEdit={() => openEditModal(selectedEntry)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-app-text-tertiary p-8">
            <div className="w-24 h-24 rounded-2xl bg-white/5 flex items-center justify-center mb-6 border border-app-border-subtle">
              <LayoutGrid size={48} className="text-app-text-tertiary" />
            </div>
            <p className="text-sm font-medium text-app-text-tertiary">选择一个密码条目</p>
            <p className="text-xs mt-2 text-app-text-tertiary">从左侧列表选择一个条目查看详情</p>
          </div>
        )}
        </div>
      </div>

      {/* 分类 chip 右键菜单：透明遮罩点击即关，菜单体复用导航栏 MenuPanel 样式 */}
      {categoryMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setCategoryMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setCategoryMenu(null); }}
        >
          <div
            className="absolute min-w-[160px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-2xl animate-in fade-in duration-150"
            style={{
              left: Math.min(categoryMenu.x, window.innerWidth - 176),
              top: Math.min(categoryMenu.y, window.innerHeight - 64),
              WebkitBackdropFilter: 'blur(20px)',
              backdropFilter: 'blur(20px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuPanel
              items={[{
                id: 'delete-category',
                label: '删除分类',
                icon: Trash2,
                danger: true,
                onClick: () => { setModalError(null); setDeletingCategory(categoryMenu.cat); },
              }]}
              onItemClick={() => setCategoryMenu(null)}
            />
          </div>
        </div>
      )}

      {/* Entry Create/Edit Modal（key 保证切换条目时表单状态重置） */}{showEntryModal && (
        <EntryFormModal
          key={editingEntry ? `edit-${editingEntry.id}` : 'create'}
          mode={editingEntry ? 'edit' : 'create'}
          initial={editInitialForm}
          categories={categories}
          saving={isSaving}
          error={modalError}
          onSubmit={handleSaveEntry}
          onClose={() => { setShowEntryModal(false); setEditingEntry(null); setModalError(null); }}
        />
      )}

      {/* Category Create Modal */}
      {showCategoryModal && (
        <CategoryModal
          saving={isSaving}
          error={modalError}
          onSubmit={handleCreateCategory}
          onClose={() => { setShowCategoryModal(false); setModalError(null); }}
        />
      )}

      {/* Delete Confirm Modal */}
      {deletingEntry && (
        <ConfirmDeleteModal
          heading="删除密码"
          message={<>确定要删除「{deletingEntry.title}」吗？</>}
          deleting={isDeleting}
          error={modalError}
          onConfirm={handleConfirmDelete}
          onClose={() => { setDeletingEntry(null); setModalError(null); }}
        />
      )}

      {/* Delete Category Confirm Modal */}
      {deletingCategory && (
        <ConfirmDeleteModal
          heading="删除分类"
          message={
            deletingCategory.entry_count > 0
              ? <>确定要删除分类「{deletingCategory.name}」吗？其中的 {deletingCategory.entry_count} 条密码将移至未分类。</>
              : <>确定要删除分类「{deletingCategory.name}」吗？</>
          }
          deleting={isDeleting}
          error={modalError}
          onConfirm={handleConfirmDeleteCategory}
          onClose={() => { setDeletingCategory(null); setModalError(null); }}
        />
      )}
    </div>
  );
}

interface PasswordListItemProps {
  item: PasswordEntry;
  isSelected: boolean;
  onClick: () => void;
  itemRef: (el: HTMLButtonElement | null) => void;
}

function PasswordListItem({ item, isSelected, onClick, itemRef }: PasswordListItemProps) {
  return (
    <button
      ref={itemRef}
      id={`pw-option-${item.id}`}
      type="button"
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors duration-200 text-left ${
        isSelected
          ? 'bg-white/10'
          : 'hover:bg-white/5'
      }`}
    >
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {item.favorite && (
            <Star size={12} className="text-app-status-warning flex-shrink-0" fill="currentColor" />
          )}
          <span className={`text-sm font-medium truncate ${isSelected ? 'text-app-text-primary' : 'text-app-text-secondary'}`}>{item.title}</span>
        </div>
        <span className="text-app-text-tertiary text-xs truncate block">
          {item.username || '无用户名'}
        </span>
      </div>
    </button>
  );
}

interface PasswordDetailProps {
  entry: PasswordEntry;
  decryptedPassword?: string;
  showPassword?: boolean;
  copiedField: CopyField | null;
  onTogglePassword: () => void;
  onCopyPassword: () => void;
  onCopyUsername: () => void;
  onCopyUrl: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onEdit: () => void;
}

function PasswordDetail({
  entry,
  decryptedPassword,
  showPassword,
  copiedField,
  onTogglePassword,
  onCopyPassword,
  onCopyUsername,
  onCopyUrl,
  onToggleFavorite,
  onDelete,
  onEdit,
}: PasswordDetailProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-app-border">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4 min-w-0">
            {/* Large Icon */}
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-app-text-secondary font-semibold text-sm flex-shrink-0"
                 style={{ backgroundColor: THEME.BG_ELEVATED }}>
              {firstChar(entry.title)}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-app-text-primary truncate">{entry.title}</h2>
              </div>
              {entry.url && (
                <button
                  onClick={async () => {
                    const url = entry.url?.startsWith('http') ? entry.url : `https://${entry.url}`;
                    try {
                      await invoke('open_external_url', { url });
                    } catch (err: unknown) {
                      console.error('Failed to open external URL:', err);
                    }
                  }}
                  className="text-app-text-tertiary hover:text-blue-400 text-xs flex items-center gap-1 mt-1 transition-colors cursor-pointer truncate"
                >
                  {entry.url}
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <Tooltip content={entry.favorite ? '取消收藏' : '收藏'} placement="bottom">
              <button
                onClick={onToggleFavorite}
                aria-label={entry.favorite ? '取消收藏' : '收藏'}
                aria-pressed={entry.favorite}
                className="p-2.5 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
              >
                <Star size={18} className={entry.favorite ? 'text-app-status-warning' : undefined} fill={entry.favorite ? 'currentColor' : 'none'} />
              </button>
            </Tooltip>
            <Tooltip content="编辑" placement="bottom">
              <button
                onClick={onEdit}
                aria-label="编辑"
                className="p-2.5 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
              >
                <Pencil size={18} />
              </button>
            </Tooltip>
            <Tooltip content="删除" placement="bottom">
              <button
                onClick={onDelete}
                aria-label="删除"
                className="p-2.5 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-red-500/20 hover:text-red-400 transition-colors duration-200 cursor-pointer"
              >
                <Trash2 size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg space-y-6">
          {/* Username Field */}
          <div className="space-y-2">
            <label className="text-xs text-app-text-tertiary">用户名 / 邮箱</label>
            <div className="rounded-xl p-4 flex items-center gap-3 border border-app-border bg-white/5">
              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <User size={18} className="text-app-text-tertiary" />
              </div>
              <code className="flex-1 text-app-text-primary text-xs truncate">{entry.username || '-'}</code>
              {entry.username && (
                <Tooltip content={copiedField === 'username' ? '已复制' : '复制用户名'} placement="top">
                  <button
                    onClick={onCopyUsername}
                    aria-label="复制用户名"
                    className="p-2 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
                  >
                    {copiedField === 'username'
                      ? <Check size={16} className="text-app-status-success" />
                      : <Copy size={16} />}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>

          {/* Password Field */}
          <div className="space-y-2">
            <label className="text-xs text-app-text-tertiary">密码</label>
            <div className="rounded-xl p-4 flex items-center gap-3 border border-app-border bg-white/5">
              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <Lock size={18} className="text-app-text-tertiary" />
              </div>
              <code className={`flex-1 text-app-text-primary text-xs font-mono ${showPassword ? 'break-all' : 'truncate'}`} aria-live="polite">
                {showPassword ? decryptedPassword || '••••••••' : '••••••••••••••••'}
              </code>
              <Tooltip content={showPassword ? '隐藏密码' : '显示密码'} placement="top">
                <button
                  onClick={onTogglePassword}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={!!showPassword}
                  className="p-2 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </Tooltip>
              {/* 复制不强制先显示：点击即后端解密直写剪贴板 */}
              <Tooltip content={copiedField === 'password' ? '已复制（60 秒后清除剪贴板）' : '复制密码'} placement="top">
                <button
                  onClick={onCopyPassword}
                  aria-label="复制密码"
                  className="p-2 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
                >
                  {copiedField === 'password'
                    ? <Check size={16} className="text-app-status-success" />
                    : <Copy size={16} />}
                </button>
              </Tooltip>
            </div>
          </div>

          {/* URL Field */}
          {entry.url && (
            <div className="space-y-2">
              <label className="text-xs text-app-text-tertiary">网站地址</label>
              <div className="rounded-xl p-4 flex items-center gap-3 border border-app-border bg-white/5">
                <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                  <Globe size={18} className="text-app-text-tertiary" />
                </div>
                <code className="flex-1 text-app-text-primary text-xs truncate">{entry.url}</code>
                <Tooltip content={copiedField === 'url' ? '已复制' : '复制网址'} placement="top">
                  <button
                    onClick={onCopyUrl}
                    aria-label="复制网址"
                    className="p-2 rounded-lg bg-white/5 text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors duration-200 cursor-pointer"
                  >
                    {copiedField === 'url'
                      ? <Check size={16} className="text-app-status-success" />
                      : <Copy size={16} />}
                  </button>
                </Tooltip>
              </div>
            </div>
          )}

          {/* Notes Field */}
          {entry.notes && (
            <div className="space-y-2">
              <label className="text-xs text-app-text-tertiary">备注</label>
              <div className="rounded-xl p-4 border border-app-border bg-white/5">
                <p className="text-app-text-secondary text-xs whitespace-pre-wrap break-words">{entry.notes}</p>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="pt-6 border-t border-app-border space-y-2">
            <div className="flex items-center justify-between text-xs text-app-text-tertiary">
              <span>创建时间</span>
              <span>{formatTime(entry.created_at)}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-app-text-tertiary">
              <span>最后更新</span>
              <span>{formatTime(entry.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
