import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Sparkles, Calendar, Check } from 'lucide-react';

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

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  // Parse markdown-like content to HTML
  const parseContent = (content: string): string => {
    return content
      .replace(/^## (.*$)/gim, '<h2 class="text-lg font-semibold text-zinc-200 mt-4 mb-2">$1</h2>')
      .replace(/^### (.*$)/gim, '<h3 class="text-base font-medium text-zinc-300 mt-3 mb-1">$1</h3>')
      .replace(/^\- (.*$)/gim, '<li class="text-zinc-400 ml-4 mb-1">$1</li>')
      .replace(/^\* (.*$)/gim, '<li class="text-zinc-400 ml-4 mb-1">$1</li>')
      .replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em class="text-zinc-300">$1</em>')
      .replace(/`([^`]+)`/g, '<code class="bg-zinc-700 px-1 py-0.5 rounded text-sm text-zinc-300">$1</code>')
      .replace(/\n\n/g, '</p><p class="mb-2">')
      .replace(/^/, '<p class="mb-2">')
      .replace(/$/, '</p>');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[480px] max-h-[80vh] bg-[#2d2d2d] rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-[#333]">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-semibold text-zinc-100">
              更新日志
              {currentVersion && (
                <span className="ml-2 text-sm text-zinc-400">v{currentVersion}</span>
              )}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              <div className="animate-pulse">加载中...</div>
            </div>
          ) : changelogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
              <Check className="w-12 h-12 mb-3 text-green-500/50" />
              <p className="text-sm">暂无新更新日志</p>
              <p className="text-xs text-zinc-600 mt-1">您已查看所有更新内容</p>
            </div>
          ) : (
            <div className="space-y-6">
              {changelogs.map((changelog) => (
                <div key={changelog.version} className="space-y-3">
                  {/* Version Header */}
                  <div className="flex items-center gap-3">
                    <span className="px-2.5 py-1 bg-blue-500/20 text-blue-300 text-sm font-medium rounded-full">
                      v{changelog.version}
                    </span>
                    {changelog.release_date && (
                      <div className="flex items-center gap-1 text-xs text-zinc-500">
                        <Calendar className="w-3.5 h-3.5" />
                        {formatDate(changelog.release_date)}
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div
                    className="text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: parseContent(changelog.content) }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-white/5 bg-[#333]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            稍后再看
          </button>
          <button
            onClick={handleMarkAsRead}
            disabled={changelogs.length === 0 || isLoading}
            className="px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            已阅
          </button>
        </div>
      </div>
    </div>
  );
}
