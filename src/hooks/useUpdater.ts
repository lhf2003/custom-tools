import { useState, useCallback, useRef, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

// Safe invoke for browser mode
const safeInvoke = async (cmd: string, args?: Record<string, unknown>) => {
  if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  }
  console.log(`[Browser Mode] Would invoke: ${cmd}`, args);
  return Promise.resolve(null);
};

export interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

export interface DownloadProgress {
  event: 'Progress' | 'Finished';
  data?: {
    chunkLength: number;
    contentLength?: number;
  };
}

export function useUpdater() {
  const [updateInfo, setUpdateInfoState] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // 已下载字节数：进度条按百分比；KB/MB 标签展示真实字节数（总大小缺失时兜底）
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 下载期间累计字节数的同步引用：listen 回调是闭包，state 会过期
  const totalDownloadedRef = useRef(0);
  const totalSizeRef = useRef<number | null>(null);

  // 订阅下载进度事件（Channel 在 WebView2 透明窗口下投递静默失败，改用 emit 事件流）
  useEffect(() => {
    const unlisten = listen<DownloadProgress>('update-download-progress', (event) => {
      const msg = event.payload;
      if (msg.event === 'Progress' && msg.data) {
        totalDownloadedRef.current += msg.data.chunkLength;
        setDownloadedBytes(totalDownloadedRef.current);
        if (msg.data.contentLength) {
          totalSizeRef.current = msg.data.contentLength;
          setDownloadProgress(
            Math.round((totalDownloadedRef.current / totalSizeRef.current) * 100)
          );
        }
      } else if (msg.event === 'Finished') {
        setDownloadProgress(100);
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Check for updates
  const checkForUpdate = useCallback(async () => {
    setIsChecking(true);
    setError(null);
    try {
      const result = await safeInvoke('check_for_update') as UpdateInfo | null;
      setUpdateInfoState(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检查更新失败';
      setError(msg);
      console.error('Failed to check for update:', err);
      // 抛出让调用方区分「已是最新」（resolve null）与「检查失败」（reject）
      throw err;
    } finally {
      setIsChecking(false);
    }
  }, []);

  // Download and install update
  const downloadAndInstall = useCallback(async () => {
    if (!updateInfo) return;

    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadedBytes(0);
    totalDownloadedRef.current = 0;
    totalSizeRef.current = null;
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { relaunch } = await import('@tauri-apps/plugin-process');

      await invoke('download_and_install_update');

      // Save changelog before relaunching
      if (updateInfo?.version && updateInfo?.body) {
        try {
          await invoke('add_changelog', {
            version: updateInfo.version,
            releaseDate: updateInfo.date,
            content: updateInfo.body,
          });
          console.log('Changelog saved for version', updateInfo.version);
        } catch (err) {
          console.error('Failed to save changelog:', err);
        }
      }

      // Relaunch the app after successful install
      await relaunch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '下载更新失败';
      setError(msg);
      console.error('Failed to download update:', err);
    } finally {
      setIsDownloading(false);
    }
  }, [updateInfo]);

  // Set update info (used by event listener)
  const setUpdateInfo = useCallback((info: UpdateInfo | null) => {
    setUpdateInfoState(info);
    setError(null);
  }, []);

  // Auto-check on mount if enabled (handled by caller)
  return {
    updateInfo,
    isChecking,
    isDownloading,
    downloadProgress,
    downloadedBytes,
    error,
    checkForUpdate,
    downloadAndInstall,
    setUpdateInfo,
    hasUpdate: !!updateInfo,
  };
}
