import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { THEME } from '../../constants/theme';
import { WINDOW_SIZE } from '../../constants/window';
import { debouncedResize } from '../../utils/tauri';

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
}

type TabType = 'all' | 'text' | 'image' | 'file' | 'favorite';

export function ClipboardView() {
  // Resize window when view mounts
  useEffect(() => {
    debouncedResize(WINDOW_SIZE.CLIPBOARD.height);
  }, []);

  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<ClipboardItemData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

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

  const fetchClipboardHistory = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const query: ClipboardQuery = {
        limit: 100,
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
        // We need to fetch file type items and filter for images
        const fileQuery: ClipboardQuery = {
          limit: 100,
          content_type: 'file',
        };
        if (searchQuery.trim()) {
          fileQuery.search = searchQuery.trim();
        }
        const fileResult = await invoke<ClipboardItemData[]>('get_clipboard_history', { query: fileQuery });
        const imageFiles = fileResult.filter(item => isImageFile(item.content));
        // Merge and sort by created_at
        result = [...result, ...imageFiles].sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      }

      setItems(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取剪贴板历史失败');
      console.error('Failed to fetch clipboard history:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, searchQuery]);

  useEffect(() => {
    fetchClipboardHistory();
  }, [fetchClipboardHistory]);

  // Listen for clipboard updates from backend
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen('clipboard-updated', () => {
        console.log('Clipboard updated event received, refreshing...');
        fetchClipboardHistory();
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
      fetchClipboardHistory();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to toggle favorite:', err);
      setError(`收藏操作失败: ${message}`);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke('delete_clipboard_item', { id });
      fetchClipboardHistory();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to delete clipboard item:', err);
      setError(`删除失败: ${message}`);
    }
  };

  const handleCopyToClipboard = async (id: number) => {
    try {
      await invoke('copy_to_clipboard', { id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to copy to clipboard:', err);
      setError(`复制失败: ${message}`);
    }
  };

  const handlePreviewImage = async (item: ClipboardItemData) => {
    if (item.content_type === 'image') {
      try {
        const base64 = await invoke<string>('get_clipboard_image_base64', { id: item.id });
        setPreviewImage(base64);
      } catch (err) {
        console.error('Failed to load image:', err);
      }
    } else if (item.content_type === 'file' && isImageFile(item.content)) {
      // For image files, load via backend to get base64 for preview
      try {
        const base64 = await invoke<string>('read_image_file_as_base64', { path: item.content });
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

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* Left Sidebar - Tabs */}
      <aside className="w-16 border-r border-zinc-600/30 flex flex-col items-center py-4 gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all duration-200 cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-zinc-600/50 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/30'
              }`}
              title={tab.label}
            >
              <Icon size={18} />
              <span className="text-[10px]">{tab.label}</span>
            </button>
          );
        })}
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with Search */}
        <div className="w-full flex items-center px-4 py-3 border-b border-zinc-700/50">
          <Search className="w-5 h-5 text-zinc-400 mr-3 flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索剪贴板历史..."
            className="flex-1 bg-transparent text-lg text-zinc-200 placeholder-zinc-500 outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="ml-3 w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Clipboard List */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
              <Loader2 size={32} className="animate-spin mb-3" />
              <span className="text-sm">加载中...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
              <p className="text-red-400 mb-2">{error}</p>
              <button
                onClick={fetchClipboardHistory}
                className="px-4 py-2 rounded-lg bg-zinc-700/50 hover:bg-zinc-600/50 text-sm text-zinc-200 transition-colors cursor-pointer"
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
                  <h3 className="text-zinc-500 text-[11px] font-medium mb-1.5 px-1 -mt-2 pt-2 pb-0.5 sticky -top-2 tracking-wide z-10" style={{ backgroundColor: THEME.BG_PRIMARY }}>
                    {date}
                  </h3>
                  <div className="space-y-2">
                    {dateItems.map((item) => (
                      <ClipboardItem
                        key={item.id}
                        item={item}
                        isSelected={selectedId === item.id}
                        onToggleFavorite={() => handleToggleFavorite(item.id)}
                        onDelete={() => handleDelete(item.id)}
                        onCopy={() => handleCopyToClipboard(item.id)}
                        onPreview={() => handlePreviewImage(item)}
                        onSelect={() => setSelectedId(item.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
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
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 py-20">
      <div className="w-16 h-16 rounded-2xl bg-zinc-700/30 flex items-center justify-center mb-4">
        <Icon size={32} className="opacity-50" />
      </div>
      <p className="text-zinc-300 font-medium">{title}</p>
      <p className="text-sm mt-1 text-zinc-500">{desc}</p>
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
function ClipboardItem({
  item,
  isSelected,
  onToggleFavorite,
  onDelete,
  onCopy,
  onPreview,
  onSelect,
}: ClipboardItemProps) {
  const [clickTimer, setClickTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  // Cleanup pending click timer on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (clickTimer !== null) {
        clearTimeout(clickTimer);
      }
    };
  }, [clickTimer]);

  // Load image thumbnail for image type or image files
  useEffect(() => {
    if (item.content_type === 'image') {
      invoke<string>('get_clipboard_image_base64', { id: item.id })
        .then(setThumbnail)
        .catch((err) => console.error('Failed to load thumbnail:', err));
    } else if (item.content_type === 'file' && isImageFile(item.content)) {
      // For image files, load via backend to get base64
      const loadImageFromFile = async () => {
        try {
          const base64 = await invoke<string>('read_image_file_as_base64', { path: item.content });
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

  // Handle click: single click for selection and preview/copy
  const handleClick = () => {
    // Always select on click
    onSelect();

    if (clickTimer) {
      clearTimeout(clickTimer);
      setClickTimer(null);
      return;
    }

    const timer = setTimeout(() => {
      if (isImage) {
        onPreview();
      } else {
        onCopy();
      }
      setClickTimer(null);
    }, 200);

    setClickTimer(timer);
  };

  // Handle double click: copy to clipboard and auto-paste to previous window
  const handleDoubleClick = async () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      setClickTimer(null);
    }
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
      className={`rounded-lg p-3 transition-all duration-200 cursor-pointer group ${
        isSelected
          ? 'bg-blue-500/20 hover:bg-blue-500/25'
          : 'bg-zinc-700/30 hover:bg-zinc-700/50'
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
                    className="h-16 w-auto max-w-[120px] rounded-md object-cover border border-zinc-600/50"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview();
                    }}
                  />
                ) : (
                  <div className="h-16 w-20 rounded-md bg-zinc-700/50 flex items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-zinc-500" />
                  </div>
                )}
              </div>
            ) : (
              <p className={`text-zinc-200 text-sm break-all ${isExpanded ? '' : 'line-clamp-2'}`}>
                {isExpanded ? item.content : truncateContent(item.content, MAX_PREVIEW_CHARS)}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${config.bgColor} text-zinc-400`}>
              {config.label}
            </span>
            <span className="text-zinc-600 text-xs">•</span>
            <span className="text-zinc-500 text-xs">{formatTime(item.created_at)}</span>
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
              title="复制"
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
              title={item.is_favorite ? '取消收藏' : '收藏'}
            />
            <ActionButton
              icon={Trash2}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="删除"
            />
          </div>
          <span className="text-zinc-500 text-xs">
            {item.content_type === 'text' ? `${item.content.length} 字符` : ''}
          </span>
        </div>
      </div>

      {/* Expand/Collapse Arrow for long text */}
      {isLongText && (
        <div className="flex justify-center mt-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-600/50 transition-colors cursor-pointer"
            title={isExpanded ? '收起' : '展开'}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      )}
    </div>
  );
}

// Action Button Component
interface ActionButtonProps {
  icon: React.ElementType;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  activeColor?: string;
  fill?: boolean;
  title?: string;
}

function ActionButton({
  icon: Icon,
  onClick,
  active,
  activeColor = 'text-zinc-200',
  fill,
  title,
}: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-md transition-all duration-200 cursor-pointer ${
        active
          ? activeColor
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-600/50'
      }`}
    >
      <Icon size={15} fill={fill ? 'currentColor' : 'none'} />
    </button>
  );
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
