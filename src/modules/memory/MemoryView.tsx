import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, BrainCircuit } from 'lucide-react';
import { debouncedResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { usePluginPayload } from '@/plugins/usePluginPayload';
import { useAppStore } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { aggregateBySource } from './aggregation';
import { SourceCard } from './SourceCard';
import { useMemoryOpen } from './useMemoryOpen';
import type { MemoryHit } from './types';

/** 知识页单次检索条数（聚合前的记录数；来源数远小于此） */
const SEARCH_K = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 知识索引插件视图（2026-09-02 裁决）：
 * 搜索框 + 来源聚合网格（一来源一卡）；空查询态为「最近索引」浏览视图（P3：indexed_at 倒序）。
 * 启动器命中条目 / `s ` trigger 经 usePluginPayload 预填查询词（同一通道）。
 */
export function MemoryView() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 浏览态（P3）：空查询时的最近索引；recentError 表示库不可达（区别于空库）
  const [recentHits, setRecentHits] = useState<MemoryHit[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 陈旧响应守卫：只认最后一次请求的返回
  const reqRef = useRef(0);
  const openMemoryHit = useMemoryOpen();
  const setActiveView = useAppStore((s) => s.setActiveView);

  useEffect(() => {
    debouncedResize(WINDOW_SIZE.PLUGIN.height, WINDOW_SIZE.PLUGIN.width);
    inputRef.current?.focus();
  }, []);

  // 浏览态数据：进入空查询态时拉取最近索引
  const searching = query.trim().length >= 2;
  useEffect(() => {
    if (searching) return;
    let cancelled = false;
    setRecentLoading(true);
    invoke<MemoryHit[]>('memory_recent', { limit: 60 })
      .then((result) => {
        if (cancelled) return;
        setRecentHits(result ?? []);
        setRecentError(null);
        setRecentLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('memory_recent failed:', err);
        setRecentHits([]);
        setRecentError(String(err));
        setRecentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searching]);

  // 载荷：启动器命中条目 / `s ` trigger 带入的查询词
  usePluginPayload(
    'memory',
    useCallback((payload: unknown) => {
      if (typeof payload === 'string') setQuery(payload);
      inputRef.current?.focus();
    }, []),
  );

  // 检索：防抖 + 陈旧守卫；失败不打扰，错误态内联表达（模型未就绪引导去设置）
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearchError(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      invoke<MemoryHit[]>('memory_search', { query: q, k: SEARCH_K })
        .then((result) => {
          if (reqRef.current !== reqId) return;
          setHits(result ?? []);
          setSearchError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (reqRef.current !== reqId) return;
          console.warn('memory_search failed:', err);
          setHits([]);
          setSearchError(String(err));
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const sources = useMemo(() => aggregateBySource(hits), [hits]);
  // 浏览态聚合：复用同一模型，排序键换成时间（检索态按 topScore）
  const recentSources = useMemo(
    () => aggregateBySource(recentHits).sort((a, b) => b.lastIndexedAt.localeCompare(a.lastIndexedAt)),
    [recentHits],
  );

  return (
    <div className="h-full flex flex-col px-4 pb-4 panel-glass">
      {/* 搜索行：设置统一在设置窗口「系统插件」tab（2026-09-02 起插件内不再设入口） */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus-within:border-white/20 transition-colors">
          <Search className="w-4 h-4 text-app-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="语义检索你的记忆：网页、字幕、笔记、剪贴板…"
            className="flex-1 bg-transparent text-sm text-app-text-primary outline-none placeholder:text-app-text-placeholder"
          />
        </div>
      </div>

      {/* 结果区 */}
      {!searching ? (
        // P3 浏览态：最近索引混合网格
        recentLoading ? (
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : recentError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-tertiary">
            <BrainCircuit className="w-10 h-10 opacity-30" />
            <p className="text-sm">记忆库暂不可达</p>
            <p className="text-xs opacity-60 max-w-md text-center break-all">{recentError}</p>
          </div>
        ) : recentSources.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-tertiary">
            <BrainCircuit className="w-10 h-10 opacity-30" />
            <p className="text-sm">还没有索引数据</p>
            <p className="text-xs opacity-60">浏览 10 秒以上的页面会自动索引；剪贴板图片可在剪贴板页「索引此图」</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="text-xs text-app-text-tertiary mb-2">
              最近索引 · {recentSources.length} 个来源
            </div>
            <div className="grid grid-cols-3 gap-3 pb-2">
              {recentSources.map((source) => (
                <SourceCard
                  key={source.key}
                  source={source}
                  onOpenHit={(hit) => void openMemoryHit(hit)}
                />
              ))}
            </div>
          </div>
        )
      ) : loading && sources.length === 0 ? (
        // 骨架屏：首次检索等待
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : searchError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-app-text-tertiary">
          <p className="text-sm">记忆检索暂不可用</p>
          <p className="text-xs opacity-60 max-w-md text-center break-all">{searchError}</p>
          <button
            onClick={() => {
              useSettingsStore.getState().setPendingTab('builtin');
              setActiveView('settings');
            }}
            className="mt-1 px-3 py-1.5 rounded-lg text-xs bg-white/10 hover:bg-white/15 transition-colors cursor-pointer"
          >
            检查本地模型环境
          </button>
        </div>
      ) : sources.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-app-text-tertiary">
          没有在记忆里找到相关内容
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="text-xs text-app-text-tertiary mb-2">
            {sources.length} 个来源 · {hits.length} 处命中
          </div>
          <div className="grid grid-cols-3 gap-3 pb-2">
            {sources.map((source) => (
              <SourceCard
                key={source.key}
                source={source}
                onOpenHit={(hit) => void openMemoryHit(hit)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
