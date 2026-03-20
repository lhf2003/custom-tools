import { Search, Command, FileText, Lock, Settings, User, RefreshCw, HardDrive, Braces } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useSearch } from '@/hooks/useSearch';

// Safe invoke that only works in Tauri environment
const safeInvoke = async (cmd: string, args?: Record<string, unknown>) => {
  if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  }
  // In browser, return mock data for development
  console.log(`[Browser Mode] Would invoke: ${cmd}`, args);

  // Mock data for browser development
  if (cmd === 'search_apps') {
    return [
      { name: '剪贴板', path: 'builtin://clipboard' },
      { name: 'Markdown笔记', path: 'builtin://markdown' },
      { name: '密码管理', path: 'builtin://password' },
      { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
      { name: 'Visual Studio Code', path: 'C:\\Users\\user\\AppData\\Local\\Programs\\VSCode\\Code.exe' },
      { name: 'Obsidian', path: 'C:\\Users\\user\\AppData\\Local\\Obsidian\\Obsidian.exe' },
      { name: 'PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      { name: '文件资源管理器', path: 'C:\\Windows\\explorer.exe' },
      { name: '记事本', path: 'C:\\Windows\\notepad.exe' },
      { name: '画图', path: 'C:\\Windows\\System32\\mspaint.exe' },
      { name: '计算器', path: 'C:\\Windows\\System32\\calc.exe' },
      { name: '终端', path: 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' },
    ];
  }
  if (cmd === 'get_recent_apps') {
    return [
      { name: '剪贴板', path: 'builtin://clipboard' },
      { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
      { name: 'Visual Studio Code', path: 'C:\\Users\\user\\AppData\\Local\\Programs\\VSCode\\Code.exe' },
      { name: 'Obsidian', path: 'C:\\Users\\user\\AppData\\Local\\Obsidian\\Obsidian.exe' },
      { name: 'PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      { name: 'Markdown笔记', path: 'builtin://markdown' },
      { name: '密码管理', path: 'builtin://password' },
      { name: '文件资源管理器', path: 'C:\\Windows\\explorer.exe' },
      { name: '记事本', path: 'C:\\Windows\\notepad.exe' },
    ];
  }
  if (cmd === 'extract_app_icon') {
    return null; // No icons in browser mode
  }
  if (cmd === 'resize_window') {
    // In browser mode, just log - no actual window to resize
    return Promise.resolve();
  }
  if (cmd === 'hide_window') {
    // In browser mode, just log - no actual window to hide
    return Promise.resolve();
  }
  if (cmd === 'handle_pasted_file') {
    console.log('[Browser Mode] Would handle pasted file:', args);
    return Promise.resolve();
  }
  if (cmd === 'read_clipboard_image') {
    // In browser mode, return none - browser API can't read screenshot DIB data
    console.log('[Browser Mode] Would read clipboard image from backend');
    return Promise.resolve({ success: false, result_type: 'none', path: null, message: 'Browser mode - use backend API' });
  }
  if (cmd === 'record_app_usage') {
    console.log('[Browser Mode] Would record app usage:', args);
    return Promise.resolve();
  }

  return Promise.resolve();
};

// Built-in tools definition with Lucide icons
const builtInTools = [
  { id: 'clipboard', name: '剪贴板', icon: Command, color: 'bg-blue-500' },
  { id: 'markdown', name: 'Markdown笔记', icon: FileText, color: 'bg-zinc-700' },
  { id: 'password', name: '密码管理', icon: Lock, color: 'bg-amber-500' },
  { id: 'everything', name: '文件搜索', icon: HardDrive, color: 'bg-cyan-600' },
  { id: 'json_formatter', name: 'JSON格式化', icon: Braces, color: 'bg-emerald-600' },
  { id: 'settings', name: '设置', icon: Settings, color: 'bg-zinc-600' },
];

interface AppItemData {
  name: string;
  path: string;
  iconPath?: string;
  isBuiltIn?: boolean;
  toolId?: string;
}

const ITEMS_PER_ROW = 9;

export function LauncherView() {
  const { searchQuery, setSearchQuery, setActiveView, setJsonFormatterData } = useAppStore();
  const { apps, isLoading, searchApps, launchApp, getRecentApps, recordAppUsage } = useSearch();
  const [recentItems, setRecentItems] = useState<AppItemData[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Compute displayed items before using in effects
  const displayedItems = isExpanded ? recentItems : recentItems.slice(0, ITEMS_PER_ROW);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, displayedItems.length]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      searchApps(searchQuery);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery, searchApps]);

  // Set window height based on expanded state
  useEffect(() => {
    const setWindowHeight = async () => {
      try {
        const height = isExpanded ? 600 : 200;
        await safeInvoke('resize_window', { height });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    };

    setWindowHeight();
  }, [isExpanded]);

  // Load recent items (only actually used apps)
  useEffect(() => {
    loadRecentItems();
  }, []);

  // Detect if text is valid, non-trivial JSON (object or array)
  const detectJson = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
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
            console.log('Image saved to clipboard history:', result.path);
            break;
          case 'text':
            // Text is already handled by clipboard watcher
            console.log('Text pasted');
            break;
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

  const loadRecentItems = async () => {
    try {
      // Get recently used apps from database
      const recentApps = await getRecentApps(14);

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
        items = allApps.slice(0, 14).map(app => {
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
        items = builtInTools.map(tool => ({
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
      setRecentItems(builtInTools.map(tool => ({
        name: tool.name,
        path: `builtin://${tool.id}`,
        isBuiltIn: true,
        toolId: tool.id,
      })));
    }
  };

  const handleItemClick = async (item: AppItemData) => {
    // Optimistic update: immediately move clicked item to first position
    setRecentItems(prev => {
      const filtered = prev.filter(i => i.path !== item.path);
      return [item, ...filtered];
    });

    if (item.isBuiltIn && item.toolId) {
      // For built-in tools, switch view and record usage
      setActiveView(item.toolId as any);
      // Record usage in background (built-in tools don't go through launch_app)
      recordAppUsage(item.path, item.name).catch(err => {
        console.error('Failed to record built-in tool usage:', err);
      });
    } else {
      // For external apps, hide window first then launch
      try {
        await safeInvoke('hide_window');
      } catch (err) {
        console.error('Failed to hide window:', err);
      }
      await launchApp(item.path, item.name);
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = searchQuery ? getAllResults() : displayedItems;
    const maxIndex = items.length - 1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + ITEMS_PER_ROW, maxIndex));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - ITEMS_PER_ROW, 0));
        break;
      case 'ArrowRight':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, maxIndex));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (items[selectedIndex]) {
          handleItemClick(items[selectedIndex]);
        }
        break;
    }
  }, [searchQuery, displayedItems, selectedIndex]);

  // Get all results for keyboard navigation during search
  const getAllResults = () => {
    if (!searchQuery) return displayedItems;
    const filteredTools = builtInTools.filter(tool =>
      tool.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    const toolItems: AppItemData[] = filteredTools.map(tool => ({
      name: tool.name,
      path: `builtin://${tool.id}`,
      isBuiltIn: true,
      toolId: tool.id,
    }));
    return [...toolItems, ...apps];
  };

  // Get all results for keyboard navigation during search
  const allResults = searchQuery ? getAllResults() : displayedItems;

  return (
    <div
      className="w-full h-full flex flex-col rounded-2xl overflow-hidden outline-none"
      style={{ backgroundColor: '#333333' }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Search Bar */}
      <div className="w-full flex items-center px-4 py-3">
        <Search className="w-5 h-5 text-zinc-400 mr-3 flex-shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onPaste={handlePaste}
          placeholder="搜索应用和指令 / 粘贴文件或图片..."
          className="flex-1 bg-transparent text-lg text-zinc-200 placeholder-zinc-500 outline-none"
          autoFocus
        />

        {/* Profile Button */}
        <button
          onClick={() => setActiveView('settings')}
          className="ml-3 w-9 h-9 rounded-full bg-zinc-600 flex items-center justify-center overflow-hidden hover:bg-zinc-500 transition-all group flex-shrink-0"
        >
          <User className="w-4 h-4 text-zinc-300 group-hover:text-white transition-colors" />
        </button>
      </div>

      {/* Main Content */}
      <div className="w-full flex-1 px-4 pb-4 overflow-hidden">
        {searchQuery ? (
          <SearchResults
            query={searchQuery}
            apps={apps}
            isLoading={isLoading}
            onLaunch={launchApp}
            isExpanded={isExpanded}
            onToggleExpand={() => setIsExpanded(!isExpanded)}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onItemClick={handleItemClick}
          />
        ) : (
          <section className="h-full flex flex-col">
            {/* Section Header */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-400">最近使用</h2>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors"
              >
                {isExpanded ? '收缩' : `展开 (${recentItems.length})`}
              </button>
            </div>

            {/* App Grid */}
            <div className="grid grid-cols-9 gap-2 overflow-y-auto overflow-x-hidden">
              {displayedItems.map((item, index) => (
                <ItemCard
                  key={item.path}
                  item={item}
                  isSelected={index === selectedIndex}
                  onClick={() => handleItemClick(item)}
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
}: {
  item: AppItemData;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [iconData, setIconData] = useState<string | null>(null);
  const [isLoadingIcon, setIsLoadingIcon] = useState(false);

  // Load icon for external apps
  useEffect(() => {
    if (item.isBuiltIn || iconData || isLoadingIcon) return;

    const loadIcon = async () => {
      setIsLoadingIcon(true);
      try {
        const result = await safeInvoke('extract_app_icon', { path: item.path }) as string | null;
        if (result) {
          setIconData(result);
        }
      } catch (err) {
        console.error('Failed to load icon for', item.name, err);
      } finally {
        setIsLoadingIcon(false);
      }
    };

    loadIcon();
  }, [item.path, item.isBuiltIn, item.name]);

  // Selection styles (removed ring border, kept scale effect)
  const selectedClass = isSelected ? 'scale-105' : '';

  // For built-in tools, use Lucide icon
  if (item.isBuiltIn) {
    const tool = builtInTools.find(t => t.id === item.toolId);
    if (tool) {
      const Icon = tool.icon;
      return (
        <button
          onClick={onClick}
          className={`flex flex-col items-center group py-2 rounded-lg transition-all ${isSelected ? 'bg-white/10' : ''}`}
        >
          <div className={`w-8 h-8 rounded-lg ${tool.color} flex items-center justify-center mb-1.5 group-hover:scale-105 transition-transform ${selectedClass}`}>
            <Icon className="w-4 h-4 text-white" />
          </div>
          <span className={`text-xs w-full text-center group-hover:text-white transition-colors leading-tight ${isSelected ? 'text-blue-400 font-medium' : 'text-zinc-300'}`}>
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
        onClick={onClick}
        className={`flex flex-col items-center group py-2 rounded-lg transition-all ${isSelected ? 'bg-white/10' : ''}`}
      >
        <div className={`w-8 h-8 rounded-lg overflow-hidden mb-1.5 group-hover:scale-105 transition-transform ${selectedClass}`}>
          <img
            src={iconData}
            alt={item.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
        <span className={`text-xs w-full text-center group-hover:text-zinc-200 transition-colors leading-tight ${isSelected ? 'text-white font-medium' : 'text-zinc-400'}`}>
          {item.name}
        </span>
      </button>
    );
  }

  // For external apps without icon yet, use letter icon
  const initial = item.name.charAt(0).toUpperCase();

  // Generate consistent color based on name
  const colors = [
    'bg-red-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-yellow-500',
    'bg-lime-500',
    'bg-green-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-cyan-500',
    'bg-sky-500',
    'bg-blue-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-purple-500',
    'bg-fuchsia-500',
    'bg-pink-500',
    'bg-rose-500',
  ];
  const colorIndex = item.name.length % colors.length;
  const color = colors[colorIndex];

  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center group py-2 rounded-lg transition-all ${isSelected ? 'bg-white/10' : ''}`}
    >
      <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center mb-1.5 group-hover:scale-105 transition-transform ${selectedClass}`}>
        <span className="text-white text-xs font-bold">{initial}</span>
      </div>
      <span className={`text-xs w-full text-center group-hover:text-zinc-200 transition-colors leading-tight ${isSelected ? 'text-white font-medium' : 'text-zinc-400'}`}>
        {item.name}
      </span>
    </button>
  );
}

// Search Results Component
function SearchResults({
  query,
  apps,
  isLoading,
  onLaunch,
  isExpanded,
  onToggleExpand,
  selectedIndex,
  onSelect,
  onItemClick,
}: {
  query: string;
  apps: { name: string; path: string }[];
  isLoading: boolean;
  onLaunch: (path: string, name: string) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onItemClick: (item: AppItemData) => void;
}) {
  // Filter built-in tools based on query
  const filteredTools = builtInTools.filter(tool =>
    tool.name.toLowerCase().includes(query.toLowerCase())
  );

  // Convert built-in tools to AppItemData format
  const toolItems: AppItemData[] = filteredTools.map(tool => ({
    name: tool.name,
    path: `builtin://${tool.id}`,
    isBuiltIn: true,
    toolId: tool.id,
  }));

  // Merge built-in tools with apps (tools first)
  const allResults = [...toolItems, ...apps];

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-zinc-400">
        <RefreshCw className="w-8 h-8 animate-spin mb-4" />
        <p>正在索引程序...</p>
      </div>
    );
  }

  if (allResults.length === 0) {
    return (
      <div className="text-zinc-400 text-center py-12">
        <p>搜索 &quot;{query}&quot;</p>
        <p className="text-sm mt-2 opacity-60">未找到匹配的程序</p>
      </div>
    );
  }

  const displayCount = isExpanded ? allResults.length : 18;
  const showExpandButton = allResults.length > 18;

  return (
    <section className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-400">
          搜索结果 ({allResults.length})
        </h2>
        {showExpandButton && (
          <button
            onClick={onToggleExpand}
            className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors"
          >
            {isExpanded ? '收缩' : `展开 (${allResults.length})`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-9 gap-2 overflow-y-auto overflow-x-hidden">
        {allResults.slice(0, displayCount).map((item, index) => (
          <ItemCard
            key={item.path}
            item={item}
            isSelected={index === selectedIndex}
            onClick={() => onItemClick(item)}
          />
        ))}
      </div>
    </section>
  );
}
