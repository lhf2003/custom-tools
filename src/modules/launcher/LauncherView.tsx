import { Search, User, PenLine } from 'lucide-react';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { useSearch } from '@/hooks/useSearch';
import type { ViewMode } from '@/types';
import { safeInvoke, debouncedResize } from '../../utils/tauri';
import { WINDOW_SIZE } from '../../constants/window';
import { BUILT_IN_TOOLS } from '../../constants/tools';
import { getCachedIcon, setCachedIcon } from './iconCache';

const VIEW_MODES: readonly ViewMode[] = [
  'launcher',
  'clipboard',
  'markdown',
  'password',
  'settings',
  'everything',
  'json_formatter',
  'chat',
] as const;

function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value);
}


interface AppItemData {
  name: string;
  path: string;
  isBuiltIn?: boolean;
  toolId?: string;
}

const ITEMS_PER_ROW = 9;
// 折叠态搜索结果数：192px 窗口物理上只容一整行网格，超出交给「展开」
const SEARCH_COLLAPSED_COUNT = ITEMS_PER_ROW;
// 冷启动填充上限（无任何使用记录时展示索引应用）：取 9 列 × 2 行，
// 避免一次渲染全部索引应用、触发大量图标提取
const RECENT_FALLBACK_COUNT = 18;

// 搜索框 placeholder 轮换：让隐藏能力（记/Ctrl+J/粘贴 JSON）被自然发现
const PLACEHOLDER_HINTS = [
  '搜索应用 / 粘贴 JSON 文本',
  '输入「记 + 内容」快速记下备忘',
  'tab 切换到 AI 视图'
];

