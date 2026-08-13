import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useUpdater } from '@/hooks/useUpdater';
import { Download, X, CheckCircle2, AlertCircle } from 'lucide-react';
import type { UpdateInfo } from '@/hooks/useUpdater';

interface UpdateCheckResult {
  status: 'latest' | 'failed';
}

const RESULT_AUTO_DISMISS_MS = 5000;

export function UpdateNotification() {
  const {
    updateInfo,
    downloadState,
    setUpdateInfo,
    startDownload,
    installNow,
    dismissReady,
    dismissError,
  } = useUpdater();
  const [showNotification, setShowNotification] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [showResult, setShowResult] = useState(false);

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

  // Listen for manual check results (latest / failed) from backend
  useEffect(() => {
    const unlisten = listen('update-check-result', (event) => {
      setCheckResult(event.payload as UpdateCheckResult);
      setShowResult(true);
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup check result listener:', err);
      });
    };
  }, []);

  // Auto-dismiss the check result feedback
  useEffect(() => {
    if (!showResult) return;
    const timer = setTimeout(() => setShowResult(false), RESULT_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showResult]);

  // Show notification when update is found
  useEffect(() => {
    if (updateInfo && !dismissed && downloadState === 'idle') {
      setShowNotification(true);
    }
  }, [updateInfo, dismissed, downloadState]);

  const handleDismiss = () => {
    setShowNotification(false);
    setDismissed(true);
  };

  // 点「立即更新」：弹窗消失，后台静默下载，结果（就绪/失败）再弹窗
  const handleUpdate = () => {
    setShowNotification(false);
    void startDownload();
  };

  // 稍后安装：安装包已落盘，下次启动自动完成安装；本次会话不再打扰
  const handleInstallLater = () => {
    setDismissed(true);
    dismissReady();
  };

  const handleCloseError = () => {
    setDismissed(true);
    dismissError();
  };

  // Check result feedback (latest / failed) — lightweight, auto-dismissing
  if (showResult && checkResult) {
    const isLatest = checkResult.status === 'latest';
    return (
      <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="bg-app-bg-tertiary border border-white/10 rounded-xl shadow-2xl p-4 min-w-[280px] max-w-[360px]">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isLatest ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
              {isLatest ? (
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-white text-sm font-medium">
                {isLatest ? '已是最新版本' : '检查更新失败'}
              </h3>
              <p className="text-white/50 text-xs">
                {isLatest ? '当前版本无需更新' : '网络连接错误或更新服务不可用，请稍后重试'}
              </p>
            </div>
            <button
              onClick={() => setShowResult(false)}
              className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 下载失败：弹窗提示，可重试（后端缓存的更新不消费，重试直接重新下载）
  if (downloadState === 'error') {
    return (
      <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="bg-app-bg-tertiary border border-white/10 rounded-xl shadow-2xl p-4 min-w-[320px] max-w-[400px]">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
              <AlertCircle className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <h3 className="text-white text-sm font-medium">更新下载失败</h3>
              <p className="text-white/50 text-xs">v{updateInfo?.version}</p>
            </div>
          </div>
          <p className="text-white/60 text-xs mb-4">网络连接错误或更新服务不可用，请稍后重试。</p>
          <div className="flex gap-2">
            <button
              onClick={handleCloseError}
              className="flex-1 px-3 py-2 rounded-lg bg-white/5 text-white/70 text-xs hover:bg-white/10 hover:text-white transition-colors"
            >
              关闭
            </button>
            <button
              onClick={() => void startDownload()}
              className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700 transition-colors"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 下载完成：弹窗询问立即安装或稍后安装（稍后 = 下次启动应用时自动完成）
  if (downloadState === 'ready') {
    return (
      <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="bg-app-bg-tertiary border border-white/10 rounded-xl shadow-2xl p-4 min-w-[320px] max-w-[400px]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-green-400" />
              </div>
              <div>
                <h3 className="text-white text-sm font-medium">更新已就绪</h3>
                <p className="text-white/50 text-xs">v{updateInfo?.version}</p>
              </div>
            </div>
            <button
              onClick={handleInstallLater}
              className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-white/60 text-xs mb-4">
            新版本已下载完成。立即安装将自动重启应用；稍后安装会在下次启动时自动完成。
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleInstallLater}
              className="flex-1 px-3 py-2 rounded-lg bg-white/5 text-white/70 text-xs hover:bg-white/10 hover:text-white transition-colors"
            >
              稍后安装
            </button>
            <button
              onClick={() => void installNow()}
              className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700 transition-colors"
            >
              立即安装
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!showNotification || !updateInfo) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="bg-app-bg-tertiary border border-white/10 rounded-xl shadow-2xl p-4 min-w-[320px] max-w-[400px]">
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
          <button
            onClick={handleDismiss}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body：不展示更新日志（更新完成后统一弹出） */}
        <p className="text-white/60 text-xs mb-4">有新版本可用，建议更新以获得最新功能和修复。</p>

        <div className="flex gap-2">
          <button
            onClick={handleDismiss}
            className="flex-1 px-3 py-2 rounded-lg bg-white/5 text-white/70 text-xs hover:bg-white/10 hover:text-white transition-colors"
          >
            稍后提醒
          </button>
          <button
            onClick={handleUpdate}
            className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700 transition-colors"
          >
            立即更新
          </button>
        </div>
      </div>
    </div>
  );
}
