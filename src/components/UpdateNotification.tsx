import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useUpdater } from '@/hooks/useUpdater';
import { Download, X, RefreshCw } from 'lucide-react';
import type { UpdateInfo } from '@/hooks/useUpdater';

export function UpdateNotification() {
  const { updateInfo, isDownloading, downloadProgress, setUpdateInfo, downloadAndInstall } = useUpdater();
  const [showNotification, setShowNotification] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Listen for update-available event from backend
  useEffect(() => {
    const unlisten = listen('update-available', (event) => {
      const info = event.payload as UpdateInfo;
      setUpdateInfo(info);
      if (!dismissed) {
        setShowNotification(true);
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup update listener:', err);
      });
    };
  }, [dismissed, setUpdateInfo]);

  // Show notification when update is found
  useEffect(() => {
    if (updateInfo && !dismissed && !isDownloading) {
      setShowNotification(true);
    }
  }, [updateInfo, dismissed, isDownloading]);

  const handleDismiss = () => {
    setShowNotification(false);
    setDismissed(true);
  };

  const handleUpdate = async () => {
    await downloadAndInstall();
  };

  if (!showNotification || !updateInfo) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="bg-[#2d2d2d] border border-white/10 rounded-xl shadow-2xl p-4 min-w-[320px] max-w-[400px]">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
              <Download className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-white text-sm font-medium">发现新版本</h3>
              <p className="text-white/50 text-xs">v{updateInfo.version}</p>
            </div>
          </div>
          {!isDownloading && (
            <button
              onClick={handleDismiss}
              className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="mb-4">
          {updateInfo.body ? (
            <p className="text-white/60 text-xs line-clamp-3">{updateInfo.body}</p>
          ) : (
            <p className="text-white/60 text-xs">有新版本可用，建议更新以获得最新功能和修复。</p>
          )}
        </div>

        {/* Progress or Actions */}
        {isDownloading ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/60 flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3 animate-spin" />
                正在下载...
              </span>
              <span className="text-blue-400">{downloadProgress}%</span>
            </div>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleDismiss}
              className="flex-1 px-3 py-2 rounded-lg bg-white/5 text-white/70 text-xs hover:bg-white/10 hover:text-white transition-colors"
            >
              稍后提醒
            </button>
            <button
              onClick={handleUpdate}
              className="flex-1 px-3 py-2 rounded-lg bg-blue-500 text-white text-xs hover:bg-blue-600 transition-colors"
            >
              立即更新
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