export function LauncherView() {
  const { searchQuery, setSearchQuery, setActiveView, setJsonFormatterData } = useAppStore();
  const { addToast } = useToastStore();
  const { apps, searchApps, launchApp, getRecentApps, recordAppUsage, searchError } = useSearch();
  const [recentItems, setRecentItems] = useState<AppItemData[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hintIndex, setHintIndex] = useState(0);

  // placeholder 低频轮换（8s），只在输入为空时可见，不打扰输入过程
  useEffect(() => {
    const timer = setInterval(() => {
      setHintIndex(prev => (prev + 1) % PLACEHOLDER_HINTS.length);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  // Compute displayed items before using in effects
  const displayedItems = isExpanded ? recentItems : recentItems.slice(0, ITEMS_PER_ROW);

  // 合并内置工具与外部应用为结果集（别名参与匹配），渲染与键盘导航共用
  // 排序：最近使用过的应用（recentItems 即按使用排序）> 内置工具 > 其余应用
  const buildResults = useCallback((appItems: AppItemData[]): AppItemData[] => {
    if (!searchQuery) return displayedItems;
    const q = searchQuery.toLowerCase();
    // 单字符查询只做名称匹配：别名在此长度下噪音过大（'a' 会命中 'ai'/'format'/'paste'）
    const filteredTools = BUILT_IN_TOOLS.filter(tool =>
      tool.name.toLowerCase().includes(q) || (q.length >= 2 && tool.aliases?.some(alias => alias.includes(q)))
    );
    const toolItems: AppItemData[] = filteredTools.map(tool => ({
      name: tool.name,
      path: `builtin://${tool.id}`,
      isBuiltIn: true,
      toolId: tool.id,
    }));
    const usageRank = new Map(recentItems.map((item, i) => [item.path, i]));
    const usedApps = appItems
      .filter(a => usageRank.has(a.path))
      .sort((a, b) => (usageRank.get(a.path) ?? 0) - (usageRank.get(b.path) ?? 0));
    const otherApps = appItems.filter(a => !usageRank.has(a.path));
    return [...usedApps, ...toolItems, ...otherApps];
  }, [searchQuery, displayedItems, recentItems]);

  const allResults = useMemo(() => buildResults(apps), [buildResults, apps]);

  // 「记」命令解析：兼容全角空格与连续空格。null = 非备忘模式
  const noteContent = (() => {
    const q = searchQuery.trim();
    if (q === '记') return '';
    const m = q.match(/^记[\s\u3000]+([\s\S]*)$/);
    return m ? m[1].trim() : null;
  })();
  const isNoteMode = noteContent !== null;

  // 键盘导航集合与渲染集合必须一致：折叠态只渲染前 N 条，选中不可越界（防盲启动）
  // 备忘模式无结果网格，导航集合为空
  const navItems = useMemo(() => isNoteMode
    ? []
    : searchQuery && !isExpanded
      ? allResults.slice(0, SEARCH_COLLAPSED_COUNT)
      : allResults,
  [isNoteMode, searchQuery, isExpanded, allResults]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, displayedItems.length]);

  // Clamp selection into the rendered slice (results can shrink asynchronously)
  useEffect(() => {
    setSelectedIndex(prev => {
      const maxIndex = navItems.length - 1;
      return prev > maxIndex ? Math.max(0, maxIndex) : prev;
    });
  }, [navItems.length]);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 方向键导航时间戳：scrollIntoView 会合成 mouseover，短时间内的 hover 选中必须屏蔽
  const lastKeyboardNavRef = useRef(0);

  // 边界溢出聚焦目标：方向键越界时把 DOM 焦点交给设置/展开按钮（选中清空为 -1，
  // Enter 放行默认点击触发按钮），再次按方向键回到网格
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const expandBtnRef = useRef<HTMLButtonElement>(null);

  const focusSettingsButton = useCallback(() => {
    settingsBtnRef.current?.focus();
    setSelectedIndex(-1);
  }, []);

  const focusExpandButton = useCallback(() => {
    expandBtnRef.current?.focus();
    setSelectedIndex(-1);
  }, []);

  // 从外部按钮回网格时，DOM 焦点要还给对应卡片（选中态与焦点必须一致，
  // 否则 Enter 会被选中项拦截，按钮点击无法触发）
  const focusGridItem = useCallback((index: number) => {
    document.getElementById(`launcher-option-${index}`)?.focus();
  }, []);

  // hover 即选中，但方向键导航后的 200ms 内忽略（防 scrollIntoView 合成事件吸回选择）
  const handleHoverSelect = useCallback((index: number) => {
    if (Date.now() - lastKeyboardNavRef.current < 200) return;
    setSelectedIndex(index);
  }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      searchTimerRef.current = null;
      searchApps(searchQuery);
    }, 150);
    searchTimerRef.current = timer;
    return () => clearTimeout(timer);
  }, [searchQuery, searchApps]);

  // Set window height based on expanded state
  useEffect(() => {
    const height = isExpanded ? WINDOW_SIZE.LAUNCHER.expanded : WINDOW_SIZE.LAUNCHER.collapsed;
    debouncedResize(height, WINDOW_SIZE.LAUNCHER.width);
  }, [isExpanded]);

  // 唤起即折叠：与 query 重置一致的"每次唤起全新状态"语义
  useEffect(() => {
    const unlisten = listen('window:shown', () => {
      setIsExpanded(false);
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup window:shown listener (launcher):', err);
      });
    };
  }, []);

  const loadRecentItems = useCallback(async () => {
    try {
      // Get recently used apps from database (no cap: expanded view scrolls)
      const recentApps = await getRecentApps();

      let items: AppItemData[] = [];

      if (recentApps.length > 0) {
        // Use actual recently used apps
        items = recentApps.map(app => {
          const isBuiltIn = app.path.startsWith('builtin://');
          return {
            name: app.name,
            path: app.path,
            isBuiltIn,
            toolId: isBuiltIn ? app.path.replace('builtin://', '') : undefined,
          };
        });
      }

      // If no recent apps, fetch from search
      if (items.length === 0) {
        const allApps = await safeInvoke('search_apps', { query: '' }) as { name: string; path: string }[] || [];
        items = allApps.slice(0, RECENT_FALLBACK_COUNT).map(app => {
          const isBuiltIn = app.path.startsWith('builtin://');
          return {
            name: app.name,
            path: app.path,
            isBuiltIn,
            toolId: isBuiltIn ? app.path.replace('builtin://', '') : undefined,
          };
        });
      }

      // Fallback: if still empty, show built-in tools
      if (items.length === 0) {
        items = BUILT_IN_TOOLS.map(tool => ({
          name: tool.name,
          path: `builtin://${tool.id}`,
          isBuiltIn: true,
          toolId: tool.id,
        }));
      }

      setRecentItems(items);
    } catch (err) {
      console.error('Failed to load recent items:', err);
      // On error, fallback to built-in tools
      setRecentItems(BUILT_IN_TOOLS.map(tool => ({
        name: tool.name,
        path: `builtin://${tool.id}`,
        isBuiltIn: true,
        toolId: tool.id,
      })));
    }
  }, [getRecentApps]);

  // Load recent items (only actually used apps)
  useEffect(() => {
    loadRecentItems();
  }, [loadRecentItems]);

  // Detect if text is valid, non-trivial JSON / JSONC (object or array);
  // jsonc-parser is used so pasted JSON with comments is also recognized,
  // including documents that begin with a comment before the root value.
  const detectJson = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const errors: ParseError[] = [];
    const parsed = parseJsonc(trimmed, errors, { allowTrailingComma: true, disallowComments: false });
    return errors.length === 0 && typeof parsed === 'object' && parsed !== null;
  }, []);

  // Handle paste event for files and images
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    // Read raw text before preventing default to detect JSON
    const rawText = e.clipboardData?.getData('text/plain') ?? '';

    // If the pasted content looks like JSON, open the JSON formatter
    if (detectJson(rawText)) {
      e.preventDefault();
      setJsonFormatterData(rawText);
      setSearchQuery('');
      setActiveView('json_formatter');
      return;
    }

    // 纯文本粘贴：不拦截，放行默认插入行为，让文本进入搜索框
    const hasFiles = e.clipboardData?.types.includes('Files') ?? false;
    if (!hasFiles) return;

    // 文件/图片粘贴：拦截默认行为，走后端处理
    e.preventDefault();

    try {
      // First, try to read clipboard through backend (handles screenshots and DIB format)
      const result = await safeInvoke('read_clipboard_image') as {
        success: boolean;
        result_type: 'file' | 'image' | 'text' | 'none';
        path?: string;
        message?: string;
      };

      if (result.success) {
        switch (result.result_type) {
          case 'file':
            if (result.path) {
              await safeInvoke('handle_pasted_file', { path: result.path });
            }
            break;
          case 'image':
            // 后端已写入剪贴板历史，watcher 会触发界面刷新
            break;
          case 'text':
          case 'none':
            // Backend couldn't read clipboard, try browser API as fallback
            await handleBrowserPaste(e);
            break;
        }
      } else {
        // Backend failed, try browser API
        await handleBrowserPaste(e);
      }
    } catch (err) {
      console.error('Failed to handle paste:', err);
      await handleBrowserPaste(e);
    }
  }, [detectJson, setJsonFormatterData, setSearchQuery, setActiveView]);

  // Browser fallback for file paste (when files are dropped or pasted from file manager)
  const handleBrowserPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Only handle file system files (those with a path)
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && 'path' in file) {
          const filePath = (file as File & { path: string }).path;
          try {
            await safeInvoke('handle_pasted_file', { path: filePath });
          } catch (err) {
            console.error('Failed to handle pasted file:', err);
          }
        }
      }
    }
  };

  const handleItemClick = useCallback(async (item: AppItemData) => {
    // Optimistic update: move item to first position of recent list
    const promoteToRecent = () => {
      setRecentItems(prev => [item, ...prev.filter(i => i.path !== item.path)]);
    };

    if (item.isBuiltIn && item.toolId && isViewMode(item.toolId)) {
      // For built-in tools, switch view and record usage
      promoteToRecent();
      setActiveView(item.toolId);
      // Record usage in background (built-in tools don't go through launch_app)
      recordAppUsage(item.path, item.name).catch(err => {
        console.error('Failed to record built-in tool usage:', err);
      });
      return;
    }

    // For external apps: launch first; only hide the window after success,
    // so a failed launch never leaves the user with a vanished window and no explanation
    try {
      await launchApp(item.path, item.name);
    } catch (err) {
      addToast({
        type: 'error',
        title: `启动「${item.name}」失败`,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    promoteToRecent();
    try {
      await safeInvoke('hide_window');
    } catch (err) {
      console.error('Failed to hide window:', err);
    }
  }, [setActiveView, recordAppUsage, launchApp, addToast]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Esc 分层：有查询先清空（留在启动器），空查询时冒泡给全局处理（返回/隐藏）
    if (e.key === 'Escape' && searchQuery) {
      e.preventDefault();
      e.stopPropagation();
      setSearchQuery('');
      return;
    }

    // 备忘模式无结果网格：左右键放行给输入框移动光标，不做网格导航
    if (isNoteMode && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      return;
    }

    const items = navItems;
    const maxIndex = items.length - 1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        lastKeyboardNavRef.current = Date.now();
        setSelectedIndex(prev => {
          if (prev < 0) {
            // 焦点在设置/展开按钮：回网格第一项，并把 DOM 焦点还给卡片
            focusGridItem(0);
            return 0;
          }
          if (prev + ITEMS_PER_ROW > maxIndex) {
            // 已在最后一行：溢出聚焦「展开」按钮
            focusExpandButton();
            return -1;
          }
          return prev + ITEMS_PER_ROW;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        lastKeyboardNavRef.current = Date.now();
        setSelectedIndex(prev => {
          if (prev < 0) {
            // 焦点在外部按钮：回网格最后一项
            focusGridItem(maxIndex);
            return maxIndex;
          }
          if (prev - ITEMS_PER_ROW < 0) {
            // 已在第一行：溢出聚焦设置按钮
            focusSettingsButton();
            return -1;
          }
          return prev - ITEMS_PER_ROW;
        });
        break;
      case 'ArrowRight':
        e.preventDefault();
        lastKeyboardNavRef.current = Date.now();
        setSelectedIndex(prev => Math.min(prev + 1, maxIndex));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        lastKeyboardNavRef.current = Date.now();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        // 焦点在设置/展开按钮（选中已清空为 -1）：放行默认行为，让按钮点击生效
        if (!isNoteMode && selectedIndex < 0) return;
        e.preventDefault();
        // 「记」命令：暂存意图备忘，不走搜索
        if (isNoteMode) {
          if (noteContent) {
            safeInvoke('create_companion_intent', { text: noteContent })
              .then(() => {
                addToast({
                  type: 'success',
                  title: '已记下',
                  message: noteContent.length > 50 ? `${noteContent.slice(0, 50)}…` : noteContent,
                });
                setSearchQuery('');
              })
              .catch((err: unknown) => {
                addToast({
                  type: 'error',
                  title: '保存备忘失败',
                  message: String(err),
                });
              });
          } else {
            addToast({
              type: 'info',
              title: '记下备忘',
              message: '输入「记 + 内容」，如：记 明天下午交周报',
            });
          }
          return;
        }
        // 防抖窗口内的回车：先冲刷搜索再启动，避免命中陈旧结果
        if (searchQuery && searchTimerRef.current !== null) {
          clearTimeout(searchTimerRef.current);
          searchTimerRef.current = null;
          void (async () => {
            const freshApps = await searchApps(searchQuery);
            const freshItems = buildResults(freshApps);
            // 尽量保持用户刚才看着的选中项：旧选中 path 仍在新鲜结果中则保持之
            const previousPath = items[selectedIndex]?.path;
            const target =
              (previousPath && freshItems.find(i => i.path === previousPath)) ||
              freshItems[Math.min(selectedIndex, freshItems.length - 1)];
            if (target) handleItemClick(target);
          })();
        } else if (items[selectedIndex]) {
          handleItemClick(items[selectedIndex]);
        }
        break;
    }
  }, [searchQuery, navItems, selectedIndex, addToast, setSearchQuery, searchApps, buildResults, handleItemClick, isNoteMode, noteContent, focusSettingsButton, focusExpandButton, focusGridItem]);

  return (
    <div
      className="w-full h-full flex flex-col rounded-lg overflow-hidden outline-none bg-transparent"
      onKeyDown={handleKeyDown}
    >
      {/* Search Bar */}
      <div className="w-full flex items-center px-4 py-3 search-shadow">
        <Search className="w-5 h-5 text-app-text-tertiary mr-3 flex-shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onPaste={handlePaste}
          placeholder={PLACEHOLDER_HINTS[hintIndex]}
          aria-label="搜索应用和指令"
          role="combobox"
          aria-expanded={!isNoteMode}
          aria-controls="launcher-listbox"
          aria-activedescendant={!isNoteMode && navItems.length > 0 && selectedIndex >= 0 ? `launcher-option-${selectedIndex}` : undefined}
          className="flex-1 bg-transparent text-lg text-app-text-primary placeholder-app-text-placeholder outline-none"
          autoFocus
        />

        {/* Profile Button */}
        <button
          ref={settingsBtnRef}
          onClick={() => setActiveView('settings')}
          aria-label="打开设置"
          className="ml-3 w-9 h-9 rounded-full bg-app-bg-elevated flex items-center justify-center overflow-hidden hover:bg-app-bg-pressed transition-all group flex-shrink-0"
        >
          <User className="w-4 h-4 text-app-text-secondary group-hover:text-app-text-primary transition-colors" />
        </button>
      </div>

      {/* Main Content */}
      <div className="w-full flex-1 px-4 pb-4 overflow-hidden">
        {isNoteMode ? (
          <NoteActionPreview content={noteContent} />
        ) : searchQuery ? (
          <SearchResults
            query={searchQuery}
            allResults={allResults}
            visibleResults={navItems}
            isExpanded={isExpanded}
            onToggleExpand={() => setIsExpanded(!isExpanded)}
            expandBtnRef={expandBtnRef}
            selectedIndex={selectedIndex}
            onItemClick={handleItemClick}
            onSelect={handleHoverSelect}
            searchError={searchError}
          />
        ) : (
          <section className="h-full flex flex-col">
            {/* Section Header */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-app-text-tertiary">最近使用</h2>
              {recentItems.length > ITEMS_PER_ROW && (
                <button
                  ref={expandBtnRef}
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="text-xs text-app-text-tertiary cursor-pointer hover:text-app-text-secondary transition-colors"
                >
                  {isExpanded ? '收缩' : `展开 (${recentItems.length})`}
                </button>
              )}
            </div>

            {/* App Grid */}
            <div id="launcher-listbox" className="grid grid-cols-9 gap-2 overflow-y-auto overflow-x-hidden" role="listbox" aria-label="最近使用">
              {displayedItems.map((item, index) => (
                <ItemCard
                  key={item.path}
                  id={`launcher-option-${index}`}
                  item={item}
                  isSelected={index === selectedIndex}
                  onClick={() => handleItemClick(item)}
                  onHover={() => handleHoverSelect(index)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// Item Card Component - handles both built-in tools and external apps
function ItemCard({
  item,
  isSelected,
  onClick,
  onHover,
  id,
}: {
  item: AppItemData;
  isSelected: boolean;
  onClick: () => void;
  onHover?: () => void;
  id?: string;
}) {
  const [iconData, setIconData] = useState<string | null>(() => getCachedIcon(item.path) ?? null);
  // 一次性守卫：每个卡片实例只尝试提取一次图标（null 结果不重试）
  const iconRequestedRef = useRef(false);
  const cardRef = useRef<HTMLButtonElement>(null);

  // 键盘选中项滚动跟随，保证 Enter 作用的对象始终可见
  useEffect(() => {
    if (isSelected) {
      cardRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  // Load icon for external apps (with module-level cache to survive view switches)
  useEffect(() => {
    if (item.isBuiltIn || iconRequestedRef.current) return;
    iconRequestedRef.current = true;

    const cached = getCachedIcon(item.path);
    if (cached !== undefined) {
      if (cached) setIconData(cached);
      return;
    }

    const loadIcon = async () => {
      try {
        const result = await safeInvoke('extract_app_icon', { path: item.path }) as string | null;
        setCachedIcon(item.path, result);
        if (result) {
          setIconData(result);
        }
      } catch (err) {
        console.error('Failed to load icon for', item.name, err);
      }
    };

    loadIcon();
  }, [item.path, item.isBuiltIn, item.name]);

  // 选中态信号统一为白纱底 + 白色加粗文字（list-item-selected 规范），不做缩放；
  // hover 变色只作用于未选中项，避免与选中态颜色分叉（鼠标/键盘选中必须同色）
  // For built-in tools, use Lucide icon
  if (item.isBuiltIn) {
    const tool = BUILT_IN_TOOLS.find(t => t.id === item.toolId);
    if (tool) {
      const Icon = tool.icon;
      return (
        <button
          ref={cardRef}
          id={id}
          onClick={onClick}
          onMouseEnter={onHover}
          role="option"
          aria-selected={isSelected}
          tabIndex={-1}
          className={`flex flex-col items-center group py-2 rounded-lg transition-colors ${isSelected ? 'bg-white/10' : ''}`}
        >
          <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center mb-1.5 group-hover:scale-105 transition-transform">
            <Icon className="w-4 h-4 text-app-text-secondary" />
          </div>
          <span
            title={item.name}
            className={`line-clamp-2 text-xs w-full text-center transition-colors leading-tight ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary group-hover:text-app-text-primary'}`}
          >
            {item.name}
          </span>
        </button>
      );
    }
  }

  // For external apps with loaded icon
  if (iconData) {
    return (
      <button
        ref={cardRef}
        id={id}
        onClick={onClick}
        onMouseEnter={onHover}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        className={`flex flex-col items-center group py-2 rounded-lg transition-colors ${isSelected ? 'bg-white/10' : ''}`}
      >
        <div className="w-8 h-8 rounded-lg overflow-hidden mb-1.5 group-hover:scale-105 transition-transform">
          <img
            src={iconData}
            alt={item.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
        <span
          title={item.name}
          className={`line-clamp-2 text-xs w-full text-center transition-colors leading-tight ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary group-hover:text-app-text-primary'}`}
        >
          {item.name}
        </span>
      </button>
    );
  }

  // For external apps without icon yet, use a quiet zinc letter tile
  // （Zinc Monolith：不引入灰阶以外的表面色，与内置工具图标同一纪律）
  const initial = item.name.charAt(0).toUpperCase();

  return (
    <button
      ref={cardRef}
      id={id}
      onClick={onClick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      className={`flex flex-col items-center group py-2 rounded-lg transition-colors ${isSelected ? 'bg-white/10' : ''}`}
    >
      <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center mb-1.5 group-hover:scale-105 transition-transform">
        <span className="text-app-text-secondary text-xs font-bold">{initial}</span>
      </div>
      <span
        title={item.name}
        className={`line-clamp-2 text-xs w-full text-center transition-colors leading-tight ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary group-hover:text-app-text-primary'}`}
      >
        {item.name}
      </span>
    </button>
  );
}

// Search Results Component
function SearchResults({
  query,
  allResults,
  visibleResults,
  isExpanded,
  onToggleExpand,
  expandBtnRef,
  selectedIndex,
  onItemClick,
  onSelect,
  searchError,
}: {
  query: string;
  allResults: AppItemData[];
  visibleResults: AppItemData[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  expandBtnRef: React.RefObject<HTMLButtonElement>;
  selectedIndex: number;
  onItemClick: (item: AppItemData) => void;
  onSelect: (index: number) => void;
  searchError: string | null;
}) {
  if (allResults.length === 0) {
    // 搜索失败与"未找到"是两种状态，必须分开表达
    if (searchError) {
      return (
        <div className="text-app-text-tertiary text-center py-12">
          <p>搜索失败</p>
          <p className="text-sm mt-2 opacity-60">{searchError}，请修改关键词重试</p>
        </div>
      );
    }
    return (
      <div className="text-app-text-tertiary text-center py-12">
        <p>搜索 &quot;{query}&quot;</p>
        <p className="text-sm mt-2 opacity-60">未找到匹配的程序</p>
      </div>
    );
  }

  const showExpandButton = allResults.length > ITEMS_PER_ROW;

  return (
    <section className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-app-text-tertiary">
          搜索结果 ({allResults.length})
        </h2>
        {showExpandButton && (
          <button
            ref={expandBtnRef}
            onClick={onToggleExpand}
            className="text-xs text-app-text-tertiary cursor-pointer hover:text-app-text-secondary transition-colors"
          >
            {isExpanded ? '收缩' : `展开 (${allResults.length})`}
          </button>
        )}
      </div>
      <div id="launcher-listbox" className="grid grid-cols-9 gap-2 overflow-y-auto overflow-x-hidden" role="listbox" aria-label="搜索结果">
        {visibleResults.map((item, index) => (
          <ItemCard
            key={item.path}
            id={`launcher-option-${index}`}
            item={item}
            isSelected={index === selectedIndex}
            onClick={() => onItemClick(item)}
            onHover={() => onSelect(index)}
          />
        ))}
      </div>
    </section>
  );
}

// 「记」命令的动作预览：替代搜索结果区，让命令的反馈不再伪装成"未找到"
function NoteActionPreview({ content }: { content: string }) {
  return (
    <section className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-white/5">
        <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
          <PenLine className="w-4 h-4 text-app-text-secondary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-app-text-primary truncate">
            {content ? `回车记下：${content}` : '回车记下一条备忘'}
          </p>
          <p className="text-xs text-app-text-tertiary mt-0.5 truncate">
            {content || '输入「记 + 内容」，如：记 明天下午交周报'}
          </p>
        </div>
      </div>
    </section>
  );
}
