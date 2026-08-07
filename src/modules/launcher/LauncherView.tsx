import { Search, User, PenLine, Settings } from 'lucide-react';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSearch } from '@/hooks/useSearch';
import { safeInvoke, debouncedResize } from '../../utils/tauri';
import { WINDOW_SIZE } from '../../constants/window';
import { listLauncherEntries, isLauncherEntryId, entryIdToViewMode } from '@/plugins/launcherEntries';
import { matchTrigger, suggestTriggers, type TriggerSuggestion } from '@/plugins/registry';
import { getCachedIcon, setCachedIcon } from './iconCache';


interface AppItemData {
  name: string;
  path: string;
  isBuiltIn?: boolean;
  toolId?: string;
}

/**
 * 启动器内置入口枚举（插件注册表 + 壳入口）。
 * 注意：必须是动态获取（每次调用重算）——外部插件在运行时合流注册表，
 * 模块级常量会冻结在应用启动时刻，搜不到新装插件。
 */
function getLauncherEntries() {
  return listLauncherEntries();
}

/** 判断 id 是否为内置入口（插件或壳视图），用于 builtin:// 路径打开 */
function isBuiltInEntryId(id: string | undefined): id is string {
  return !!id && isLauncherEntryId(id);
}

const ITEMS_PER_ROW = 9;
// 折叠态条数随视图切换（grid=ITEMS_PER_ROW / list=LIST_COLLAPSED_COUNT），见组件内 collapsedCount
// 列表视图折叠态条数：行高 40px × 7；列表模式窗口默认高 575（listCollapsed），未填满部分留白
const LIST_COLLAPSED_COUNT = 7;
// 冷启动填充上限（无任何使用记录时展示索引应用）：取 9 列 × 2 行，
// 避免一次渲染全部索引应用、触发大量图标提取
const RECENT_FALLBACK_COUNT = 18;

// 搜索框固定提示（不做轮播：稳定文案降低认知噪音，@命令能力靠联想列表自我发现）
const PLACEHOLDER_HINT = '搜索应用 / @命令';

