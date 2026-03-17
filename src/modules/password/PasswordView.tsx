import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Star, Copy, Eye, EyeOff, Lock, Trash2, X, LayoutGrid, Globe, Shield, CreditCard, Briefcase, Film, MoreHorizontal, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

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
  favorite: boolean;
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
        await invoke('resize_window', { height: 550, width: 920 });
      } catch (err) {
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
  const [selectedCategory, setSelectedCategory] = useState<number | 'all' | 'favorite'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreateCategoryModal, setShowCreateCategoryModal] = useState(false);
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
  const [newCategoryName, setNewCategoryName] = useState('');

  // Check unlock status
  const checkUnlockStatus = useCallback(async () => {
    try {
      const unlocked = await invoke<boolean>('is_password_manager_unlocked');
      setIsUnlocked(unlocked);
    } catch (err) {
      console.error('Failed to check unlock status:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkUnlockStatus();
  }, [checkUnlockStatus]);

  // Listen for menu actions from navigation bar
  useEffect(() => {
    const handleNewEntry = () => setShowCreateModal(true);
    const handleNewCategory = () => setShowCreateCategoryModal(true);
    const handleLock = async () => {
      await handleLockVault();
    };

    window.addEventListener('password:new-entry', handleNewEntry);
    window.addEventListener('password:new-category', handleNewCategory);
    window.addEventListener('password:lock', handleLock);

    return () => {
      window.removeEventListener('password:new-entry', handleNewEntry);
      window.removeEventListener('password:new-category', handleNewCategory);
      window.removeEventListener('password:lock', handleLock);
    };
  }, []);

  // Load data when unlocked
  useEffect(() => {
    if (isUnlocked) {
      loadCategories();
      loadEntries();
      // Reset selected entry when category or search changes
      setSelectedEntryId(null);
    }
  }, [isUnlocked, selectedCategory, searchQuery]);

  const loadCategories = async () => {
    try {
      const cats = await invoke<PasswordCategory[]>('get_password_categories');
      setCategories(cats);
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  };

  const loadEntries = async () => {
    try {
      const categoryId = selectedCategory === 'all' || selectedCategory === 'favorite'
        ? undefined
        : selectedCategory;
      const favoriteOnly = selectedCategory === 'favorite';

      console.log('[Password] Loading entries with params:', { categoryId, favoriteOnly, searchQuery });

      const ents = await invoke<PasswordEntry[]>('get_password_entries', {
        categoryId,
        favoriteOnly,
        search: searchQuery || undefined,
      });

      console.log('[Password] Loaded entries count:', ents.length, 'entries:', ents);
      setEntries(ents);
    } catch (err) {
      console.error('[Password] Failed to load entries:', err);
    }
  };

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
    } catch (err) {
      setError(err instanceof Error ? err.message : '解锁失败');
    }
  };

  const handleLock = async () => {
    await invoke('lock_password_manager');
    setIsUnlocked(false);
    setDecryptedPasswords({});
    setShowPasswordMap({});
  };

  const handleCreateEntry = async () => {
    if (!newEntry.title || !newEntry.password) {
      console.log('[Password] Validation failed: title or password is empty');
      return;
    }

    // 构建请求参数 - Rust 后端期望包装在 request 对象中
    const request = {
      title: newEntry.title,
      username: newEntry.username || null,
      password: newEntry.password,
      url: newEntry.url || null,
      notes: newEntry.notes || null,
      category_id: newEntry.category_id ? Number(newEntry.category_id) : null,
    };

    console.log('[Password] Creating entry with request:', request);

    try {
      setError(null);
      console.log('[Password] Calling create_password_entry...');
      const result = await invoke('create_password_entry', { request });
      console.log('[Password] Create entry success, ID:', result);

      console.log('[Password] Closing modal and resetting form...');
      setShowCreateModal(false);
      setNewEntry({ title: '', username: '', password: '', url: '', notes: '' });

      console.log('[Password] Reloading entries...');
      await loadEntries();
      console.log('[Password] Entries reloaded successfully');
    } catch (err: any) {
      console.error('[Password] Create entry error:', err);
      // Tauri 错误可能是字符串或对象
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      console.error('[Password] Error message:', errorMsg);
      setError(`创建失败: ${errorMsg}`);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCategoryName) {
      console.log('[Password] Category name is empty');
      return;
    }

    const request = {
      name: newCategoryName,
      icon: null,
      color: null,
    };

    console.log('[Password] Creating category with request:', request);

    try {
      setError(null);
      console.log('[Password] Calling create_password_category...');
      const result = await invoke('create_password_category', { request });
      console.log('[Password] Create category success, ID:', result);

      setShowCreateCategoryModal(false);
      setNewCategoryName('');
      await loadCategories();
      console.log('[Password] Categories reloaded');
    } catch (err: any) {
      console.error('[Password] Create category error:', err);
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(`创建分类失败: ${errorMsg}`);
    }
  };

  const handleToggleFavorite = async (id: number) => {
    try {
      await invoke('toggle_password_favorite', { id });
      loadEntries();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  };

  const handleDeleteEntry = async (id: number) => {
    if (!confirm('确定要删除这个密码吗？')) return;

    try {
      await invoke('delete_password_entry', { id });
      loadEntries();
    } catch (err) {
      console.error('Failed to delete entry:', err);
    }
  };

  const handleShowPassword = async (id: number) => {
    console.log('[Password] Toggle show password for id:', id, 'current state:', showPasswordMap[id]);

    if (showPasswordMap[id]) {
      // Hide
      console.log('[Password] Hiding password');
      setShowPasswordMap(prev => ({ ...prev, [id]: false }));
      return;
    }

    // Check if already decrypted
    if (decryptedPasswords[id]) {
      console.log('[Password] Already decrypted, showing');
      setShowPasswordMap(prev => ({ ...prev, [id]: true }));
      return;
    }

    // Decrypt
    console.log('[Password] Decrypting password for id:', id);
    try {
      const password = await invoke<string>('get_decrypted_password', { id });
      console.log('[Password] Decrypted successfully, length:', password.length);
      setDecryptedPasswords(prev => ({ ...prev, [id]: password }));
      setShowPasswordMap(prev => ({ ...prev, [id]: true }));
    } catch (err) {
      console.error('[Password] Failed to decrypt password:', err);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-white/40">
        <div className="animate-spin mr-2">⌛</div>
        <span>加载中...</span>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="glass-panel rounded-2xl p-8 w-80 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center mx-auto mb-4">
            <Lock size={32} className="text-white" />
          </div>
          <h3 className="text-xl font-semibold text-white mb-2">密码管理器</h3>
          <p className="text-white/60 text-sm mb-4">请输入主密码解锁</p>

          {error && (
            <p className="text-red-400 text-sm mb-4">{error}</p>
          )}

          <input
            type="password"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            placeholder="主密码"
            className="w-full bg-white/15 border border-white/30 rounded-xl px-4 py-3 text-white placeholder:text-white/40 outline-none focus:border-blue-500 focus:bg-white/20 mb-4 shadow-inner"
            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
            autoFocus
          />

          <button
            onClick={handleUnlock}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-medium hover:opacity-90 transition-opacity"
          >
            解锁
          </button>
        </div>
      </div>
    );
  }

  const selectedEntry = entries.find(e => e.id === selectedEntryId);

  return (
    <div className="w-full h-full overflow-x-auto">
      <div className="w-[900px] h-full flex" style={{ backgroundColor: '#333333' }}>
        {/* Left Sidebar - Categories */}
        <aside className="w-[180px] border-r border-white/10 flex flex-col flex-shrink-0">
          {/* Category List */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs text-white/40 font-medium uppercase tracking-wider mb-2 px-2">
            分类
          </div>
          <div className="space-y-0.5">
            <CategoryButton
              id="all"
              name="全部密码"
              icon={LayoutGrid}
              count={entries.length}
              isSelected={selectedCategory === 'all'}
              onClick={() => setSelectedCategory('all')}
            />
            <CategoryButton
              id="favorite"
              name="收藏"
              icon={Star}
              count={entries.filter(e => e.favorite).length}
              isSelected={selectedCategory === 'favorite'}
              onClick={() => setSelectedCategory('favorite')}
            />
          </div>

          <div className="text-xs text-white/40 font-medium uppercase tracking-wider mt-4 mb-2 px-2">
            自定义文件夹
          </div>
          <div className="space-y-0.5">
            {categories.map((cat) => (
              <CategoryButton
                key={cat.id}
                id={cat.id}
                name={cat.name}
                icon={getCategoryIcon(cat.icon)}
                color={cat.color}
                count={entries.filter(e => e.category_id === cat.id).length}
                isSelected={selectedCategory === cat.id}
                onClick={() => setSelectedCategory(cat.id)}
              />
            ))}
            <button
              onClick={() => setShowCreateCategoryModal(true)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors text-sm"
            >
              <Plus size={16} />
              <span>新建文件夹</span>
            </button>
          </div>
        </div>

        {/* Bottom Actions */}
        <div className="p-3 border-t border-white/10 space-y-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
          >
            <Plus size={16} />
            新增密码
          </button>
          <button
            onClick={handleLock}
            className="w-full py-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <Lock size={14} />
            锁定保险库
          </button>
        </div>
      </aside>

      {/* Middle - Password List */}
      <div className="w-[170px] border-r border-white/10 flex flex-col flex-shrink-0" style={{ backgroundColor: '#2a2a2a' }}>
        {/* Search Bar */}
        <div className="p-3 border-b border-white/10">
          <div className="glass-panel rounded-lg px-3 py-2 flex items-center gap-2">
            <Search size={16} className="text-white/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索密码..."
              className="flex-1 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-white/40 hover:text-white/60"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Password Items */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-white/40 p-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                <Shield size={32} className="text-white/20" />
              </div>
              <p className="text-sm">暂无密码</p>
              <p className="text-xs mt-1 opacity-60">点击左下角添加新密码</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {entries.map((item) => (
                <PasswordListItem
                  key={item.id}
                  item={item}
                  isSelected={selectedEntryId === item.id}
                  onClick={() => setSelectedEntryId(item.id)}
                  onToggleFavorite={() => handleToggleFavorite(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right - Detail View */}
      <div className="w-[550px] flex flex-col flex-shrink-0" style={{ backgroundColor: '#333333' }}>
        {selectedEntry ? (
          <PasswordDetail
            entry={selectedEntry}
            decryptedPassword={decryptedPasswords[selectedEntry.id]}
            showPassword={!!showPasswordMap[selectedEntry.id]}
            onTogglePassword={() => handleShowPassword(selectedEntry.id)}
            onCopyPassword={() => copyToClipboard(decryptedPasswords[selectedEntry.id] || '')}
            onCopyUsername={() => copyToClipboard(selectedEntry.username || '')}
            onCopyUrl={() => copyToClipboard(selectedEntry.url || '')}
            onToggleFavorite={() => handleToggleFavorite(selectedEntry.id)}
            onDelete={() => handleDeleteEntry(selectedEntry.id)}
            onEdit={() => setShowCreateModal(true)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-white/30 p-8">
            <div className="w-24 h-24 rounded-3xl bg-white/5 flex items-center justify-center mb-6">
              <LayoutGrid size={48} className="text-white/20" />
            </div>
            <p className="text-lg font-medium text-white/40">选择一个密码条目</p>
            <p className="text-sm mt-2">从左侧列表选择一个条目查看详情</p>
          </div>
        )}
      </div>

      {/* Create Entry Modal */}
      {showCreateModal && (
        <Modal onClose={() => { setShowCreateModal(false); setError(null); }}>
          <h3 className="text-white font-medium mb-4">新增密码</h3>
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}
          <div className="space-y-3">
            <input
              type="text"
              value={newEntry.title}
              onChange={(e) => setNewEntry(prev => ({ ...prev, title: e.target.value }))}
              placeholder="标题 *"
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500"
            />
            <input
              type="text"
              value={newEntry.username}
              onChange={(e) => setNewEntry(prev => ({ ...prev, username: e.target.value }))}
              placeholder="用户名"
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500"
            />
            <input
              type="password"
              value={newEntry.password}
              onChange={(e) => setNewEntry(prev => ({ ...prev, password: e.target.value }))}
              placeholder="密码 *"
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500"
            />
            <input
              type="text"
              value={newEntry.url}
              onChange={(e) => setNewEntry(prev => ({ ...prev, url: e.target.value }))}
              placeholder="网址"
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500"
            />
            <select
              value={newEntry.category_id || ''}
              onChange={(e) => setNewEntry(prev => ({ ...prev, category_id: e.target.value ? parseInt(e.target.value) : undefined }))}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white outline-none focus:border-blue-500"
            >
              <option value="">选择分类</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
            <textarea
              value={newEntry.notes || ''}
              onChange={(e) => setNewEntry(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="备注"
              rows={3}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500 resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => { setShowCreateModal(false); setError(null); }}
              className="px-4 py-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreateEntry}
              disabled={!newEntry.title || !newEntry.password}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* Create Category Modal */}
      {showCreateCategoryModal && (
        <Modal onClose={() => { setShowCreateCategoryModal(false); setError(null); }}>
          <h3 className="text-white font-medium mb-4">新建分类</h3>
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="分类名称"
            className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white placeholder:text-white/40 outline-none focus:border-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => { setShowCreateCategoryModal(false); setError(null); }}
              className="px-4 py-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreateCategory}
              disabled={!newCategoryName}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              创建
            </button>
          </div>
        </Modal>
      )}
      </div>
    </div>
  );
}

function getCategoryIcon(iconName?: string) {
  switch (iconName) {
    case 'globe': return Globe;
    case 'briefcase': return Briefcase;
    case 'credit-card': return CreditCard;
    case 'film': return Film;
    case 'shield': return Shield;
    default: return LayoutGrid;
  }
}

interface CategoryButtonProps {
  id: number | string;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color?: string;
  count?: number;
  isSelected: boolean;
  onClick: () => void;
}

function CategoryButton({ name, icon: Icon, color, count, isSelected, onClick }: CategoryButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
        isSelected
          ? 'bg-white/10 text-white'
          : 'text-white/60 hover:bg-white/5 hover:text-white'
      }`}
    >
      <div className="flex items-center gap-3">
        <Icon size={16} style={color ? { color } : undefined} />
        <span>{name}</span>
      </div>
      {count !== undefined && count > 0 && (
        <span className="text-xs text-white/30">{count}</span>
      )}
    </button>
  );
}

interface PasswordListItemProps {
  item: PasswordEntry;
  isSelected: boolean;
  onClick: () => void;
  onToggleFavorite: () => void;
}

function PasswordListItem({ item, isSelected, onClick, onToggleFavorite }: PasswordListItemProps) {
  return (
    <div
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
        isSelected
          ? 'bg-white/10 border border-white/20'
          : 'hover:bg-white/5 border border-transparent'
      }`}
    >
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-white font-medium truncate">{item.title}</span>
          {item.favorite && (
            <Star size={12} className="text-yellow-400 fill-yellow-400 shrink-0" />
          )}
        </div>
        <span className="text-white/40 text-xs truncate block">
          {item.username || '无用户名'}
        </span>
      </div>

      {/* Favorite button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        className={`shrink-0 p-1.5 rounded-lg transition-colors ${
          item.favorite ? 'text-yellow-400' : 'text-white/20 hover:text-white/60'
        }`}
      >
        <Star size={14} fill={item.favorite ? 'currentColor' : 'none'} />
      </button>
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
  onToggleFavorite: () => void;
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
  onToggleFavorite,
  onDelete,
  onEdit,
}: PasswordDetailProps) {
  console.log('[Password] PasswordDetail render - showPassword:', showPassword, 'decryptedPassword:', decryptedPassword ? '[存在]' : '[空]');
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-white/10">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            {/* Large Icon */}
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-2xl">
              {entry.title.charAt(0).toUpperCase()}
            </div>

            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold text-white">{entry.title}</h2>
                {entry.favorite && <Star size={18} className="text-yellow-400 fill-yellow-400" />}
              </div>
              {entry.url && (
                <a
                  href={entry.url.startsWith('http') ? entry.url : `https://${entry.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/40 hover:text-blue-400 text-sm flex items-center gap-1 mt-1 transition-colors"
                >
                  {entry.url}
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleFavorite}
              className={`p-2.5 rounded-xl transition-colors ${
                entry.favorite
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
              }`}
              title={entry.favorite ? '取消收藏' : '添加到收藏'}
            >
              <Star size={18} fill={entry.favorite ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={onEdit}
              className="p-2.5 rounded-xl bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
              title="编辑"
            >
              <MoreHorizontal size={18} />
            </button>
            <button
              onClick={onDelete}
              className="p-2.5 rounded-xl bg-white/5 text-white/60 hover:bg-red-500/20 hover:text-red-400 transition-colors"
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
            <label className="text-xs text-white/40 uppercase tracking-wider">用户名 / 邮箱</label>
            <div className="glass-panel rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                <span className="text-white/60 text-lg">@</span>
              </div>
              <code className="flex-1 text-white/90 text-sm">{entry.username || '-'}</code>
              {entry.username && (
                <button
                  onClick={onCopyUsername}
                  className="p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
                  title="复制用户名"
                >
                  <Copy size={16} />
                </button>
              )}
            </div>
          </div>

          {/* Password Field */}
          <div className="space-y-2">
            <label className="text-xs text-white/40 uppercase tracking-wider">密码</label>
            <div className="glass-panel rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                <Lock size={18} className="text-white/60" />
              </div>
              <code className="flex-1 text-white/90 text-sm font-mono">
                {showPassword ? decryptedPassword || '••••••••' : '••••••••••••••••'}
              </code>
              <button
                onClick={onTogglePassword}
                className="p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              {showPassword && decryptedPassword && (
                <button
                  onClick={onCopyPassword}
                  className="p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
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
              <label className="text-xs text-white/40 uppercase tracking-wider">网站地址</label>
              <div className="glass-panel rounded-xl p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                  <Globe size={18} className="text-white/60" />
                </div>
                <code className="flex-1 text-white/90 text-sm truncate">{entry.url}</code>
                <button
                  onClick={onCopyUrl}
                  className="p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
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
              <label className="text-xs text-white/40 uppercase tracking-wider">备注</label>
              <div className="glass-panel rounded-xl p-4">
                <p className="text-white/70 text-sm whitespace-pre-wrap">{entry.notes}</p>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="pt-6 border-t border-white/10 space-y-2">
            <div className="flex items-center justify-between text-xs text-white/30">
              <span>创建时间</span>
              <span>{new Date(entry.created_at).toLocaleString('zh-CN')}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-white/30">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass-panel rounded-2xl p-6 w-96 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-white/40 hover:text-white transition-colors"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}
