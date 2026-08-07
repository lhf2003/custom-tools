import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Sparkles, Check } from 'lucide-react';
import { ChangelogEntryView } from './ChangelogEntryView';

export interface ChangelogEntry {
  version: string;
  release_date: string | null;
  content: string;
  is_read: boolean;
  created_at: string;
}

export interface VersionCheckResult {
  current_version: string;
  has_new_version: boolean;
  unread_changelogs: ChangelogEntry[];
}

interface ChangelogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 由调用方传入已获取的数据，避免重复请求 */
  initialData?: VersionCheckResult | null;
}

export function ChangelogDialog({ isOpen, onClose, initialData }: ChangelogDialogProps) {
  const [changelogs, setChangelogs] = useState<ChangelogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentVersion, setCurrentVersion] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    // 如果调用方已经拿到数据，直接用，不再发请求
    if (initialData) {
      setCurrentVersion(initialData.current_version);
      setChangelogs(initialData.unread_changelogs);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    invoke<VersionCheckResult>('check_version_changelog')
      .then((result) => {
        setCurrentVersion(result.current_version);
        setChangelogs(result.unread_changelogs);
      })
      .catch((err) => {
        console.error('Failed to load changelogs:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen, initialData]);

  const handleMarkAsRead = async () => {
    try {
      await invoke('mark_all_changelogs_read');
      onClose();
    } catch (err) {
      console.error('Failed to mark changelogs as read:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[480px] max-h-[80vh] bg-app-bg-tertiary rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-app-status-info" />
            <h2 className="text-base font-semibold text-app-text-primary">
              更新日志
              {currentVersion && (
                <span className="ml-2 text-sm text-app-text-tertiary">v{currentVersion}</span>
              )}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 divide-y divide-app-border-subtle">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-app-text-disabled">
              <div className="animate-pulse">加载中...</div>
            </div>
          ) : changelogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-app-text-disabled">
              <Check className="w-12 h-12 mb-3 text-app-status-success/50" />
              <p className="text-sm">暂无新更新日志</p>
              <p className="text-xs mt-1">您已查看所有更新内容</p>
            </div>
          ) : (
            changelogs.map((changelog) => (
              <ChangelogEntryView
                key={changelog.version}
                version={changelog.version}
                releaseDate={changelog.release_date}
                content={changelog.content}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-app-border-subtle flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-app-text-tertiary hover:text-app-text-primary transition-colors"
          >
            稍后再看
          </button>
          <button
            onClick={handleMarkAsRead}
            disabled={changelogs.length === 0 || isLoading}
            className="px-4 py-2 bg-app-status-info/20 hover:bg-app-status-info/30 text-app-status-info border border-app-status-info/30 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            已阅
          </button>
        </div>
      </div>
    </div>
  );
}
