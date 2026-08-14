import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Search, FileText, Folder, HardDrive, ExternalLink, ChevronDown, RefreshCw, Power, Clock } from 'lucide-react';
import { safeInvoke, immediateResize } from '@/utils/tauri';
import { THEME } from '../../constants/theme';
import { WINDOW_SIZE } from '../../constants/window';

type EverythingStatus = 'available' | 'not_installed' | 'service_not_running' | null;

interface FileResult {
  name: string;
  path: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

interface FrequentFile {
  path: string;
  name: string;
  open_count: number;
  last_opened: number | null;
}

type FileCategory = 'all' | 'folder' | 'excel' | 'word' | 'ppt' | 'pdf' | 'image' | 'video' | 'audio' | 'archive';

interface Category {
  id: FileCategory;
  name: string;
  ext: string[];
}

const categories: Category[] = [
  { id: 'all', name: '全部', ext: [] },
  { id: 'folder', name: '文件夹', ext: ['folder'] },
  { id: 'excel', name: 'EXCEL', ext: ['xls', 'xlsx', 'csv'] },
  { id: 'word', name: 'WORD', ext: ['doc', 'docx'] },
  { id: 'ppt', name: 'PPT', ext: ['ppt', 'pptx'] },
  { id: 'pdf', name: 'PDF', ext: ['pdf'] },
  { id: 'image', name: '图片', ext: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'] },
  { id: 'video', name: '视频', ext: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'] },
  { id: 'audio', name: '音频', ext: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'] },
  { id: 'archive', name: '压缩文件', ext: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'] },
];

interface InstallOption {
  key: 'client' | 'es';
  label: string;
  description: string;
}

const INSTALL_OPTIONS: InstallOption[] = [
  {
    key: 'client',
    label: 'Everything 客户端',
    description: '文件索引服务，搜索功能必须依赖此服务运行',
  },
  {
    key: 'es',
    label: 'es.exe 命令行工具',
    description: '本应用通过此工具与 Everything 服务通信',
  },
];

function EverythingInstallPage({ onInstalled }: { onInstalled: () => void }) {
  const [selected, setSelected] = useState<Record<'client' | 'es', boolean>>({
    client: true,
    es: true,
  });
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isWebsiteHovered, setIsWebsiteHovered] = useState(false);

  const handleInstall = async () => {
    setIsInstalling(true);
    setInstallError(null);
    try {
      await safeInvoke('install_everything', {
        installClient: selected.client,
        installEs: selected.es,
      });
      // Wait briefly for Everything service to start before re-checking
      await new Promise((r) => setTimeout(r, 1500));
      onInstalled();
    } catch {
      setInstallError('下载失败，请点击下方官方链接手动下载');
    } finally {
      setIsInstalling(false);
    }
  };

  const handleOpenWebsite = async () => {
    try {
      await safeInvoke('open_external_url', { url: 'https://www.voidtools.com/zh-cn/downloads/' });
    } catch (err) {
      console.error('Failed to open website:', err);
    }
  };

  const noneSelected = !selected.client && !selected.es;

  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center panel-glass">
      <HardDrive className="w-14 h-14 text-zinc-600 mb-4" />
      <h2 className="text-lg font-semibold text-zinc-300 mb-1">Everything 未安装</h2>
      <p className="text-sm text-zinc-500 max-w-sm mb-6">
        此功能需要 Everything 文件搜索工具支持
        <br />
        <span className="text-zinc-600 text-xs">将安装至：当前应用安装目录 / Everything</span>
      </p>

      {/* Install options */}
      <div className="w-full max-w-sm space-y-2 mb-6">
        {INSTALL_OPTIONS.map((opt) => (
          <label
            key={opt.key}
            className="flex items-start gap-3 p-3 rounded-lg border border-white/5 cursor-pointer hover:border-blue-500/30 transition-colors"
            style={{ backgroundColor: THEME.BG_TERTIARY }}
          >
            <input
              type="checkbox"
              checked={selected[opt.key]}
              onChange={(e) => setSelected((s) => ({ ...s, [opt.key]: e.target.checked }))}
              className="mt-0.5 accent-app-brand-primary"
            />
            <div className="text-left">
              <p className="text-sm font-medium text-zinc-200">{opt.label}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{opt.description}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Error message */}
      {installError && (
        <p className="text-xs text-red-400 mb-4">{installError}</p>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleInstall}
          disabled={noneSelected || isInstalling}
          className="flex items-center gap-2 px-5 py-2.5 bg-app-status-info hover:bg-app-status-info-deep disabled:bg-zinc-600 disabled:cursor-not-allowed rounded-lg text-white text-sm font-medium transition-colors"
        >
          {isInstalling ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>安装中...</span>
            </>
          ) : (
            <span>一键安装</span>
          )}
        </button>
        <button
          onClick={handleOpenWebsite}
          className="flex items-center gap-2 px-5 py-2.5 text-zinc-400 border border-white/10 rounded-lg text-sm transition-colors"
          style={{ backgroundColor: isWebsiteHovered ? THEME.BTN_BG : THEME.BG_TERTIARY }}
          onMouseEnter={() => setIsWebsiteHovered(true)}
          onMouseLeave={() => setIsWebsiteHovered(false)}
        >
          <ExternalLink className="w-4 h-4" />
          <span>官网</span>
        </button>
      </div>

    </div>
  );
}

// 模块级缓存：初始空查询结果，跨组件重挂载存活；进入即渲染，后台静默重搜（消灭「搜索中...」闪帧）
let cachedInitialFiles: FileResult[] | null = null;

// 高亮 query 的第一个关键词（Everything 为子串匹配，命中词即文件名子串）。
function highlightText(text: string, query: string): ReactNode {
  const term = query.trim().split(/\s+/)[0];
  if (!term) return text;
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let j: number;
  while ((j = lower.indexOf(t, i)) !== -1) {
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={j} className="bg-yellow-400/40 text-inherit rounded-sm px-0.5">
        {text.slice(j, j + t.length)}
      </mark>
    );
    i = j + t.length;
  }
  if (i === 0) return text;
  out.push(text.slice(i));
  return out;
}

export function EverythingView() {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileResult[]>(cachedInitialFiles ?? []);
  const [isLoading, setIsLoading] = useState(false);
  const [everythingStatus, setEverythingStatus] = useState<EverythingStatus>(null);
  const [selectedCategory, setSelectedCategory] = useState<FileCategory>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sortBy, setSortBy] = useState<'modified' | 'size' | 'name'>('modified');
  const [sortDesc, setSortDesc] = useState(true);
  const [frequentFiles, setFrequentFiles] = useState<FrequentFile[]>([]);
  const [isOpenFolderHovered, setIsOpenFolderHovered] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Check Everything availability (also called on retry)
  const checkEverything = useCallback(async () => {
    setEverythingStatus(null);
    try {
      const status = await safeInvoke('is_everything_available') as EverythingStatus;
      setEverythingStatus(status ?? 'not_installed');
    } catch {
      setEverythingStatus('not_installed');
    }
  }, []);

  // 加载常用文件（空查询时展示，独立于 Everything 可用性）
  const loadFrequentFiles = useCallback(async () => {
    const data = await safeInvoke<FrequentFile[]>('get_frequent_files', { limit: 10 });
    setFrequentFiles(data ?? []);
  }, []);

  useEffect(() => {
    checkEverything();
    loadFrequentFiles();
  }, [checkEverything, loadFrequentFiles]);

  // Resize window when view mounts
  useEffect(() => {
    immediateResize(WINDOW_SIZE.EVERYTHING.height, WINDOW_SIZE.EVERYTHING.width);
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Search files
  const searchFiles = useCallback(async (searchQuery: string, category: FileCategory, silent = false) => {
    if (everythingStatus !== 'available') {
      return;
    }

    if (!silent) setIsLoading(true);

    try {
      // Build query with category filter
      let finalQuery = searchQuery.trim();
      const cat = categories.find(c => c.id === category);

      if (category !== 'all' && cat && cat.ext.length > 0) {
        if (category === 'folder') {
          finalQuery = finalQuery ? `folder: ${finalQuery}` : 'folder:';
        } else {
          // Everything CLI: ext: uses semicolon ; for OR (ext:xls;xlsx means xls OR xlsx)
          const extFilter = `ext:${cat.ext.join(';')}`;
          if (finalQuery) {
            finalQuery = `${finalQuery} ${extFilter}`;
          } else {
            finalQuery = extFilter;
          }
        }
      }

      const results = await safeInvoke('search_everything', {
        query: finalQuery,
        limit: 100
      }) as FileResult[];
      setFiles(results || []);
      // 仅初始态（空查询 + 全部分类）写缓存（搜索/筛选态不污染缓存）
      if (!searchQuery.trim() && category === 'all') {
        cachedInitialFiles = results || [];
      }
      setSelectedIndex(0);
    } catch (err) {
      console.error('Search failed:', err);
      setFiles([]);
      setSelectedIndex(0);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [everythingStatus]);

  // Debounced search（挂载首跑且有缓存时静默重搜，不闪「搜索中...」；之后输入/筛选照常带 loading）
  const firstRunRef = useRef(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      const silent = firstRunRef.current && cachedInitialFiles !== null;
      firstRunRef.current = false;
      searchFiles(query, selectedCategory, silent);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, selectedCategory, searchFiles]);

  // Sorted files
  const sortedFiles = useMemo(() => {
    const sorted = [...files];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'modified':
          cmp = a.modified - b.modified;
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [files, sortBy, sortDesc]);

  const selectedFile = selectedIndex >= 0 && selectedIndex < sortedFiles.length
    ? sortedFiles[selectedIndex]
    : null;

  const handleOpenFile = async (path: string) => {
    try {
      await safeInvoke('open_file', { path });
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  const handleOpenFolder = async (path: string) => {
    try {
      const folderPath = path.substring(0, path.lastIndexOf('\\')) || path;
      await safeInvoke('open_file', { path: folderPath });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  // 排序字段循环：modified → size → name；切换时重置为直觉方向（时间/大小降序，名称升序）
  const cycleSort = () => {
    if (sortBy === 'modified') {
      setSortBy('size'); setSortDesc(true);
    } else if (sortBy === 'size') {
      setSortBy('name'); setSortDesc(false);
    } else {
      setSortBy('modified'); setSortDesc(true);
    }
  };

  const sortLabel = sortBy === 'modified' ? '按修改时间' : sortBy === 'size' ? '按大小' : '按名称';

  // 键盘导航：方向键移动选中、回车打开、Esc 清空
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, sortedFiles.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedFile) handleOpenFile(selectedFile.path);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  // 选中项变化时滚动到可视区域
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  };

  // Format time
  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // Render a generic file type icon badge with a given color and label
  const renderFileIcon = (color: string, label: string) => (
    <div
      className="w-10 h-10 rounded flex items-center justify-center"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
    >
      <span className="text-xs font-bold" style={{ color }}>{label}</span>
    </div>
  );

  // Map category id to icon color（CSS 变量，浅色主题自动换深档，见 index.css --cat-*）
  const CATEGORY_ICON_COLOR: Partial<Record<FileCategory, string>> = {
    image:   'var(--cat-purple)',
    video:   'var(--cat-red)',
    audio:   'var(--cat-pink)',
    archive: 'var(--cat-yellow)',
    excel:   'var(--cat-green)',
    word:    'var(--cat-blue)',
    ppt:     'var(--cat-orange)',
    pdf:     'var(--cat-red)',
  };

  // Get file icon component
  const getFileIcon = (filename: string, isDir?: boolean) => {
    if (isDir) return <Folder className="w-10 h-10 text-blue-400" />;

    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    const matchedCategory = categories.find(
      (cat) => cat.id !== 'all' && cat.id !== 'folder' && cat.ext.includes(ext)
    );

    if (matchedCategory) {
      const color = CATEGORY_ICON_COLOR[matchedCategory.id] ?? 'var(--cat-slate)';
      const label = matchedCategory.id === 'pdf' ? 'PDF' : ext.toUpperCase();
      return renderFileIcon(color, label);
    }

    return <FileText className="w-10 h-10 text-zinc-400" />;
  };

  if (everythingStatus === null) {
    return (
      <div className="w-full h-full flex items-center justify-center text-zinc-500 panel-glass">
        <div className="animate-pulse">正在检查 Everything...</div>
      </div>
    );
  }

  if (everythingStatus === 'not_installed') {
    return <EverythingInstallPage onInstalled={checkEverything} />;
  }

  if (everythingStatus === 'service_not_running') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center panel-glass">
        <Power className="w-16 h-16 text-yellow-600 mb-4" />
        <h2 className="text-lg font-semibold text-zinc-300 mb-2">Everything 服务未运行</h2>
        <p className="text-sm text-zinc-500 max-w-md mb-6">
          检测到服务未启动。请打开 Everything 应用程序后重试。
        </p>
        <button
          onClick={checkEverything}
          className="flex items-center gap-2 px-6 py-3 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 border border-yellow-500/30 rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          <span>重新检测</span>
        </button>
      </div>
    );
  }

  // 常用文件仅在空查询 + 全部分类时展示
  const showFrequent = !query.trim() && selectedCategory === 'all' && frequentFiles.length > 0;

  const currentCategoryName = categories.find(c => c.id === selectedCategory)?.name ?? '全部';

  return (
    <div className="w-full h-full flex flex-col panel-glass">
      {/* Search Bar */}
      <div className="relative flex items-center px-4 py-3 border-b border-white/5">
        <Search className="w-4 h-4 text-app-text-tertiary mr-3" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索文件...（↑↓ 选择 · 回车/双击打开 · Esc 清空）"
          className="flex-1 bg-transparent text-base text-app-text-primary placeholder-app-text-placeholder outline-none"
        />
        {/* 分类选择（原左侧栏，移到输入框右侧） */}
        <button
          onClick={() => setCategoryOpen((o) => !o)}
          className="ml-3 shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-sm text-app-text-secondary hover:bg-white/5 transition-colors"
        >
          <span>{currentCategoryName}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${categoryOpen ? 'rotate-180' : ''}`} />
        </button>
        {categoryOpen && (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-label="关闭分类菜单"
              className="fixed inset-0 z-10 w-full h-full cursor-default bg-transparent border-0 p-0 outline-none"
              onClick={() => setCategoryOpen(false)}
            />
            <div className="absolute right-4 top-full mt-1 z-20 w-40 py-1 rounded-lg border border-white/10 bg-app-bg-elevated shadow-xl max-h-72 overflow-y-auto">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => { setSelectedCategory(cat.id); setCategoryOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                    selectedCategory === cat.id
                      ? 'text-app-brand-primary-light bg-white/10'
                      : 'text-app-text-secondary hover:bg-white/5'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Main Content - Three Column Layout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Middle - File List */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* File List Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 text-xs text-zinc-500">
            <span>共 {files.length} 条结果</span>
            <div className="flex items-center gap-1">
              <button
                onClick={cycleSort}
                className="hover:text-zinc-300 transition-colors"
                title="点击切换排序字段"
              >
                {sortLabel}
              </button>
              <button
                onClick={() => setSortDesc(!sortDesc)}
                className="flex items-center gap-0.5 hover:text-zinc-300 transition-colors"
                title="切换升/降序"
              >
                <ChevronDown className={`w-3 h-3 transition-transform ${sortDesc ? '' : 'rotate-180'}`} />
              </button>
            </div>
          </div>

          {/* File Items */}
          <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-zinc-500">
                <div className="animate-pulse">搜索中...</div>
              </div>
            ) : sortedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                <Search className="w-12 h-12 mb-3 opacity-30" />
                <p className="text-sm">未找到匹配的文件</p>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {/* 常用文件（空查询 + 全部分类时置顶展示） */}
                {showFrequent && (
                  <>
                    <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-xs text-app-text-tertiary">
                      <Clock className="w-3.5 h-3.5" />
                      <span>常用文件</span>
                    </div>
                    {frequentFiles.map((f) => (
                      <button
                        key={`freq-${f.path}`}
                        onClick={() => handleOpenFile(f.path)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-white/5"
                        title="打开文件"
                      >
                        {getFileIcon(f.name)}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate text-app-text-primary">{f.name}</p>
                          <p className="text-xs text-app-text-tertiary truncate">{f.path}</p>
                        </div>
                      </button>
                    ))}
                    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs text-app-text-tertiary">
                      <span>全部结果</span>
                    </div>
                  </>
                )}
                {sortedFiles.map((file, index) => (
                  <button
                    key={file.path}
                    data-index={index}
                    onClick={() => setSelectedIndex(index)}
                    onDoubleClick={() => handleOpenFile(file.path)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                      selectedIndex === index
                        ? 'bg-white/10'
                        : 'hover:bg-white/5'
                    }`}
                  >
                    {getFileIcon(file.name, file.is_dir)}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm truncate ${
                        selectedIndex === index ? 'text-app-brand-primary-light' : 'text-app-text-primary'
                      }`}>
                        {highlightText(file.name, query)}
                      </p>
                      <p className="text-xs text-app-text-tertiary truncate">
                        {highlightText(file.path, query)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right - File Details */}
        <div className="w-72 shrink-0 border-l border-white/5 p-4 overflow-y-auto">
          {selectedFile ? (
            <div className="flex flex-col items-center">
              {/* File Icon */}
              <div className="w-24 h-24 mb-4 flex items-center justify-center">
                {getFileIcon(selectedFile.name, selectedFile.is_dir)}
              </div>

              {/* File Name */}
              <h3 className="text-base font-medium text-zinc-100 text-center mb-6 break-all">
                {highlightText(selectedFile.name, query)}
              </h3>

              {/* File Details */}
              <div className="w-full space-y-4 text-sm">
                {!selectedFile.is_dir && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">大小</span>
                    <span className="text-zinc-200">{formatSize(selectedFile.size)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-zinc-500">修改时间</span>
                  <span className="text-zinc-200">{formatTime(selectedFile.modified)}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500">{selectedFile.is_dir ? '所在位置' : '所在路径'}</span>
                  <p className="text-zinc-300 text-xs break-all">
                    {selectedFile.path.substring(0, selectedFile.path.lastIndexOf('\\')) || selectedFile.path}
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 mt-6 w-full">
                <button
                  onClick={() => handleOpenFile(selectedFile.path)}
                  className="flex-1 px-3 py-2 bg-app-status-info hover:bg-app-status-info-deep rounded text-white text-sm transition-colors"
                >
                  打开
                </button>
                {!selectedFile.is_dir && (
                  <button
                    onClick={() => handleOpenFolder(selectedFile.path)}
                    className="flex-1 px-3 py-2 rounded text-zinc-200 text-sm"
                    style={{ backgroundColor: isOpenFolderHovered ? THEME.BTN_BG_HOVER : THEME.BTN_BG }}
                    onMouseEnter={() => setIsOpenFolderHovered(true)}
                    onMouseLeave={() => setIsOpenFolderHovered(false)}
                  >
                    打开目录
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
              <FileText className="w-16 h-16 mb-4 opacity-30" />
              <p className="text-sm">选择文件查看详情</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