export function LauncherView() {
  const { searchQuery, setSearchQuery, setActiveView } = useAppStore();
  const { addToast } = useToastStore();
  const launcherEntries = getLauncherEntries();
  const { apps, searchApps, launchApp, getRecentApps, recordAppUsage, searchError } = useSearch();
  const [recentItems, setRecentItems] = useState<AppItemData[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 结果排列视图：grid 横向网格（默认）| list 列表（设置页可切）
  const launcherView = useSettingsStore((s) => s.launcher_view);
  const isListView = launcherView === 'list';
  // 折叠态条数与垂直导航步长随视图切换：网格按行跳（9），列表逐项走（1）
  const collapsedCount = isListView ? LIST_COLLAPSED_COUNT : ITEMS_PER_ROW;
  const rowStep = isListView ? 1 : ITEMS_PER_ROW;

  // Compute displayed items before using in effects
  const displayedItems = isExpanded ? recentItems : recentItems.slice(0, collapsedCount);

  // 合并内置工具与外部应用为结果集（别名参与匹配），渲染与键盘导航共用
  // 排序：最近使用过的应用（recentItems 即按使用排序）> 内置工具 > 其余应用
  const buildResults = useCallback((appItems: AppItemData[]): AppItemData[] => {
    if (!searchQuery) return displayedItems;
    const q = searchQuery.toLowerCase();
    // 单字符查询只做名称匹配：别名在此长度下噪音过大（'a' 会命中 'ai'/'format'/'paste'）
    const filteredTools = launcherEntries.filter(tool =>
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
  }, [searchQuery, displayedItems, recentItems, launcherEntries]);

  const allResults = useMemo(() => buildResults(apps), [buildResults, apps]);

  // 「记」命令解析：兼容全角空格与连续空格。null = 非备忘模式
  const noteContent = (() => {
    const q = searchQuery.trim();
    if (q === '记') return '';
    const m = q.match(/^记[\s\u3000]+([\s\S]*)$/);
    return m ? m[1].trim() : null;
  })();
  const isNoteMode = noteContent !== null;

  // Trigger 前缀路由：查询行首命中某插件 trigger 时进入独占态，
  // 结果区只渲染该插件一行，回车以剩余文本为载荷打开（@json xxx / 裸 @json）
  const triggerMatch = !isNoteMode && searchQuery ? matchTrigger(searchQuery.trim()) : null;
  const isTriggerMode = triggerMatch !== null;

  // @ 前缀联想：未完整命中时模糊匹配 trigger 关键词（@ti → @time），
  // 记不起完整名称也能进入插件；优先级低于独占态、高于普通搜索
  const triggerSuggestions = useMemo(
    () => !isNoteMode && !isTriggerMode && searchQuery.trim().startsWith('@')
      ? suggestTriggers(searchQuery.trim())
      : [],
    [isNoteMode, isTriggerMode, searchQuery]
  );
  const isSuggestMode = triggerSuggestions.length > 0;

  // trigger 独占结果：单行 AppItemData（path = builtin://<id>，toolId 复用打开逻辑）
  const triggerResult: AppItemData | null = useMemo(
    () => triggerMatch
      ? { name: triggerMatch.plugin.name, path: `builtin://${triggerMatch.plugin.id}`, isBuiltIn: true, toolId: triggerMatch.plugin.id }
      : null,
    [triggerMatch]
  );

  // 联想候选转 AppItemData（键盘导航集合与渲染集合共用，选中与建议一一对应）
  const suggestResults: AppItemData[] = useMemo(
    () => triggerSuggestions.map((s) => ({
      name: s.plugin.name,
      path: `builtin://${s.plugin.id}`,
      isBuiltIn: true,
      toolId: s.plugin.id,
    })),
    [triggerSuggestions]
  );

  // 键盘导航集合与渲染集合必须一致：折叠态只渲染前 N 条，选中不可越界（防盲启动）
  // 备忘模式无结果网格，导航集合为空；trigger 独占态导航集合只有独占结果
  const navItems = useMemo(() => isNoteMode
    ? []
    : isTriggerMode
      ? (triggerResult ? [triggerResult] : [])
      : isSuggestMode
        ? suggestResults
        : searchQuery && !isExpanded
          ? allResults.slice(0, collapsedCount)
          : allResults,
  [isNoteMode, isTriggerMode, triggerResult, isSuggestMode, suggestResults, searchQuery, isExpanded, allResults, collapsedCount]);

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

  // Set window height based on expanded state and view mode
  useEffect(() => {
    const height = isExpanded
      ? WINDOW_SIZE.LAUNCHER.expanded
      : isListView
        ? WINDOW_SIZE.LAUNCHER.listCollapsed
        : WINDOW_SIZE.LAUNCHER.collapsed;
    debouncedResize(height, WINDOW_SIZE.LAUNCHER.width);
  }, [isExpanded, isListView]);

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
        items = launcherEntries.map(tool => ({
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
      setRecentItems(launcherEntries.map(tool => ({
        name: tool.name,
        path: `builtin://${tool.id}`,
        isBuiltIn: true,
        toolId: tool.id,
      })));
    }
  }, [getRecentApps, launcherEntries]);

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
      setSearchQuery('');
      // 打开插件并投递载荷（与 '@json' trigger 同一通道 openPluginView）
      useAppStore.getState().openPluginView('json_formatter', rawText);
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
  }, [detectJson, setSearchQuery]);

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

    if (item.isBuiltIn && isBuiltInEntryId(item.toolId)) {
      // For built-in tools, switch view and record usage
      promoteToRecent();
      setActiveView(entryIdToViewMode(item.toolId));
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

    // Tab 切换到 AI 视图（聊天页 Shift+Tab 切回）；Shift+Tab 不占用，放行默认
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      setActiveView('chat');
      return;
    }

    // 备忘模式无结果网格、列表视图无横向移动：左右键放行给输入框移动光标，不做网格导航
    if ((isNoteMode || isListView) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
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
          if (prev + rowStep > maxIndex) {
            // 已在最后一行/最后一项：溢出聚焦「展开」按钮
            focusExpandButton();
            return -1;
          }
          return prev + rowStep;
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
          if (prev - rowStep < 0) {
            // 已在第一行/第一项：溢出聚焦设置按钮
            focusSettingsButton();
            return -1;
          }
          return prev - rowStep;
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
        } else if (isSuggestMode && triggerSuggestions[selectedIndex]) {
          // @ 联想：以选中候选的剩余参数为载荷打开（@ti 123 → @time + arg "123"）
          const suggestion = triggerSuggestions[selectedIndex];
          setSearchQuery('');
          useAppStore.getState().openPluginView(suggestion.plugin.id, suggestion.arg || undefined);
          handleItemClick(suggestResults[selectedIndex]);
        } else if (isTriggerMode && triggerMatch && triggerResult) {
          // trigger 独占：以剩余文本为载荷打开插件（裸 @json 载荷 undefined = 空开）
          setSearchQuery('');
          useAppStore.getState().openPluginView(triggerMatch.plugin.id, triggerMatch.arg || undefined);
          handleItemClick(triggerResult);
        } else if (items[selectedIndex]) {
          handleItemClick(items[selectedIndex]);
        }
        break;
    }
  }, [searchQuery, navItems, selectedIndex, setActiveView, addToast, setSearchQuery, searchApps, buildResults, handleItemClick, isNoteMode, noteContent, isTriggerMode, triggerMatch, triggerResult, isSuggestMode, triggerSuggestions, suggestResults, focusSettingsButton, focusExpandButton, focusGridItem, isListView, rowStep]);

  return (
    <div
      className="w-full h-full flex flex-col rounded-lg overflow-hidden outline-none panel-glass"
      onKeyDown={handleKeyDown}
    >
      {/* Search Bar（兼窗口拖拽区；输入框与按钮显式摘除，否则会被拖拽拦截） */}
      <div className="w-full flex items-center px-4 py-3 search-shadow" data-tauri-drag-region>
        <Search className="w-5 h-5 text-app-text-tertiary mr-3 flex-shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onPaste={handlePaste}
          placeholder={PLACEHOLDER_HINT}
          aria-label="搜索应用和指令"
          role="combobox"
          aria-expanded={!isNoteMode}
          aria-controls="launcher-listbox"
          aria-activedescendant={!isNoteMode && navItems.length > 0 && selectedIndex >= 0 ? `launcher-option-${selectedIndex}` : undefined}
          className="flex-1 bg-transparent text-lg text-app-text-primary placeholder-app-text-placeholder outline-none"
          data-tauri-drag-region={undefined}
          autoFocus
        />

        {/* Profile Button */}
        <button
          ref={settingsBtnRef}
          onClick={() => setActiveView('settings')}
          aria-label="打开设置"
          className="ml-3 w-9 h-9 rounded-full bg-app-bg-elevated flex items-center justify-center overflow-hidden hover:bg-app-bg-pressed transition-all group flex-shrink-0"
          data-tauri-drag-region={undefined}
        >
          <User className="w-4 h-4 text-app-text-secondary group-hover:text-app-text-primary transition-colors" />
        </button>
      </div>

      {/* Main Content */}
      <div className="w-full flex-1 px-4 pb-4 overflow-hidden">
        {isNoteMode ? (
          <NoteActionPreview content={noteContent} />
        ) : isSuggestMode ? (
          <TriggerSuggestList
            suggestions={triggerSuggestions}
            selectedIndex={selectedIndex}
            onSelect={handleHoverSelect}
            onOpen={(suggestion, index) => {
              setSearchQuery('');
              useAppStore.getState().openPluginView(suggestion.plugin.id, suggestion.arg || undefined);
              handleItemClick(suggestResults[index]);
            }}
          />
        ) : isTriggerMode && triggerResult ? (
          <TriggerResultCard
            result={triggerResult}
            arg={triggerMatch?.arg ?? ''}
            argHint={triggerMatch?.trigger.argHint}
            isSelected={selectedIndex === 0}
            onClick={() => {
              setSearchQuery('');
              useAppStore.getState().openPluginView(triggerMatch!.plugin.id, triggerMatch!.arg || undefined);
              handleItemClick(triggerResult);
            }}
          />
        ) : searchQuery ? (
          <SearchResults
            query={searchQuery}
            allResults={allResults}
            visibleResults={navItems}
            isExpanded={isExpanded}
            isListView={isListView}
            collapsedCount={collapsedCount}
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
              {recentItems.length > collapsedCount && (
                <button
                  ref={expandBtnRef}
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="text-xs text-app-text-tertiary cursor-pointer hover:text-app-text-secondary transition-colors"
                >
                  {isExpanded ? '收缩' : `展开 (${recentItems.length})`}
                </button>
              )}
            </div>

            {/* App Grid / List */}
            <div
              id="launcher-listbox"
              className={`overflow-y-auto overflow-x-hidden ${isListView ? 'flex flex-col gap-0.5' : 'grid grid-cols-9 gap-2'}`}
              role="listbox"
              aria-label="最近使用"
            >
              {displayedItems.map((item, index) => (
                isListView ? (
                  <ItemRow
                    key={item.path}
                    id={`launcher-option-${index}`}
                    item={item}
                    isSelected={index === selectedIndex}
                    onClick={() => handleItemClick(item)}
                    onHover={() => handleHoverSelect(index)}
                  />
                ) : (
                  <ItemCard
                    key={item.path}
                    id={`launcher-option-${index}`}
                    item={item}
                    isSelected={index === selectedIndex}
                    onClick={() => handleItemClick(item)}
                    onHover={() => handleHoverSelect(index)}
                  />
                )
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// Item Icon：内置工具 Lucide / 系统功能设置图标 / 外部应用提取图标 / 字母兜底，
// 自带一次性提取守卫与模块级缓存；网格卡片（ItemCard）与列表行（ItemRow）共用
function ItemIcon({ item, className = '' }: { item: AppItemData; className?: string }) {
  const [iconData, setIconData] = useState<string | null>(() => getCachedIcon(item.path) ?? null);
  // 一次性守卫：每个图标实例只尝试提取一次（null 结果不重试）
  const iconRequestedRef = useRef(false);

  // Load icon for external apps (with module-level cache to survive view switches)
  useEffect(() => {
    if (item.isBuiltIn || item.path.startsWith('ms-settings:') || iconRequestedRef.current) return;
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

  const tileCls = `w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform ${className}`;

  // 内置工具：Lucide 图标
  if (item.isBuiltIn) {
    const tool = getLauncherEntries().find(t => t.id === item.toolId);
    if (tool) {
      const Icon = tool.icon;
      return (
        <div className={`${tileCls} bg-app-bg-elevated`}>
          <Icon className="w-4 h-4 text-app-text-secondary" />
        </div>
      );
    }
  }

  // Windows 系统功能（ms-settings: URI）：统一设置图标，同一视觉纪律
  if (item.path.startsWith('ms-settings:')) {
    return (
      <div className={`${tileCls} bg-app-bg-elevated`}>
        <Settings className="w-4 h-4 text-app-text-secondary" />
      </div>
    );
  }

  // 外部应用：已提取的图标
  if (iconData) {
    return (
      <div className={`w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 group-hover:scale-105 transition-transform ${className}`}>
        <img
          src={iconData}
          alt={item.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
    );
  }

  // 无图标兜底：quiet zinc 字母 tile（Zinc Monolith：不引入灰阶以外的表面色）
  return (
    <div className={`${tileCls} bg-app-bg-elevated`}>
      <span className="text-app-text-secondary text-xs font-bold">{item.name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

// Item Card Component - 网格视图的纵向卡片（图标上、名称下）
// 选中态信号统一为白纱底 + 白色加粗文字（list-item-selected 规范），不做缩放；
// hover 变色只作用于未选中项，避免与选中态颜色分叉（鼠标/键盘选中必须同色）
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
  const cardRef = useRef<HTMLButtonElement>(null);

  // 键盘选中项滚动跟随，保证 Enter 作用的对象始终可见
  useEffect(() => {
    if (isSelected) {
      cardRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

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
      <ItemIcon item={item} className="mb-1.5" />
      <span
        title={item.name}
        className={`line-clamp-2 text-xs w-full text-center transition-colors leading-tight ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary group-hover:text-app-text-primary'}`}
      >
        {item.name}
      </span>
    </button>
  );
}

// Item Row Component - 列表视图的横向行（图标左、名称中、选中回车提示右），选中语言与网格一致
function ItemRow({
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
  const rowRef = useRef<HTMLButtonElement>(null);

  // 键盘选中项滚动跟随，保证 Enter 作用的对象始终可见
  useEffect(() => {
    if (isSelected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <button
      ref={rowRef}
      id={id}
      onClick={onClick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group text-left ${isSelected ? 'bg-white/10' : ''}`}
    >
      <ItemIcon item={item} />
      <span
        title={item.name}
        className={`flex-1 min-w-0 truncate text-sm transition-colors ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-tertiary group-hover:text-app-text-primary'}`}
      >
        {item.name}
      </span>
      {isSelected && (
        <span className="text-xs text-app-text-tertiary flex-shrink-0">↵ 打开</span>
      )}
    </button>
  );
}

// Search Results Component
function SearchResults({
  query,
  allResults,
  visibleResults,
  isExpanded,
  isListView,
  collapsedCount,
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
  isListView: boolean;
  collapsedCount: number;
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

  const showExpandButton = allResults.length > collapsedCount;

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
      <div
        id="launcher-listbox"
        className={`overflow-y-auto overflow-x-hidden ${isListView ? 'flex flex-col gap-0.5' : 'grid grid-cols-9 gap-2'}`}
        role="listbox"
        aria-label="搜索结果"
      >
        {visibleResults.map((item, index) => (
          isListView ? (
            <ItemRow
              key={item.path}
              id={`launcher-option-${index}`}
              item={item}
              isSelected={index === selectedIndex}
              onClick={() => onItemClick(item)}
              onHover={() => onSelect(index)}
            />
          ) : (
            <ItemCard
              key={item.path}
              id={`launcher-option-${index}`}
              item={item}
              isSelected={index === selectedIndex}
              onClick={() => onItemClick(item)}
              onHover={() => onSelect(index)}
            />
          )
        ))}
      </div>
    </section>
  );
}

// @ 前缀联想列表：未完整命中 trigger 时的模糊候选（@ti → @time），
// 每行展示插件名 + 关键词 + 说明；回车/点击以剩余参数打开
function TriggerSuggestList({
  suggestions,
  selectedIndex,
  onSelect,
  onOpen,
}: {
  suggestions: TriggerSuggestion[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpen: (suggestion: TriggerSuggestion, index: number) => void;
}) {
  return (
    <section className="h-full flex flex-col">
      {suggestions.map((s, index) => {
        const Icon = s.plugin.icon;
        return (
          <div
            key={`${s.plugin.id}:${s.keyword}`}
            id={`launcher-option-${index}`}
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => onOpen(s, index)}
            onMouseMove={() => onSelect(index)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
              index === selectedIndex ? 'bg-white/10' : 'hover:bg-white/5'
            }`}
          >
            {Icon && (
              <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-app-text-secondary" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-app-text-primary truncate">
                {s.plugin.name}
                <span className="text-app-text-tertiary ml-1.5 font-mono text-xs">{s.keyword}</span>
              </p>
              <p className="text-xs text-app-text-tertiary mt-0.5 truncate">
                {s.plugin.description ?? s.trigger.argHint ?? '回车打开插件'}
              </p>
            </div>
            {s.arg && <span className="text-xs text-app-text-tertiary flex-shrink-0">{s.arg}</span>}
          </div>
        );
      })}
    </section>
  );
}

// Trigger 前缀路由的独占结果行：命中 @json 等插件 trigger 时的反馈
function TriggerResultCard({
  result,
  arg,
  argHint,
  isSelected,
  onClick,
}: {
  result: AppItemData;
  arg: string;
  argHint?: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const entry = getLauncherEntries().find((t) => t.id === result.toolId);
  const Icon = entry?.icon;
  return (
    <section className="h-full flex flex-col">
      <div
        role="option"
        aria-selected={isSelected}
        onClick={onClick}
        className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-colors cursor-pointer ${
          isSelected ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
      >
        {Icon && (
          <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4 text-app-text-secondary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-app-text-primary truncate">
            回车打开 {result.name}
            {arg ? (
              <span className="text-app-text-tertiary"> — {arg}</span>
            ) : (
              argHint && <span className="text-app-text-tertiary"> — {argHint}</span>
            )}
          </p>
          <p className="text-xs text-app-text-tertiary mt-0.5 truncate">
            {arg
              ? `将 ${argHint ?? '输入内容'} 发送给 ${result.name}`
              : argHint
                ? `输入内容作为 ${argHint}，如 ${result.name} 会直接处理`
                : `回车打开 ${result.name}`}
          </p>
        </div>
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
