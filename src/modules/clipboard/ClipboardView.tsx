import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search,
  Star,
  Loader2,
  FileText,
  Image as ImageIcon,
  Folder,
  X,
  Filter,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Tooltip } from '@/components/Tooltip';
import { THEME } from '../../constants/theme';
import { WINDOW_SIZE } from '../../constants/window';
import { immediateResize } from '../../utils/tauri';
import { imageCache } from './imageCache';
import { isImageFile } from './utils';
import type { ClipboardItemData, ClipboardQuery, TabType } from './types';
import { ClipboardListItem } from './ClipboardListItem';
import { ClipboardDetail } from './ClipboardDetail';
import { useClipboardSelectionStore } from '@/stores/clipboardSelectionStore';

/** 焦点在输入框/文本域时不响应单键快捷键（F 收藏 / Del 删除），避免与输入冲突 */
function isTypingTarget(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

export function ClipboardView() {
  // Resize window when view mounts — use immediateResize to cancel any
  // pending debounce left by LauncherView and apply the correct size at once.
  useEffect(() => {
    immediateResize(WINDOW_SIZE.CLIPBOARD.height, WINDOW_SIZE.CLIPBOARD.width);
  }, []);

  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<ClipboardItemData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(offset);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const PAGE_SIZE = 100;

  // Keep offsetRef in sync with offset state
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  const tabs = useMemo(
    () => [
      { id: 'all' as TabType, label: '全部', icon: Filter },
      { id: 'text' as TabType, label: '文本', icon: FileText },
      { id: 'image' as TabType, label: '图片', icon: ImageIcon },
      { id: 'file' as TabType, label: '文件', icon: Folder },
      { id: 'favorite' as TabType, label: '收藏', icon: Star },
    ],
    []
  );

  const fetchClipboardHistory = useCallback(async (loadMore = false) => {
    try {
      if (loadMore) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setOffset(0);
      }
      setError(null);

      // Use ref to get latest offset value
      const currentOffset = loadMore ? offsetRef.current : 0;

      const query: ClipboardQuery = {
        limit: PAGE_SIZE,
        offset: currentOffset,
      };

      if (activeTab !== 'all' && activeTab !== 'favorite') {
        query.content_type = activeTab;
      }

      if (activeTab === 'favorite') {
        query.is_favorite = true;
      }

      if (searchQuery.trim()) {
        query.search = searchQuery.trim();
      }

      let result = await invoke<ClipboardItemData[]>('get_clipboard_history', { query });

      // For image tab, also include image files (type='file' but path is image)
      if (activeTab === 'image') {
        const fileQuery: ClipboardQuery = {
          limit: PAGE_SIZE,
          offset: currentOffset,
          content_type: 'file',
        };
        if (searchQuery.trim()) {
          fileQuery.search = searchQuery.trim();
        }
        const fileResult = await invoke<ClipboardItemData[]>('get_clipboard_history', { query: fileQuery });
        const imageFiles = fileResult.filter(item => isImageFile(item.content));
        result = [...result, ...imageFiles].sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ).slice(0, PAGE_SIZE);
      }

      if (loadMore) {
        setItems(prev => [...prev, ...result]);
        setOffset(prev => prev + PAGE_SIZE);
      } else {
        setItems(result);
        setOffset(PAGE_SIZE);
        // 双栏布局：刷新后自动选中首条，让详情面板始终有内容
        setSelectedId(result.length > 0 ? result[0].id : null);
      }

      // If we got less than PAGE_SIZE items, there are no more
      setHasMore(result.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取剪贴板历史失败');
      console.error('Failed to fetch clipboard history:', err);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [activeTab, searchQuery]); // Remove offset from dependencies

  useEffect(() => {
    fetchClipboardHistory(false);
  }, [fetchClipboardHistory]);

  // Listen for clipboard updates from backend
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen('clipboard-updated', () => {
        // Reset to first page when new item arrives
        fetchClipboardHistory(false);
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [fetchClipboardHistory]);

  const handleToggleFavorite = useCallback(async (id: number) => {
    try {
      await invoke('toggle_clipboard_favorite', { id });
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to toggle favorite:', err);
      setError(`收藏操作失败: ${message}`);
    }
  }, [fetchClipboardHistory]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await invoke('delete_clipboard_item', { id });
      imageCache.remove(id);
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to delete clipboard item:', err);
      setError(`删除失败: ${message}`);
    }
  }, [fetchClipboardHistory]);

  const handleCopyToClipboard = useCallback(async (id: number) => {
    try {
      await invoke('copy_to_clipboard', { id });
      // 刷新列表以显示更新后的排序
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to copy to clipboard:', err);
      setError(`复制失败: ${message}`);
    }
  }, [fetchClipboardHistory]);

  const handleCopyPartialText = async (text: string) => {
    try {
      await invoke('copy_text_to_clipboard', { text });
      // 刷新列表以显示更新后的排序（新条目会出现在顶部）
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to copy partial text:', err);
      setError(`复制选中内容失败: ${message}`);
    }
  };

  // 粘贴到上一窗口（后端处理窗口切换与模拟粘贴）；失败时回退为仅复制
  const handlePasteItem = useCallback(async (id: number) => {
    try {
      await invoke('paste_to_clipboard_item', { id });
    } catch (err) {
      console.error('Failed to paste clipboard item:', err);
      handleCopyToClipboard(id);
    }
  }, [handleCopyToClipboard]);

  // 图片条目（image 类型 content 即 PNG 落盘路径；文件类型的图片同理）在资源管理器中打开
  const handleRevealInExplorer = useCallback(async () => {
    const item = items.find((i) => i.id === selectedId);
    if (!item) return;
    try {
      await revealItemInDir(item.content);
    } catch (err) {
      console.error('Failed to reveal in explorer:', err);
    }
  }, [items, selectedId]);

  // Group items by date
  const groupedItems = useMemo(() => {
    const groups: { [key: string]: ClipboardItemData[] } = {};
    items.forEach((item) => {
      const date = new Date(item.created_at);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let key: string;
      if (date.toDateString() === today.toDateString()) {
        key = '今天';
      } else if (date.toDateString() === yesterday.toDateString()) {
        key = '昨天';
      } else {
        key = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
      }

      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    });
    return groups;
  }, [items]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );

  // 同步选中状态到 store，供 TopNavigationBar 动作菜单使用；卸载时清空
  const setSelection = useClipboardSelectionStore((s) => s.setSelection);
  useEffect(() => {
    setSelection({
      hasSelection: selectedItem !== null,
      isFavorite: selectedItem?.is_favorite ?? false,
      isImage: selectedItem
        ? selectedItem.content_type === 'image' ||
          (selectedItem.content_type === 'file' && isImageFile(selectedItem.content))
        : false,
    });
  }, [selectedItem, setSelection]);
  useEffect(() => {
    return () => setSelection({ hasSelection: false, isFavorite: false, isImage: false });
  }, [setSelection]);

  // TopNavigationBar 动作菜单 / 右键菜单的条目级动作（custom event 下发）
  useEffect(() => {
    const onPaste = () => { if (selectedId != null) handlePasteItem(selectedId); };
    const onCopy = () => { if (selectedId != null) handleCopyToClipboard(selectedId); };
    const onFavorite = () => { if (selectedId != null) handleToggleFavorite(selectedId); };
    const onDelete = () => { if (selectedId != null) handleDelete(selectedId); };
    const onReveal = () => { handleRevealInExplorer(); };
    window.addEventListener('clipboard:paste-selected', onPaste);
    window.addEventListener('clipboard:copy-selected', onCopy);
    window.addEventListener('clipboard:favorite-selected', onFavorite);
    window.addEventListener('clipboard:delete-selected', onDelete);
    window.addEventListener('clipboard:reveal-selected', onReveal);
    return () => {
      window.removeEventListener('clipboard:paste-selected', onPaste);
      window.removeEventListener('clipboard:copy-selected', onCopy);
      window.removeEventListener('clipboard:favorite-selected', onFavorite);
      window.removeEventListener('clipboard:delete-selected', onDelete);
      window.removeEventListener('clipboard:reveal-selected', onReveal);
    };
  }, [selectedId, handlePasteItem, handleCopyToClipboard, handleToggleFavorite, handleDelete, handleRevealInExplorer]);

  // Keyboard navigation for clipboard list
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (items.length === 0) return;

      // Get flat list of item IDs in display order
      const flatIds = Object.values(groupedItems).flat().map(item => item.id);
      if (flatIds.length === 0) return;

      const currentIndex = selectedId ? flatIds.indexOf(selectedId) : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = currentIndex < flatIds.length - 1 ? currentIndex + 1 : 0;
        const nextId = flatIds[nextIndex];
        setSelectedId(nextId);
        itemRefs.current.get(nextId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : flatIds.length - 1;
        const prevId = flatIds[prevIndex];
        setSelectedId(prevId);
        itemRefs.current.get(prevId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'Enter' && selectedId) {
        e.preventDefault();
        // Enter = 粘贴到上一窗口；Ctrl+Enter = 仅复制
        if (e.ctrlKey || e.metaKey) {
          handleCopyToClipboard(selectedId);
        } else {
          handlePasteItem(selectedId);
        }
      } else if (!isTypingTarget() && (e.key === 'f' || e.key === 'F') && selectedId) {
        e.preventDefault();
        handleToggleFavorite(selectedId);
      } else if (!isTypingTarget() && e.key === 'Delete' && selectedId) {
        e.preventDefault();
        handleDelete(selectedId);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [items, groupedItems, selectedId, handleCopyToClipboard, handlePasteItem, handleToggleFavorite, handleDelete]);

  // Infinite scroll - auto load more when scrolling near bottom
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (!isLoadingMore && hasMore) {
            const { scrollTop, scrollHeight, clientHeight } = listElement;
            if (scrollHeight - scrollTop - clientHeight < 10) {
              fetchClipboardHistory(true);
            }
          }
          ticking = false;
        });
        ticking = true;
      }
    };

    listElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => listElement.removeEventListener('scroll', handleScroll);
  }, [isLoadingMore, hasMore, fetchClipboardHistory]);

  // 整窗状态：加载中 / 错误 /（非搜索态的）空列表
  if (isLoading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-app-text-disabled" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <Loader2 size={32} className="animate-spin mb-3" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-app-text-disabled" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <p className="text-app-status-error mb-2">{error}</p>
        <button
          onClick={() => fetchClipboardHistory(false)}
          className="px-4 py-2 rounded-lg bg-app-bg-pressed/50 hover:bg-app-bg-elevated/50 text-sm text-app-text-primary transition-colors cursor-pointer"
        >
          重试
        </button>
      </div>
    );
  }

  if (items.length === 0 && !searchQuery.trim()) {
    return (
      <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
        <EmptyState activeTab={activeTab} />
      </div>
    );
  }

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* 左栏：搜索 + 过滤 + 紧凑列表 */}
      <aside
        className="w-[300px] flex-shrink-0 flex flex-col border-r border-app-border-subtle"
        style={{ backgroundColor: THEME.BG_SECONDARY }}
      >
        {/* Search（与右栏详情头同高 h-11） */}
        <div className="flex items-center px-3 h-11 border-b border-app-border-subtle">
          <Search className="w-4 h-4 text-app-text-tertiary mx-2 flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索剪贴板历史..."
            className="flex-1 min-w-0 bg-transparent text-sm text-app-text-primary placeholder-app-text-placeholder outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="ml-2 w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filter chips（图标 + Tooltip） */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-app-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <Tooltip key={tab.id} content={tab.label} placement="bottom">
                <button
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-[30px] h-[30px] rounded-md flex items-center justify-center transition-colors duration-150 cursor-pointer ${
                    active
                      ? 'bg-white/10 text-app-text-primary'
                      : 'text-app-text-tertiary hover:text-app-text-secondary hover:bg-white/5'
                  }`}
                >
                  <Icon size={14} />
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* List */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-1.5 pb-3 pt-1">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-app-text-disabled px-4 text-center">
              <p className="text-sm">没有匹配「{searchQuery.trim()}」的记录</p>
            </div>
          ) : (
            Object.entries(groupedItems).map(([date, dateItems]) => (
              <div key={date}>
                <h3
                  className="text-app-text-tertiary text-xs font-medium px-2.5 pt-2 pb-1.5 sticky top-0 z-10"
                  style={{ backgroundColor: THEME.BG_SECONDARY }}
                >
                  {date}
                </h3>
                {dateItems.map((item) => (
                  <ClipboardListItem
                    key={item.id}
                    ref={(el) => {
                      if (el) {
                        itemRefs.current.set(item.id, el);
                      } else {
                        itemRefs.current.delete(item.id);
                      }
                    }}
                    item={item}
                    isSelected={selectedId === item.id}
                    onSelect={() => setSelectedId(item.id)}
                    onPaste={() => handlePasteItem(item.id)}
                    onContextMenu={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
            ))
          )}

          {hasMore && items.length > 0 && (
            <div className="text-center py-2.5 text-app-text-disabled text-xs">
              {isLoadingMore ? (
                <span className="flex items-center justify-center gap-1">
                  <Loader2 size={12} className="animate-spin" />
                  加载中...
                </span>
              ) : (
                <span>下滑查看更多</span>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* 右栏：详情面板 */}
      <section className="flex-1 min-w-0 flex flex-col">
        {selectedItem ? (
          <ClipboardDetail
            item={selectedItem}
            onCopyPartial={handleCopyPartialText}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-app-text-disabled text-sm">
            选择左侧条目查看详情
          </div>
        )}
      </section>
    </div>
  );
}

// Empty State Component（非搜索态的空列表，整窗呈现）
function EmptyState({ activeTab }: { activeTab: TabType }) {
  const messages: Record<TabType, { icon: React.ElementType; title: string; desc: string }> = {
    all: { icon: Filter, title: '暂无剪贴板记录', desc: '复制内容后将自动保存' },
    text: { icon: FileText, title: '暂无文本记录', desc: '复制文本后将显示在这里' },
    image: { icon: ImageIcon, title: '暂无图片记录', desc: '复制图片后将显示在这里' },
    file: { icon: Folder, title: '暂无文件记录', desc: '复制文件后将显示在这里' },
    favorite: { icon: Star, title: '暂无收藏', desc: '点击星标收藏常用内容' },
  };

  const { icon: Icon, title, desc } = messages[activeTab];

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-app-text-disabled py-20">
      <div className="w-16 h-16 rounded-2xl bg-app-bg-elevated/30 flex items-center justify-center mb-4">
        <Icon size={32} className="opacity-50" />
      </div>
      <p className="text-app-text-secondary font-medium">{title}</p>
      <p className="text-sm mt-1 text-app-text-disabled">{desc}</p>
    </div>
  );
}
