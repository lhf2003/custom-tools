import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Search,
  RotateCcw,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
  RefreshCw,
} from 'lucide-react';
import { safeInvoke } from '@/utils/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { getCachedIcon, setCachedIcon } from '@/modules/launcher/iconCache';
import { SettingGroup, SettingRow } from '../components/SettingsPrimitives';

interface AppEntry {
  path: string;
  name: string;
  target_path: string;
  description: string;
  launch_count: number;
}

/** 每页行数（滚动触底加载下一页） */
const PAGE_SIZE = 50;
/** 描述长度上限（与 Rust 侧 update_app_cache_description 校验一致） */
const DESC_MAX_LEN = 50;

/** 排序列与方向 */
type SortKey = 'launch' | 'name';
type SortDir = 'asc' | 'desc';

/**
 * 应用图标：复用启动器的 iconCache（同 key=lnk 路径，跨视图共享缓存不重复 IPC）。
 * 一次性提取守卫；无图标兜底首字母 tile（与启动器同一视觉纪律）。
 */
function AppIcon({ entry }: { entry: AppEntry }) {
  const [iconData, setIconData] = useState<string | null>(
    () => getCachedIcon(entry.path) ?? null
  );
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;

    const cached = getCachedIcon(entry.path);
    if (cached !== undefined) {
      if (cached) setIconData(cached);
      return;
    }

    const loadIcon = async () => {
      try {
        const result = await invoke<string | null>('extract_app_icon', {
          path: entry.path,
        });
        setCachedIcon(entry.path, result);
        if (result) setIconData(result);
      } catch (err) {
        console.error('Failed to load icon for', entry.name, err);
      }
    };
    loadIcon();
  }, [entry.path, entry.name]);

  if (iconData) {
    return (
      <div className="w-6 h-6 rounded-md overflow-hidden flex-shrink-0 bg-app-bg-elevated flex items-center justify-center">
        <img
          src={iconData}
          alt={entry.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
    );
  }
  return (
    <div className="w-6 h-6 rounded-md flex-shrink-0 bg-app-bg-elevated flex items-center justify-center">
      <span className="text-app-text-secondary text-xs font-bold">
        {entry.name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

/** 索引来源 + 自定义扫描目录（自通用 tab 迁入），目录 CRUD 走后端持久化 */
function IndexSection() {
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    safeInvoke('get_custom_scan_dirs')
      .then((result) => setDirs((result as string[]) ?? []))
      .catch(() => setDirs([]))
      .finally(() => setLoading(false));
  }, []);

  const save = async (newDirs: string[]) => {
    const prev = dirs;
    setDirs(newDirs);
    try {
      await safeInvoke('set_custom_scan_dirs', { dirs: newDirs });
    } catch (e) {
      console.error('Failed to save custom dirs:', e);
      setDirs(prev);
    }
  };

  const addDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string' && !dirs.includes(selected)) {
        await save([...dirs, selected]);
      }
    } catch (e) {
      console.error('Failed to open directory picker:', e);
    }
  };

  const removeDir = (dir: string) => save(dirs.filter((d) => d !== dir));

  return (
    <>
      <SettingGroup title="自定义扫描目录">
        <SettingRow title="扫描目录" description="扫描时添加下方格外指定的路径">
          <button
            onClick={addDir}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer ${
              loading
                ? 'text-app-text-disabled cursor-not-allowed'
                : 'text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary'
            }`}
          >
            + 添加目录
          </button>
        </SettingRow>

        {loading ? (
          <p className="px-3 py-2 text-app-text-disabled text-xs">加载中...</p>
        ) : dirs.length === 0 ? (
          <p className="px-3 py-2 text-app-text-disabled text-xs">暂无自定义目录</p>
        ) : (
          <div className="max-h-40 overflow-y-auto">
            {dirs.map((dir) => (
              <div key={dir} className="group flex items-center gap-3 px-3 py-2.5">
                <span
                  className="text-app-text-secondary text-xs truncate flex-1 font-mono"
                  title={dir}
                >
                  {dir}
                </span>
                <button
                  onClick={() => removeDir(dir)}
                  className="text-app-text-disabled hover:text-app-status-error-text transition-colors text-xs cursor-pointer flex-shrink-0 opacity-0 group-hover:opacity-100"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingGroup>
    </>
  );
}

/**
 * 系统「应用」tab：app_cache 列表 + 描述标注。
 * 描述由模型分析回填或用户手动编辑，拼接分析摘要时随进程名带给 LLM。
 */
export function AppsSettings() {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('launch');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(false);
  const [entries, setEntries] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const entriesRef = useRef<AppEntry[]>([]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  // 未知应用提醒深链：预填搜索并清空待处理项（设置页挂载/切回时消费）
  useEffect(() => {
    const pending = useSettingsStore.getState().appsTabQuery;
    if (pending) {
      setQuery(pending);
      useSettingsStore.getState().setAppsTabQuery(null);
    }
  }, []);

  const loadPage = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const rows = await invoke<AppEntry[]>('get_app_cache_entries', {
          query: query.trim() || null,
          sort: sortKey,
          direction: sortDir,
          onlyUnlabeled,
          offset,
          limit: PAGE_SIZE,
        });
        setEntries((prev) => (offset === 0 ? rows : [...prev, ...rows]));
        setHasMore(rows.length === PAGE_SIZE);
      } catch (err) {
        console.error('Failed to load app entries:', err);
        if (offset === 0) setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [query, sortKey, sortDir, onlyUnlabeled]
  );

  /** 手动重新扫描（注册表/UWP/快捷方式全量重建），装新应用后可立即刷新 */
  const handleRescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      await invoke('refresh_apps');
      await loadPage(0);
    } catch (err) {
      console.error('Failed to rescan apps:', err);
    } finally {
      setRescanning(false);
    }
  };

  /** 列头点击排序：同列 toggle 方向；切列用该列默认方向（名称升序、启动次数降序） */
  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'name' ? 'asc' : 'desc');
      }
    },
    [sortKey]
  );

  // 查询条件变化 → 重置列表
  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  // 滚动触底加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (items) => {
        if (items[0].isIntersecting && !loading && hasMore) {
          void loadPage(entriesRef.current.length);
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage]);

  const startEdit = (entry: AppEntry) => {
    setEditingPath(entry.path);
    setDraft(entry.description);
  };

  const handleSave = async (path: string) => {
    const description = draft.trim();
    setEditingPath(null);
    if (description.length > DESC_MAX_LEN) return;
    try {
      await invoke('update_app_cache_description', { path, description });
      setEntries((prev) =>
        prev.map((e) => (e.path === path ? { ...e, description } : e))
      );
    } catch (err) {
      console.error('Failed to update description:', err);
    }
  };

  return (
    <div className="flex flex-col h-full gap-3">
      {/* 索引来源与扫描目录（自通用 tab 迁入） */}
      <IndexSection />

      {/* 工具栏：搜索 + 筛选 + 排序 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-app-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索应用名称或 exe 文件名…"
            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-app-text-primary text-xs placeholder:text-app-text-disabled focus:outline-none focus:border-app-brand-primary/40 transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
              title="清空搜索"
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center rounded-lg bg-white/5 border border-white/10 overflow-hidden">
          <button
            onClick={() => setOnlyUnlabeled(false)}
            className={`px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
              !onlyUnlabeled
                ? 'text-app-text-primary bg-white/10'
                : 'text-app-text-tertiary hover:text-app-text-primary'
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setOnlyUnlabeled(true)}
            className={`px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
              onlyUnlabeled
                ? 'text-app-text-primary bg-white/10'
                : 'text-app-text-tertiary hover:text-app-text-primary'
            }`}
          >
            仅未标注
          </button>
        </div>
        <button
          onClick={handleRescan}
          disabled={rescanning}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:hover:bg-transparent"
          title="重新扫描已安装应用（注册表 / UWP / 快捷方式）"
        >
          <RefreshCw size={12} className={rescanning ? 'animate-spin' : ''} />
          {rescanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>

      {/* 表头（名称 / 启动次数列可点击排序） */}
      <div className="flex items-center gap-3 px-2 text-app-text-disabled text-xs select-none">
        <span className="w-6 flex-shrink-0" />
        <button
          onClick={() => handleSort('name')}
          className="w-44 flex items-center gap-1 text-left truncate transition-colors cursor-pointer hover:text-app-text-primary"
          title={sortKey === 'name' ? `按名称${sortDir === 'asc' ? '升序' : '降序'}（点击切换）` : '按名称排序'}
        >
          名称
          {sortKey === 'name' ? (
            sortDir === 'asc' ? (
              <ChevronUp size={12} className="text-app-brand-primary-light" />
            ) : (
              <ChevronDown size={12} className="text-app-brand-primary-light" />
            )
          ) : (
            <ArrowUpDown size={12} className="opacity-50" />
          )}
        </button>
        <span className="flex-1">描述</span>
        <button
          onClick={() => handleSort('launch')}
          className="w-16 flex items-center gap-1 text-left truncate transition-colors cursor-pointer hover:text-app-text-primary"
          title={sortKey === 'launch' ? `按启动次数${sortDir === 'desc' ? '降序' : '升序'}（点击切换）` : '按启动次数排序'}
        >
          {sortKey === 'launch' ? (
            sortDir === 'desc' ? (
              <ChevronDown size={12} className="text-app-brand-primary-light" />
            ) : (
              <ChevronUp size={12} className="text-app-brand-primary-light" />
            )
          ) : (
            <ArrowUpDown size={12} className="opacity-50" />
          )}
          启动次数
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2">
        {entries.length === 0 && !loading ? (
          <p className="text-app-text-disabled text-xs py-8 text-center">
            {onlyUnlabeled ? '没有未标注的应用' : '没有找到应用'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => {
              const isEditing = editingPath === entry.path;
              return (
                <div
                  key={entry.path}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors"
                >
                  <AppIcon entry={entry} />
                  <span
                    className="w-44 truncate text-app-text-secondary text-xs"
                    title={entry.path}
                  >
                    {entry.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSave(entry.path);
                          if (e.key === 'Escape') setEditingPath(null);
                        }}
                        onBlur={() => void handleSave(entry.path)}
                        autoFocus
                        maxLength={DESC_MAX_LEN}
                        placeholder="填写应用用途，如：代码编辑器"
                        className="w-full px-2 py-0.5 rounded-md bg-white/10 border border-app-brand-primary/40 text-app-text-primary text-xs placeholder:text-app-text-disabled focus:outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => startEdit(entry)}
                        className="w-full text-left px-2 py-0.5 rounded-md text-xs truncate text-app-text-secondary hover:bg-white/5 transition-colors cursor-pointer"
                        title="点击编辑描述（模型分析时也会尝试回填）"
                      >
                        {entry.description || (
                          <span className="text-app-text-disabled">点击填写描述</span>
                        )}
                      </button>
                    )}
                  </div>
                  <span className="w-16 text-left text-app-text-tertiary text-xs tabular-nums">
                    {entry.launch_count}
                  </span>
                </div>
              );
            })}
            {/* 触底加载哨兵 */}
            <div ref={sentinelRef} className="h-px" />
            {loading && (
              <p className="text-app-text-disabled text-xs py-3 text-center">加载中…</p>
            )}
            {!hasMore && entries.length > 0 && (
              <p className="text-app-text-disabled text-xs py-3 text-center">
                共 {entries.length} 项 · 已到底
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
