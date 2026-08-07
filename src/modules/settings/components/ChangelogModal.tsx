import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ChangelogEntryView } from '@/components/ChangelogEntryView';

/* ==================== 更新日志（运行时数据：GitHub Releases 同步 + 内置历史） ==================== */

interface ChangelogEntry {
  version: string;
  release_date: string | null;
  content: string;
  is_read: boolean;
  created_at: string;
}

/** Browser mode（纯前端 dev）下跳过 Tauri invoke */
const safeInvoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => {
  if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  return null;
};

/* ==================== 弹窗 ==================== */

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 更新日志弹窗：打开时先同步 GitHub Releases 增量入库，再从本地库读全量历史。
 *  旧版本（0.1.0~0.3.3）由后端 seed 归档；Esc/遮罩点击关闭 */
export function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      // 先同步远端 release（失败不致命，退回本地库缓存）
      try {
        await safeInvoke<number>('sync_releases_changelog');
      } catch (e) {
        console.warn('Failed to sync releases:', e);
      }
      try {
        const data = await safeInvoke<ChangelogEntry[]>('list_changelogs');
        if (!cancelled) setEntries(data ?? []);
      } catch (e) {
        console.error('Failed to load changelogs:', e);
        if (!cancelled) setError('加载更新日志失败');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] bg-app-bg-tertiary rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border-subtle flex-shrink-0">
          <h2 className="text-base font-semibold text-app-text-primary">更新日志</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content：版本块间 hairline 分隔 */}
        <div className="flex-1 overflow-y-auto px-5 divide-y divide-app-border-subtle">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-app-text-disabled text-xs">
              加载中…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12 text-app-text-disabled text-xs">
              {error}，请检查网络后重试
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-app-text-disabled text-xs">
              暂无更新日志
            </div>
          ) : (
            entries.map((entry, index) => (
              <ChangelogEntryView
                key={entry.version}
                version={entry.version}
                releaseDate={entry.release_date}
                content={entry.content}
                isLatest={index === 0}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
