import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import { X, Sparkles, Check } from 'lucide-react';
import { ChangelogEntryView } from './ChangelogEntryView';
import { immediateResize } from '@/utils/tauri';
import { useAppStore } from '@/stores/appStore';

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

/** 弹窗展示窗口尺寸：与工具视图同宽高，保证多条 changelog 有足够内容区 */
const DIALOG_WIDTH = 820;
const DIALOG_HEIGHT = 600;
/** 窗口顶部锚定偏移（与 window.rs position_window_at_top 的 TOP_PADDING 一致） */
const WINDOW_TOP_OFFSET = 100;
/** 底部安全余量：任务栏与窗口阴影 */
const BOTTOM_MARGIN = 24;

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

  // 打开时临时放大主窗口：更新后首次启动窗口仍是启动器高度（192/440），
  // 弹层 85vh 上限被压扁内容显示不全；关闭时精确恢复打开前的逻辑尺寸。
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let prevSize: { height: number; width: number } | null = null;

    try {
      const win = getCurrentWindow();
      win
        .scaleFactor()
        .then((scale) => win.innerSize().then((size) => ({ scale, size })))
        .then(async ({ scale, size }) => {
          if (cancelled) return;
          // 物理/scale 必须取整：resize_window 收 u32，浮点会被 serde 拒绝静默丢恢复；
          // 四舍五入是 OS 物理取整的精确逆运算（如 230/1.2=191.67 → 192）
          prevSize = {
            height: Math.round(size.height / scale),
            width: Math.round(size.width / scale),
          };
          // 放大高度按显示器收敛：窗口顶部锚在显示器顶 +100（window.rs TOP_PADDING），
          // 全高 600 在低分辨率小屏（如 768@125%）会把底部按钮切出屏幕
          let targetHeight = DIALOG_HEIGHT;
          const monitor = await currentMonitor();
          if (monitor) {
            const workAreaLogicalH = monitor.size.height / monitor.scaleFactor;
            targetHeight = Math.min(
              DIALOG_HEIGHT,
              workAreaLogicalH - WINDOW_TOP_OFFSET - BOTTOM_MARGIN,
            );
          }
          immediateResize(Math.round(targetHeight), DIALOG_WIDTH);
        })
        .catch(() => {
          /* 取窗口尺寸失败时放弃恢复，弹窗仍可用（纯浏览器 dev 模式） */
        });
    } catch {
      /* 非 Tauri 环境无窗口 API，忽略 */
    }

    return () => {
      cancelled = true;
      // 弹窗期间用户切换视图（全局快捷键）时新视图接管窗口尺寸，跳过恢复避免覆盖
      if (prevSize && useAppStore.getState().activeView === 'launcher') {
        immediateResize(prevSize.height, prevSize.width);
      }
    };
  }, [isOpen]);

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
      <div className="w-[480px] max-h-[85vh] bg-app-bg-tertiary rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col">
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
