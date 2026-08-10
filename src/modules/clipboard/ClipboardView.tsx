import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Search,
  Star,
  Loader2,
  FileText,
  Image as ImageIcon,
  Folder,
  Music,
  Video,
  X,
  Filter,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Tooltip } from '@/components/Tooltip';
import { WINDOW_SIZE } from '../../constants/window';
import { immediateResize } from '../../utils/tauri';
import { imageCache } from './imageCache';
import { isImageFile } from './utils';
import type { ClipboardItemData, ClipboardQuery, TabType } from './types';
import { ClipboardListItem } from './ClipboardListItem';
import { ClipboardDetail } from './ClipboardDetail';
import { useClipboardSelectionStore } from '@/stores/clipboardSelectionStore';
import { useAppStore } from '@/stores/appStore';

/** 焦点在输入框/文本域时不响应单键快捷键（F 收藏 / Del 删除），避免与输入冲突 */
function isTypingTarget(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

// 模块级首屏缓存：跨组件重挂载存活（与 PluginHost 的 lazyViewCache 同思路）。
// 仅缓存「全部 + 无搜索」的首屏；切 tab/搜索/翻页不写缓存。
// 进入工具时先用缓存渲染、后台静默刷新，消灭重挂载时的整屏「加载中...」闪帧。
let cachedFirstPage: ClipboardItemData[] | null = null;

export function ClipboardView() {
  // Resize window when view mounts — use immediateResize to cancel any
  // pending debounce left by LauncherView and apply the correct size at once.
  useEffect(() => {
    immediateResize(WINDOW_SIZE.CLIPBOARD.height, WINDOW_SIZE.CLIPBOARD.width);
  }, []);

  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<ClipboardItemData[]>(cachedFirstPage ?? []);
  const [isLoading, setIsLoading] = useState(cachedFirstPage === null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(offset);
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
      { id: 'audio' as TabType, label: '音频', icon: Music },
      { id: 'video' as TabType, label: '视频', icon: Video },
      { id: 'file' as TabType, label: '文件', icon: Folder },
      { id: 'favorite' as TabType, label: '收藏', icon: Star },
    ],
    []
  );

  const fetchClipboardHistory = useCallback(async (loadMore = false, silent = false) => {
    try {
      if (loadMore) {
        setIsLoadingMore(true);
      } else if (!silent) {
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

      // 图片 tab 的「file 类型里的图片路径」由后端在 SQL 层合并（content_type='image' 特殊化），
      // 单一口径翻页；不要前端双查询合并——两个 offset 口径不一致，会重复/漏条
      const result = await invoke<ClipboardItemData[]>('get_clipboard_history', { query });

      if (loadMore) {
        setItems(prev => [...prev, ...result]);
        setOffset(prev => prev + PAGE_SIZE);
      } else {
        setItems(result);
        setOffset(PAGE_SIZE);
        // 仅「全部 + 无搜索」的整页结果写缓存（切 tab/搜索态不污染缓存）
        if (activeTab === 'all' && !searchQuery.trim()) {
          cachedFirstPage = result;
        }
        // 双栏布局：刷新后自动选中首条，让详情面板始终有内容
        setSelectedId(result.length > 0 ? result[0].id : null);
      }

      // If we got less than PAGE_SIZE items, there are no more
      setHasMore(result.length === PAGE_SIZE);
    } catch (err) {
      // 静默刷新失败：保留缓存渲染、不上错误页（用户有旧数据可看），仅记录
      if (!silent) {
        setError(err instanceof Error ? err.message : '获取剪贴板历史失败');
        console.error('Failed to fetch clipboard history:', err);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
      setIsLoadingMore(false);
    }
  }, [activeTab, searchQuery]); // Remove offset from dependencies

  // 挂载首拉：有缓存走静默刷新（先渲染缓存数据、后台更新），无缓存正常带 loading 首拉。
  // tab/搜索变化触发的依赖重跑仍走原逻辑（保留主动操作的 loading 反馈）。
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      fetchClipboardHistory(false, cachedFirstPage !== null);
    } else {
      fetchClipboardHistory(false);
    }
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

  // 发送给AI：条目内容原文填入聊天输入框并切到聊天视图（不自动发送，用户可补充指令）
  // 文本发原文；图片发 PNG 落盘路径；文件发换行分隔的路径列表（与详情面板展示口径一致）
  const handleSendToAI = useCallback(() => {
    const item = items.find((i) => i.id === selectedId);
    if (!item) return;
    const { setChatPrefill, setActiveView } = useAppStore.getState();
    setChatPrefill(item.content);
    setActiveView('chat');
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

  // 固定组头槽位的当前组：滚动时由 handleListScroll 更新。
  // 数据变化时保留仍存在的组（加载更多会追加分组，不能无条件重置），否则回退首组
  const [currentGroup, setCurrentGroup] = useState<string | null>(null);
  useEffect(() => {
    const keys = Object.keys(groupedItems);
    setCurrentGroup((prev) => (prev && keys.includes(prev) ? prev : keys[0] ?? null));
  }, [groupedItems]);

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
    const onSendToAI = () => { handleSendToAI(); };
    window.addEventListener('clipboard:paste-selected', onPaste);
    window.addEventListener('clipboard:copy-selected', onCopy);
    window.addEventListener('clipboard:favorite-selected', onFavorite);
    window.addEventListener('clipboard:delete-selected', onDelete);
    window.addEventListener('clipboard:reveal-selected', onReveal);
    window.addEventListener('clipboard:send-to-ai-selected', onSendToAI);
    return () => {
      window.removeEventListener('clipboard:paste-selected', onPaste);
      window.removeEventListener('clipboard:copy-selected', onCopy);
      window.removeEventListener('clipboard:favorite-selected', onFavorite);
      window.removeEventListener('clipboard:delete-selected', onDelete);
      window.removeEventListener('clipboard:reveal-selected', onReveal);
      window.removeEventListener('clipboard:send-to-ai-selected', onSendToAI);
    };
  }, [selectedId, handlePasteItem, handleCopyToClipboard, handleToggleFavorite, handleDelete, handleRevealInExplorer, handleSendToAI]);

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

  // Infinite scroll - 滑近底部自动加载下一页。
  // 用 onScroll 而非 useEffect+addEventListener：列表要等首屏加载完才渲染，
  // 若首屏恰好返回满页（hasMore 不变、effect 依赖不变、不重跑），
  // ref 上的监听永远挂不上——表现为「下滑查看更多」还在但滑动无反应。
  const loadingMoreRef = useRef(false);
  const handleListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!loadingMoreRef.current && hasMore) {
        const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
        if (scrollHeight - scrollTop - clientHeight < 10) {
          loadingMoreRef.current = true;
          fetchClipboardHistory(true).finally(() => {
            loadingMoreRef.current = false;
          });
        }
      }
      // 跟踪当前日期组：槽位底边（32px）落在哪个分组上，槽位就显示哪个组；
      // 滚到底时兜底取最后一组（末组不足一屏高时，其顶边永远到不了切换线）
      const el = e.currentTarget;
      const switchLine = el.getBoundingClientRect().top + 32;
      const groups = el.querySelectorAll('[data-group]');
      let current: string | null = null;
      for (const g of groups) {
        if (g.getBoundingClientRect().top <= switchLine) {
          current = g.getAttribute('data-group');
        } else {
          break;
        }
      }
      if (groups.length > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        current = groups[groups.length - 1].getAttribute('data-group');
      }
      if (current) setCurrentGroup(current);
    },
    [hasMore, fetchClipboardHistory]
  );

  // 整窗状态：加载中 / 错误 /（非搜索态的）空列表
  if (isLoading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-app-text-disabled panel-glass">
        <Loader2 size={32} className="animate-spin mb-3" />
        <span className="text-sm">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-app-text-disabled panel-glass">
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

  return (
    <div className="w-full h-full flex panel-glass">
      {/* 左栏：搜索 + 过滤 + 紧凑列表 */}
      <aside
        className="w-[300px] flex-shrink-0 flex flex-col border-r border-app-border-subtle"
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

        {/* List（外层 relative 容器承载固定组头槽位） */}
        <div className="relative flex-1 min-h-0">
          {/* 滚动层顶部留出槽位高度（pt-8=32px）：静态时首条与槽位相接，
              滚动后内容从槽位下方滑过被遮盖 */}
          <div className="h-full overflow-y-auto px-1.5 pb-3 pt-8" onScroll={handleListScroll}>
            {items.length === 0 ? (
              searchQuery.trim() ? (
                <div className="flex flex-col items-center justify-center h-full text-app-text-disabled px-4 text-center">
                  <p className="text-sm">没有匹配「{searchQuery.trim()}」的记录</p>
                </div>
              ) : (
                // 空分类：tab 栏保留在左栏，仅列表区域呈现空态（不整窗替换，否则无法切 tab）
                <EmptyState activeTab={activeTab} />
              )
            ) : (
              // 分组边界只用组间距表达（mt-4），当前日期由固定槽位常驻显示。
              // 不用 position:sticky——透明 WebView2 窗口下 sticky 有合成层
              // 残影/错位怪癖（滚动时日期头与条目错序绘制），静态覆盖层天然免疫
              Object.entries(groupedItems).map(([date, dateItems], groupIndex) => (
                <div key={date} data-group={date} className={groupIndex === 0 ? undefined : 'mt-4'}>
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

          {/* 固定组头槽位：常驻显示当前日期组（滚动时由 handleListScroll 跟踪切换），
              高 32px、文字左缘与条目文字对齐（16px）。
              pointer-events-none 让点击/滚动穿透到列表 */}
          {currentGroup && (
            <div
              className="absolute top-0 inset-x-0 px-4 pt-2.5 pb-1.5 text-xs font-medium text-app-text-tertiary pointer-events-none"
              style={{ background: 'var(--app-panel-bg)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
            >
              {currentGroup}
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

// 空列表空态（渲染在左栏列表区域内，tab 栏保留可切换）
function EmptyState({ activeTab }: { activeTab: TabType }) {
  const messages: Record<TabType, { icon: React.ElementType; title: string; desc: string }> = {
    all: { icon: Filter, title: '暂无剪贴板记录', desc: '复制内容后将自动保存' },
    text: { icon: FileText, title: '暂无文本记录', desc: '复制文本后将显示在这里' },
    image: { icon: ImageIcon, title: '暂无图片记录', desc: '复制图片后将显示在这里' },
    audio: { icon: Music, title: '暂无音频记录', desc: '复制音频文件后将显示在这里' },
    video: { icon: Video, title: '暂无视频记录', desc: '复制视频文件后将显示在这里' },
    file: { icon: Folder, title: '暂无文件记录', desc: '复制文件后将显示在这里' },
    favorite: { icon: Star, title: '暂无收藏', desc: '点击星标收藏常用内容' },
  };

  const { icon: Icon, title, desc } = messages[activeTab];

  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon size={28} className="text-app-text-disabled opacity-60" />
      <p className="text-app-text-secondary font-medium text-sm">{title}</p>
      <p className="text-xs text-app-text-disabled">{desc}</p>
    </div>
  );
}
