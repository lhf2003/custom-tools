import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from 'react';
import {
  Search,
  Trash2,
  Star,
  Copy,
  Loader2,
  FileText,
  Image,
  Folder,
  ExternalLink,
  X,
  Filter,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Tooltip } from '@/components/Tooltip';
import { THEME } from '../../constants/theme';
import { WINDOW_SIZE } from '../../constants/window';
import { immediateResize } from '../../utils/tauri';
import { imageCache } from './imageCache';

interface ClipboardItemData {
  id: number;
  content: string;
  content_type: string;
  source_app: string | null;
  is_favorite: boolean;
  created_at: string;
}

interface ClipboardQuery {
  content_type?: string;
  is_favorite?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

type TabType = 'all' | 'text' | 'image' | 'file' | 'favorite';

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
  const [previewImage, setPreviewImage] = useState<string | null>(null);
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
      { id: 'image' as TabType, label: '图片', icon: Image },
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
  }, [activeTab, searchQuery]);

  // Listen for clipboard updates from backend
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen('clipboard-updated', () => {
        console.log('Clipboard updated event received, refreshing...');
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

  const handleToggleFavorite = async (id: number) => {
    try {
      await invoke('toggle_clipboard_favorite', { id });
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to toggle favorite:', err);
      setError(`收藏操作失败: ${message}`);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke('delete_clipboard_item', { id });
      imageCache.remove(id);
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to delete clipboard item:', err);
      setError(`删除失败: ${message}`);
    }
  };

  const handleCopyToClipboard = async (id: number) => {
    try {
      await invoke('copy_to_clipboard', { id });
      // 刷新列表以显示更新后的排序
      fetchClipboardHistory(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to copy to clipboard:', err);
      setError(`复制失败: ${message}`);
    }
  };

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

  const handlePreviewImage = async (item: ClipboardItemData) => {
    const cached = imageCache.get(item.id);
    if (cached) {
      setPreviewImage(cached);
      return;
    }

    if (item.content_type === 'image') {
      try {
        const base64 = await invoke<string>('get_clipboard_image_base64', { id: item.id });
        imageCache.set(item.id, base64);
        setPreviewImage(base64);
      } catch (err) {
        console.error('Failed to load image:', err);
      }
    } else if (item.content_type === 'file' && isImageFile(item.content)) {
      try {
        const base64 = await invoke<string>('read_image_file_as_base64', { path: item.content });
        imageCache.set(item.id, base64);
        setPreviewImage(base64);
      } catch (err) {
        console.error('Failed to load image preview:', err);
      }
    }
  };

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
        // Scroll item into view
        itemRefs.current.get(nextId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : flatIds.length - 1;
        const prevId = flatIds[prevIndex];
        setSelectedId(prevId);
        // Scroll item into view
        itemRefs.current.get(prevId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'Enter' && selectedId) {
        e.preventDefault();
        handleCopyToClipboard(selectedId);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [items, groupedItems, selectedId, handleCopyToClipboard]);

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
            // Load more when within 50px of bottom
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

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* Left Sidebar - Tabs */}
      <aside className="w-16 border-r border-app-border flex flex-col items-center py-4 gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Tooltip key={tab.id} content={tab.label} placement="right">
              <button
                onClick={() => setActiveTab(tab.id)}
                className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all duration-200 cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-app-bg-pressed/50 text-app-text-primary'
                    : 'text-app-text-disabled hover:text-app-text-secondary hover:bg-app-bg-elevated/30'
                }`}
              >
                <Icon size={18} />
                <span className="text-[10px]">{tab.label}</span>
              </button>
            </Tooltip>
          );
        })}
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with Search */}
        <div className="w-full flex items-center px-4 py-3 border-b border-app-border-subtle">
          <Search className="w-5 h-5 text-app-text-tertiary mr-3 flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索剪贴板历史..."
            className="flex-1 bg-transparent text-lg text-app-text-primary placeholder-app-text-placeholder outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="ml-3 w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Clipboard List */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-app-text-disabled">
              <Loader2 size={32} className="animate-spin mb-3" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-app-text-disabled">
              <p className="text-app-status-error mb-2">{error}</p>
              <button
                onClick={() => fetchClipboardHistory(false)}
                className="px-4 py-2 rounded-lg bg-app-bg-pressed/50 hover:bg-app-bg-elevated/50 text-sm text-app-text-primary transition-colors cursor-pointer"
              >
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState activeTab={activeTab} />
          ) : (
            <div className="space-y-4">
              {Object.entries(groupedItems).map(([date, dateItems]) => (
                <div key={date}>
                  <h3 className="text-app-text-disabled text-[11px] font-medium mb-1.5 px-1 -mt-2 pt-2 pb-0.5 sticky -top-2 tracking-wide z-10" style={{ backgroundColor: THEME.BG_PRIMARY }}>
                    {date}
                  </h3>
                  <div className="space-y-2">
                    {dateItems.map((item) => (
                      <ClipboardItem
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
                        onToggleFavorite={() => handleToggleFavorite(item.id)}
                        onDelete={() => handleDelete(item.id)}
                        onCopy={() => handleCopyToClipboard(item.id)}
                        onCopyPartial={handleCopyPartialText}
                        onPreview={() => handlePreviewImage(item)}
                        onSelect={() => setSelectedId(item.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {/* Load More Hint */}
              {hasMore && (
                <div className="text-center py-3 text-app-text-disabled text-xs">
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
          )}
        </div>
      </div>

      {/* Image Preview Modal */}
      {previewImage && (
        <ImagePreviewModal
          src={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  );
}

// Empty State Component
function EmptyState({ activeTab }: { activeTab: TabType }) {
  const messages: Record<TabType, { icon: React.ElementType; title: string; desc: string }> = {
    all: { icon: Filter, title: '暂无剪贴板记录', desc: '复制内容后将自动保存' },
    text: { icon: FileText, title: '暂无文本记录', desc: '复制文本后将显示在这里' },
    image: { icon: Image, title: '暂无图片记录', desc: '复制图片后将显示在这里' },
    file: { icon: Folder, title: '暂无文件记录', desc: '复制文件后将显示在这里' },
    favorite: { icon: Star, title: '暂无收藏', desc: '点击星标收藏常用内容' },
  };

  const { icon: Icon, title, desc } = messages[activeTab];

  return (
    <div className="flex flex-col items-center justify-center h-full text-app-text-disabled py-20">
      <div className="w-16 h-16 rounded-2xl bg-app-bg-elevated/30 flex items-center justify-center mb-4">
        <Icon size={32} className="opacity-50" />
      </div>
      <p className="text-app-text-secondary font-medium">{title}</p>
      <p className="text-sm mt-1 text-app-text-disabled">{desc}</p>
    </div>
  );
}

// Clipboard Item Props
interface ClipboardItemProps {
  item: ClipboardItemData;
  isSelected: boolean;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onCopyPartial: (text: string) => void;
  onPreview: () => void;
  onSelect: () => void;
}

// Check if a file path is an image
function isImageFile(path: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];
  const lowerPath = path.toLowerCase();
  return imageExtensions.some(ext => lowerPath.endsWith(ext));
}

// Get type config
function getTypeConfig(type: string, content?: string) {
  // If it's a file type but the content is an image path, treat it as image
  if (type === 'file' && content && isImageFile(content)) {
    return {
      icon: Image,
      color: 'from-purple-500/30 to-pink-500/30',
      bgColor: 'bg-purple-500/10',
      label: '图片',
    };
  }

  switch (type) {
    case 'text':
      return {
        icon: FileText,
        color: 'from-blue-500/30 to-cyan-500/30',
        bgColor: 'bg-blue-500/10',
        label: '文本',
      };
    case 'image':
      return {
        icon: Image,
        color: 'from-purple-500/30 to-pink-500/30',
        bgColor: 'bg-purple-500/10',
        label: '图片',
      };
    case 'file':
      return {
        icon: Folder,
        color: 'from-amber-500/30 to-orange-500/30',
        bgColor: 'bg-amber-500/10',
        label: '文件',
      };
    default:
      return {
        icon: FileText,
        color: 'from-gray-500/30 to-slate-500/30',
        bgColor: 'bg-gray-500/10',
        label: '未知',
      };
  }
}

// Clipboard Item Component
const ClipboardItem = forwardRef<HTMLDivElement, ClipboardItemProps>(function ClipboardItem(
  {
    item,
    isSelected,
    onToggleFavorite,
    onDelete,
    onCopy,
    onCopyPartial,
    onPreview,
    onSelect,
  },
  ref
) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [selectionToolbar, setSelectionToolbar] = useState<{ visible: boolean; x: number; y: number; text: string }>({
    visible: false,
    x: 0,
    y: 0,
    text: '',
  });
  const textRef = useRef<HTMLParagraphElement>(null);

  // Handle text selection
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !textRef.current) {
        setSelectionToolbar(prev => ({ ...prev, visible: false }));
        return;
      }

      // Check if selection is within our text element
      const range = selection.getRangeAt(0);
      if (!textRef.current.contains(range.commonAncestorContainer)) {
        setSelectionToolbar(prev => ({ ...prev, visible: false }));
        return;
      }

      const selectedText = selection.toString().trim();
      if (selectedText.length === 0) {
        setSelectionToolbar(prev => ({ ...prev, visible: false }));
        return;
      }

      // Calculate toolbar position
      const rect = range.getBoundingClientRect();
      const containerRect = textRef.current.getBoundingClientRect();

      // Position above the selection, centered
      const x = rect.left + rect.width / 2 - 40; // 40 is half of toolbar width (~80px)
      const y = rect.top - 45; // 45px above the selection

      setSelectionToolbar({
        visible: true,
        x: x - containerRect.left + textRef.current.offsetLeft,
        y: y - containerRect.top + textRef.current.offsetTop,
        text: selectedText,
      });
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // Hide toolbar on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (textRef.current && !textRef.current.contains(e.target as Node)) {
        setSelectionToolbar(prev => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load image thumbnail for image type or image files, with LRU cache
  useEffect(() => {
    if (item.content_type === 'image') {
      const cached = imageCache.get(item.id);
      if (cached) {
        setThumbnail(cached);
        return;
      }
      invoke<string>('get_clipboard_image_base64', { id: item.id })
        .then((data) => {
          imageCache.set(item.id, data);
          setThumbnail(data);
        })
        .catch((err) => console.error('Failed to load thumbnail:', err));
    } else if (item.content_type === 'file' && isImageFile(item.content)) {
      const cached = imageCache.get(item.id);
      if (cached) {
        setThumbnail(cached);
        return;
      }
      const loadImageFromFile = async () => {
        try {
          const base64 = await invoke<string>('read_image_file_as_base64', { path: item.content });
          imageCache.set(item.id, base64);
          setThumbnail(base64);
        } catch (err) {
          console.error('Failed to load image from file:', err);
        }
      };
      loadImageFromFile();
    }
  }, [item.id, item.content_type, item.content]);

  // Constants for expansion
  const MAX_PREVIEW_CHARS = 150;
  const isLongText = item.content_type === 'text' && item.content.length > MAX_PREVIEW_CHARS;

  // Parse SQLite datetime string (format: "YYYY-MM-DD HH:MM:SS") to Date
  const parseSqliteDate = (dateStr: string): Date => {
    // SQLite returns "YYYY-MM-DD HH:MM:SS", convert to ISO format "YYYY-MM-DDTHH:MM:SSZ"
    if (dateStr.includes(' ')) {
      const [date, time] = dateStr.split(' ');
      return new Date(`${date}T${time}Z`);
    }
    return new Date(dateStr);
  };

  // Custom format time with precise units (minutes, hours, days)
  const formatTime = (dateStr: string) => {
    try {
      const date = parseSqliteDate(dateStr);
      const now = new Date();
      const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

      // Handle negative diff (clock skew) or future dates
      if (diffInSeconds < 0) {
        return '刚刚';
      }

      if (diffInSeconds < 60) {
        return '刚刚';
      } else if (diffInSeconds < 3600) {
        const minutes = Math.floor(diffInSeconds / 60);
        return `${minutes}分钟前`;
      } else if (diffInSeconds < 86400) {
        const hours = Math.floor(diffInSeconds / 3600);
        return `${hours}小时前`;
      } else {
        const days = Math.floor(diffInSeconds / 86400);
        if (days <= 30) {
          return `${days}天前`;
        } else {
          // For older dates, show actual date
          return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
        }
      }
    } catch (e) {
      console.error('[Clipboard Time Error]', { dateStr, error: e });
      return dateStr;
    }
  };

  const config = getTypeConfig(item.content_type, item.content);
  const TypeIcon = config.icon;

  // Check if this is an image (either image type or image file)
  const isImage = item.content_type === 'image' ||
    (item.content_type === 'file' && isImageFile(item.content));

  // Handle click: only select the item
  const handleClick = (e: React.MouseEvent) => {
    // Check if user has selected text - if so, don't interfere
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      // User is selecting text, don't interfere
      return;
    }

    // Just select on click, don't copy
    onSelect();
  };

  // Handle double click: copy to clipboard and auto-paste to previous window
  const handleDoubleClick = async () => {
    try {
      // Use paste_to_clipboard_item which handles:
      // 1. Copy to clipboard
      // 2. Hide window
      // 3. Restore focus to previous window
      // 4. Simulate Ctrl+V (if auto-paste is enabled)
      await invoke('paste_to_clipboard_item', { id: item.id });
    } catch (err) {
      console.error('Failed to paste clipboard item:', err);
      // Fallback to just copying if paste fails
      onCopy();
    }
  };

  // List View
  return (
    <div
      ref={ref}
      className={`rounded-lg p-3 transition-all duration-200 cursor-pointer group ${
        isSelected
          ? 'bg-app-brand-primary/20 hover:bg-app-brand-primary/25'
          : 'bg-app-bg-elevated/30 hover:bg-app-bg-elevated/50'
      }`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <div className="flex items-start gap-3">
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            {isImage ? (
              <div className="flex items-center gap-3">
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt="剪贴板图片"
                    className="h-16 w-auto max-w-[120px] rounded-md object-cover border border-app-border"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview();
                    }}
                  />
                ) : (
                  <div className="h-16 w-20 rounded-md bg-app-bg-elevated/50 flex items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-app-text-disabled" />
                  </div>
                )}
              </div>
            ) : (
              <div className="relative">
                <p
                  ref={textRef}
                  className={`text-app-text-primary text-sm break-all select-text ${isExpanded ? '' : 'line-clamp-2'}`}
                  style={{ userSelect: 'text' }}
                >
                  {isExpanded ? item.content : truncateContent(item.content, MAX_PREVIEW_CHARS)}
                </p>
                {/* Selection Toolbar */}
                {selectionToolbar.visible && (
                  <div
                    className="absolute z-20 flex items-center gap-1 px-2 py-1.5 bg-app-bg-primary rounded-lg shadow-lg border border-app-border animate-in fade-in zoom-in-95 duration-150"
                    style={{
                      left: `${Math.max(0, Math.min(selectionToolbar.x, 200))}px`,
                      top: `${selectionToolbar.y}px`,
                      transform: 'translateX(-50%)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => {
                      e.preventDefault(); // Prevent clearing text selection
                      e.stopPropagation();
                    }}
                  >
                    <span className="text-app-text-tertiary text-xs whitespace-nowrap mr-1">
                      {selectionToolbar.text.length} 字符
                    </span>
                    <button
                      onClick={() => {
                        onCopyPartial(selectionToolbar.text);
                        setSelectionToolbar(prev => ({ ...prev, visible: false }));
                        window.getSelection()?.removeAllRanges();
                      }}
                      className="flex items-center gap-1 px-2 py-1 bg-app-brand-primary/20 hover:bg-app-brand-primary/30 text-app-brand-primary text-xs rounded transition-colors cursor-pointer"
                    >
                      <Copy size={12} />
                      复制选中
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${config.bgColor} text-app-text-tertiary`}>
              {config.label}
            </span>
            <span className="text-app-bg-pressed text-xs">•</span>
            <span className="text-app-text-disabled text-xs">{formatTime(item.created_at)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <ActionButton
              icon={Copy}
              onClick={(e) => {
                e.stopPropagation();
                onCopy();
              }}
              tooltip="复制"
            />
            <ActionButton
              icon={Star}
              active={item.is_favorite}
              activeColor="text-yellow-400"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              fill={item.is_favorite}
              tooltip={item.is_favorite ? '取消收藏' : '收藏'}
            />
            <ActionButton
              icon={Trash2}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              tooltip="删除"
            />
          </div>
          <span className="text-app-text-disabled text-xs">
            {item.content_type === 'text' ? `${item.content.length} 字符` : ''}
          </span>
        </div>
      </div>

      {/* Expand/Collapse Arrow for long text */}
      {isLongText && (
        <div className="flex justify-center mt-2">
          <Tooltip content={isExpanded ? '收起' : '展开'} placement="bottom">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="p-1 rounded-md text-app-text-disabled hover:text-app-text-secondary hover:bg-app-bg-pressed/50 transition-colors cursor-pointer"
            >
              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

// Action Button Component
interface ActionButtonProps {
  icon: React.ElementType;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  activeColor?: string;
  fill?: boolean;
  tooltip?: string;
}

function ActionButton({
  icon: Icon,
  onClick,
  active,
  activeColor = 'text-app-text-primary',
  fill,
  tooltip,
}: ActionButtonProps) {
  const button = (
    <button
      onClick={onClick}
      className={`p-1.5 rounded-md transition-all duration-200 cursor-pointer ${
        active
          ? activeColor
          : 'text-app-text-disabled hover:text-app-text-secondary hover:bg-app-bg-pressed/50'
      }`}
    >
      <Icon size={15} fill={fill ? 'currentColor' : 'none'} />
    </button>
  );

  if (tooltip) {
    return (
      <Tooltip content={tooltip} placement="top">
        {button}
      </Tooltip>
    );
  }

  return button;
}

// Image Preview Modal
interface ImagePreviewModalProps {
  src: string;
  onClose: () => void;
}

function ImagePreviewModal({ src, onClose }: ImagePreviewModalProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
        >
          <X size={20} />
        </button>
        <img
          src={src}
          alt="Preview"
          className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
        />
      </div>
    </div>
  );
}

// Utility function
function truncateContent(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '...';
}
