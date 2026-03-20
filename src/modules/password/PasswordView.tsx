import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Copy, Eye, EyeOff, Lock, Trash2, X, Globe, Shield, LayoutGrid, MoreHorizontal, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { WINDOW_SIZE } from '../../constants/window';
import { THEME } from '../../constants/theme';

interface PasswordCategory {
  id: number;
  name: string;
  icon: string;
  color: string;
}

interface PasswordEntry {
  id: number;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  category_id: number | null;
  created_at: string;
  updated_at: string;
}

interface CreateEntryRequest {
  title: string;
  username?: string;
  password: string;
  url?: string;
  notes?: string;
  category_id?: number;
}

export function PasswordView() {
  // Resize window when view mounts
  useEffect(() => {
    const resizeWindow = async () => {
      try {
        await invoke('resize_window', { height: WINDOW_SIZE.PASSWORD.height, width: WINDOW_SIZE.PASSWORD.width });
      } catch (err: unknown) {
        console.error('Failed to resize window:', err);
      }
    };
    resizeWindow();
  }, []);

  const [isUnlocked, setIsUnlocked] = useState(false);
  const [masterPassword, setMasterPassword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [categories, setCategories] = useState<PasswordCategory[]>([]);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  // TODO: selectedCategory filtering is not yet implemented in the backend call
  // const [selectedCategory] = useState<number | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPasswordMap, setShowPasswordMap] = useState<Record<number, boolean>>({});
  const [decryptedPasswords, setDecryptedPasswords] = useState<Record<number, string>>({});

  // Form states
  const [newEntry, setNewEntry] = useState<CreateEntryRequest>({
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
  });

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

  const handleLock = useCallback(async () => {
    try {
      await invoke('lock_password_manager');
      setIsUnlocked(false);
      setDecryptedPasswords({});
      setShowPasswordMap({});
    } catch (err: unknown) {
      console.error('[Password] Failed to lock:', err);
      setError('锁定失败，请重试');
    }
  }, []);

  // Listen for menu actions from navigation bar
  useEffect(() => {
    const handleNewEntry = () => setShowCreateModal(true);

    window.addEventListener('password:new-entry', handleNewEntry);
    window.addEventListener('password:lock', handleLock);

    return () => {
      window.removeEventListener('password:new-entry', handleNewEntry);
      window.removeEventListener('password:lock', handleLock);
    };
  }, [handleLock]);

  const loadCategories = useCallback(async () => {
    try {
      const cats = await invoke<PasswordCategory[]>('get_password_categories');
      setCategories(cats);
    } catch (err: unknown) {
      console.error('Failed to load categories:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`加载分类失败: ${message}`);
    }
  }, []);

  const loadEntries = useCallback(async () => {
    try {
      const ents = await invoke<PasswordEntry[]>('get_password_entries', {
        categoryId: undefined,
        favoriteOnly: false,
        search: searchQuery || undefined,
      });
      setEntries(ents);
    } catch (err: unknown) {
      console.error('[Password] Failed to load entries:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`加载密码列表失败: ${message}`);
    }
  }, [searchQuery]);

  // Load data when unlocked
  useEffect(() => {
    if (isUnlocked) {
      loadCategories();
      loadEntries();
      // Reset selected entry when search changes
      setSelectedEntryId(null);
    }
  }, [isUnlocked, searchQuery, loadCategories, loadEntries]);

  const handleUnlock = async () => {
    if (!masterPassword) return;

    try {
      setError(null);
      const result = await invoke<boolean>('unlock_password_manager', {
        request: { master_password: masterPassword },
      });

      if (result) {
        setIsUnlocked(true);
        setMasterPassword('');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '解锁失败');
    }
  };

  const handleCreateEntry = async () => {
    if (!newEntry.title || !newEntry.password) {
      setError('标题和密码为必填项');
      return;
    }

    const request = {
      title: newEntry.title,
      username: newEntry.username || null,
      password: newEntry.password,
      url: newEntry.url || null,
      notes: newEntry.notes || null,
      category_id: newEntry.category_id ? Number(newEntry.category_id) : null,
    };

    try {
      setError(null);
      await invoke('create_password_entry', { request });

      setShowCreateModal(false);
      setNewEntry({ title: '', username: '', password: '', url: '', notes: '' });

      await loadEntries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`创建失败: ${message}`);
    }
  };

  const handleDeleteEntry = async (id: number) => {
    if (!confirm('确定要删除这个密码吗？')) return;

    try {
      await invoke('delete_password_entry', { id });
      loadEntries();
    } catch (err: unknown) {
      console.error('Failed to delete entry:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`删除失败: ${message}`);
    }
  };

  const handleShowPassword = async (id: number) => {
    if (showPasswordMap[id]) {
      setShowPasswordMap(prev => ({ ...prev, [id]: false }));
      return;
    }

    if (decryptedPasswords[id]) {
      setShowPasswordMap(prev => ({ ...prev, [id]: true }));
      return;
    }

    try {
      const password = await invoke<string>('get_decrypted_password', { id });
      setDecryptedPasswords(prev => ({ ...prev, [id]: password }));
      setShowPasswordMap(prev => ({ ...prev, [id]: true }));
    } catch (err: unknown) {
      console.error('[Password] Failed to decrypt password:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(`解密失败: ${message}`);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-zinc-500" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <div className="animate-spin mr-2">⌛</div>
        <span>加载中...</span>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <div className="rounded-2xl p-8 w-80 text-center border border-zinc-600/30 shadow-2xl"
             style={{ backgroundColor: THEME.BG_SECONDARY }}>
          {/* Icon with gradient background */}
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Lock size={32} className="text-white" />
          </div>

          {/* Title */}
          <h3 className="text-xl font-semibold text-zinc-200 mb-2">密码管理器</h3>
          <p className="text-zinc-500 text-sm mb-6">请输入主密码解锁</p>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Password Input */}
          <div className="relative mb-4">
            <input
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="主密码"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-3 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
              onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
              autoFocus
            />
          </div>

          {/* Unlock Button */}
          <button
            onClick={handleUnlock}
            disabled={!masterPassword}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-medium cursor-pointer transition-all duration-200 hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none"
          >
            解锁
          </button>

          {/* Security hint */}
          <p className="text-zinc-600 text-xs mt-4">数据已加密存储在本地</p>
        </div>
      </div>
    );
  }

  const selectedEntry = entries.find(e => e.id === selectedEntryId);

  return (
    <div className="w-full h-full overflow-x-auto">
      <div className="min-w-[850px] w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        {/* Left Sidebar - Password List Only */}
        <aside className="w-64 border-r border-zinc-600/30 flex flex-col flex-shrink-0" style={{ backgroundColor: THEME.BG_SECONDARY }}>
          {/* Header with Search */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-600/30">
            <h3 className="text-zinc-400 text-sm font-medium">密码管理</h3>
            <button
              onClick={() => setShowCreateModal(true)}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
              title="新增密码"
            >
              <Plus size={16} />
            </button>
          </div>

          {/* Search Bar */}
          <div className="p-3">
            <div className="flex items-center gap-2 bg-zinc-800/50 rounded-lg px-3 py-2 border border-zinc-700">
              <Search size={16} className="text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索密码..."
                className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Password Items */}
          <div className="flex-1 overflow-y-auto p-2">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500 p-6 text-center">
                <div className="w-12 h-12 rounded-xl bg-zinc-700/30 flex items-center justify-center mb-3">
                  <Shield size={24} className="opacity-50" />
                </div>
                <p className="text-sm text-zinc-300">暂无密码</p>
                <p className="text-xs mt-1 text-zinc-500">点击 + 添加新密码</p>
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((item) => (
                  <PasswordListItem
                    key={item.id}
                    item={item}
                    isSelected={selectedEntryId === item.id}
                    onClick={() => setSelectedEntryId(item.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Bottom Actions */}
          <div className="p-3 border-t border-zinc-600/30">
            <button
              onClick={handleLock}
              className="w-full py-2 rounded-lg bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-colors flex items-center justify-center gap-2 text-sm cursor-pointer"
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
            onTogglePassword={() => handleShowPassword(selectedEntry.id)}
            onCopyPassword={() => copyToClipboard(decryptedPasswords[selectedEntry.id] || '')}
            onCopyUsername={() => copyToClipboard(selectedEntry.username || '')}
            onCopyUrl={() => copyToClipboard(selectedEntry.url || '')}
            onDelete={() => handleDeleteEntry(selectedEntry.id)}
            onEdit={() => setShowCreateModal(true)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 p-8">
            <div className="w-24 h-24 rounded-3xl bg-zinc-800/30 flex items-center justify-center mb-6 border border-zinc-700/30">
              <LayoutGrid size={48} className="text-zinc-600" />
            </div>
            <p className="text-lg font-medium text-zinc-400">选择一个密码条目</p>
            <p className="text-sm mt-2 text-zinc-600">从左侧列表选择一个条目查看详情</p>
          </div>
        )}
      </div>

      {/* Create Entry Modal */}
      {showCreateModal && (
        <Modal onClose={() => { setShowCreateModal(false); setError(null); }}>
          <h3 className="text-zinc-200 font-medium mb-4">新增密码</h3>
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}
          <div className="space-y-3">
            <input
              type="text"
              value={newEntry.title}
              onChange={(e) => setNewEntry(prev => ({ ...prev, title: e.target.value }))}
              placeholder="标题 *"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
            />
            <input
              type="text"
              value={newEntry.username}
              onChange={(e) => setNewEntry(prev => ({ ...prev, username: e.target.value }))}
              placeholder="用户名"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
            />
            <input
              type="password"
              value={newEntry.password}
              onChange={(e) => setNewEntry(prev => ({ ...prev, password: e.target.value }))}
              placeholder="密码 *"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
            />
            <input
              type="text"
              value={newEntry.url}
              onChange={(e) => setNewEntry(prev => ({ ...prev, url: e.target.value }))}
              placeholder="网址"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
            />
            <select
              value={newEntry.category_id || ''}
              onChange={(e) => setNewEntry(prev => ({ ...prev, category_id: e.target.value ? parseInt(e.target.value) : undefined }))}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20"
            >
              <option value="" className="bg-zinc-800">选择分类</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id} className="bg-zinc-800">{cat.name}</option>
              ))}
            </select>
            <textarea
              value={newEntry.notes || ''}
              onChange={(e) => setNewEntry(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="备注"
              rows={3}
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg px-4 py-2 text-zinc-200 placeholder:text-zinc-600 outline-none transition-all duration-200 focus:border-zinc-500 focus:bg-zinc-800 focus:ring-2 focus:ring-zinc-600/20 resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => { setShowCreateModal(false); setError(null); }}
              className="px-4 py-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/30 transition-all duration-200 cursor-pointer"
            >
              取消
            </button>
            <button
              onClick={handleCreateEntry}
              disabled={!newEntry.title || !newEntry.password}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white transition-all duration-200 hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none cursor-pointer"
            >
              保存
            </button>
          </div>
        </Modal>
      )}

      </div>
    </div>
  );
}

interface PasswordListItemProps {
  item: PasswordEntry;
  isSelected: boolean;
  onClick: () => void;
}

function PasswordListItem({ item, isSelected, onClick }: PasswordListItemProps) {
  return (
    <div
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200 ${
        isSelected
          ? 'bg-zinc-700/50 border border-zinc-600/30'
          : 'hover:bg-zinc-700/30 border border-transparent'
      }`}
    >
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-zinc-200 font-medium truncate">{item.title}</span>
        </div>
        <span className="text-zinc-500 text-xs truncate block">
          {item.username || '无用户名'}
        </span>
      </div>
    </div>
  );
}

interface PasswordDetailProps {
  entry: PasswordEntry;
  decryptedPassword?: string;
  showPassword?: boolean;
  onTogglePassword: () => void;
  onCopyPassword: () => void;
  onCopyUsername: () => void;
  onCopyUrl: () => void;
  onDelete: () => void;
  onEdit: () => void;
}

function PasswordDetail({
  entry,
  decryptedPassword,
  showPassword,
  onTogglePassword,
  onCopyPassword,
  onCopyUsername,
  onCopyUrl,
  onDelete,
  onEdit,
}: PasswordDetailProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-zinc-600/30">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            {/* Large Icon */}
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-2xl shadow-lg">
              {entry.title.charAt(0).toUpperCase()}
            </div>

            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold text-zinc-200">{entry.title}</h2>
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
                  className="text-zinc-500 hover:text-indigo-400 text-sm flex items-center gap-1 mt-1 transition-colors cursor-pointer"
                >
                  {entry.url}
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onEdit}
              className="p-2.5 rounded-xl bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-all duration-200 cursor-pointer"
              title="编辑"
            >
              <MoreHorizontal size={18} />
            </button>
            <button
              onClick={onDelete}
              className="p-2.5 rounded-xl bg-zinc-700/30 text-zinc-400 hover:bg-red-500/20 hover:text-red-400 transition-all duration-200 cursor-pointer"
              title="删除"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-lg space-y-6">
          {/* Username Field */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">用户名 / 邮箱</label>
            <div className="rounded-xl p-4 flex items-center gap-3 border border-zinc-600/30 bg-zinc-800/30">
              <div className="w-10 h-10 rounded-lg bg-zinc-700/30 flex items-center justify-center">
                <span className="text-zinc-400 text-lg">@</span>
              </div>
              <code className="flex-1 text-zinc-200 text-sm">{entry.username || '-'}</code>
              {entry.username && (
                <button
                  onClick={onCopyUsername}
                  className="p-2 rounded-lg bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-all duration-200 cursor-pointer"
                  title="复制用户名"
                >
                  <Copy size={16} />
                </button>
              )}
            </div>
          </div>

          {/* Password Field */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">密码</label>
            <div className="rounded-xl p-4 flex items-center gap-3 border border-zinc-600/30 bg-zinc-800/30">
              <div className="w-10 h-10 rounded-lg bg-zinc-700/30 flex items-center justify-center">
                <Lock size={18} className="text-zinc-400" />
              </div>
              <code className="flex-1 text-zinc-200 text-sm font-mono">
                {showPassword ? decryptedPassword || '••••••••' : '••••••••••••••••'}
              </code>
              <button
                onClick={onTogglePassword}
                className="p-2 rounded-lg bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-all duration-200 cursor-pointer"
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              {showPassword && decryptedPassword && (
                <button
                  onClick={onCopyPassword}
                  className="p-2 rounded-lg bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-all duration-200 cursor-pointer"
                  title="复制密码"
                >
                  <Copy size={16} />
                </button>
              )}
            </div>
          </div>

          {/* URL Field */}
          {entry.url && (
            <div className="space-y-2">
              <label className="text-xs text-zinc-500 uppercase tracking-wider">网站地址</label>
              <div className="rounded-xl p-4 flex items-center gap-3 border border-zinc-600/30 bg-zinc-800/30">
                <div className="w-10 h-10 rounded-lg bg-zinc-700/30 flex items-center justify-center">
                  <Globe size={18} className="text-zinc-400" />
                </div>
                <code className="flex-1 text-zinc-200 text-sm truncate">{entry.url}</code>
                <button
                  onClick={onCopyUrl}
                  className="p-2 rounded-lg bg-zinc-700/30 text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200 transition-all duration-200 cursor-pointer"
                  title="复制网址"
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>
          )}

          {/* Notes Field */}
          {entry.notes && (
            <div className="space-y-2">
              <label className="text-xs text-zinc-500 uppercase tracking-wider">备注</label>
              <div className="rounded-xl p-4 border border-zinc-600/30 bg-zinc-800/30">
                <p className="text-zinc-300 text-sm whitespace-pre-wrap">{entry.notes}</p>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="pt-6 border-t border-zinc-600/30 space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>创建时间</span>
              <span>{new Date(entry.created_at).toLocaleString('zh-CN')}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>最后更新</span>
              <span>{new Date(entry.updated_at).toLocaleString('zh-CN')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rounded-2xl p-6 w-96 relative border border-zinc-600/30 shadow-2xl"
        style={{ backgroundColor: THEME.BG_SECONDARY }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}
