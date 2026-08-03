import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useStatsStore, type DataCategory } from '@/stores/statsStore';
import { useToastStore } from '@/stores/toastStore';
import { fmtBytes, fmtScannedAt } from './format';

/** 分类色：数据编码用，others 兜底落灰阶，内容类各用区分色 */
const CATEGORY_COLORS: Record<string, string> = {
  core_db: '#34d399',
  clipboard: '#38bdf8',
  notes: '#818cf8',
  companion: '#a855f7',
  icon_cache: '#2dd4bf',
  logs: '#f59e0b',
  others: '#71717a',
};

function CategoryRow({ category }: { category: DataCategory }) {
  const cleanupCategory = useStatsStore((s) => s.cleanupCategory);
  const addToast = useToastStore((s) => s.addToast);
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const color = CATEGORY_COLORS[category.key] ?? CATEGORY_COLORS.others;
  const counts = category.dir_count > 0
    ? `${category.file_count} 个文件 · ${category.dir_count} 个目录`
    : `${category.file_count} 个文件`;

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const freed = await cleanupCategory(category.key as 'logs' | 'icon_cache');
      addToast({
        type: 'success',
        title: `${category.label}已清理`,
        message: freed > 0 ? `释放 ${fmtBytes(freed)}` : '没有可清理的文件',
      });
    } catch (err) {
      addToast({ type: 'error', title: '清理失败', message: String(err) });
    } finally {
      setCleaning(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white/90">{category.label}</div>
        <div className="text-xs text-white/40 mt-0.5 truncate">
          {category.description} · {counts}
        </div>
      </div>
      <span className="text-sm font-semibold text-white/80 tabular-nums flex-shrink-0">
        {fmtBytes(category.bytes)}
      </span>
      {category.cleanable && (
        <div className="flex-shrink-0 w-20 flex justify-end">
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleCleanup}
                disabled={cleaning}
                className="px-2 py-1 rounded-md text-xs bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 transition-colors cursor-pointer disabled:opacity-50"
              >
                {cleaning ? '清理中' : '确认'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={cleaning}
                className="px-2 py-1 rounded-md text-xs text-white/50 hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Trash2 size={12} />
              清理
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function LocalDataSection() {
  const { localStats, localStatsLoading, loadLocalDataStats } = useStatsStore();

  const visibleCategories = localStats?.categories.filter((c) => c.bytes > 0) ?? [];

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-white/90">本地数据空间</h3>
          <p className="text-xs text-white/40 mt-0.5">
            FlowHub 在这台设备上的总占用与分类构成
          </p>
        </div>
        <button
          onClick={loadLocalDataStats}
          disabled={localStatsLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={12} className={localStatsLoading ? 'animate-spin' : ''} />
          重新统计
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        {!localStats ? (
          <div className="px-4 py-8 text-center text-xs text-white/30">
            {localStatsLoading ? '正在统计磁盘占用…' : '统计数据不可用'}
          </div>
        ) : (
          <>
            {/* 总量 + 分类条 */}
            <div className="px-4 pt-4 pb-3 border-b border-white/5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-xs text-white/40 mb-1">已使用</div>
                  <div className="text-lg font-semibold text-white/90 tabular-nums">
                    {fmtBytes(localStats.total_bytes)}
                  </div>
                </div>
                <div className="text-right text-xs text-white/40 space-y-0.5">
                  {localStats.disk_free_bytes !== null && (
                    <div>磁盘可用 {fmtBytes(localStats.disk_free_bytes)}</div>
                  )}
                  <div>统计于 {fmtScannedAt(localStats.scanned_at)}</div>
                </div>
              </div>

              {visibleCategories.length > 0 && (
                <>
                  <div className="flex h-2 rounded-full overflow-hidden mt-3 bg-white/5">
                    {visibleCategories.map((c) => (
                      <div
                        key={c.key}
                        style={{
                          width: `${(c.bytes / localStats.total_bytes) * 100}%`,
                          minWidth: '4px',
                          backgroundColor: CATEGORY_COLORS[c.key] ?? CATEGORY_COLORS.others,
                        }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                    {visibleCategories.map((c) => (
                      <span key={c.key} className="flex items-center gap-1.5 text-xs text-white/50">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: CATEGORY_COLORS[c.key] ?? CATEGORY_COLORS.others }}
                        />
                        {c.label}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* 分类明细 */}
            <div className="divide-y divide-white/5">
              {localStats.categories.map((c) => (
                <CategoryRow key={c.key} category={c} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
