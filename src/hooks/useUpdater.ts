import { useState, useCallback, useEffect } from 'react';
import { Channel } from '@tauri-apps/api/core';

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
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Check for updates
  const checkForUpdate = useCallback(async () => {
    setIsChecking(true);
    setError(null);
    try {
      const result = await safeInvoke('check_for_update') as UpdateInfo | null;
      setUpdateInfo(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检查更新失败';
      setError(msg);
      console.error('Failed to check for update:', err);
      return null;
    } finally {
      setIsChecking(false);
    }
  }, []);

  // Download and install update
  const downloadAndInstall = useCallback(async () => {
    if (!updateInfo) return;

    setIsDownloading(true);
    setDownloadProgress(0);
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { relaunch } = await import('@tauri-apps/plugin-process');

      // Create a channel for progress updates
      const channel = new Channel<DownloadProgress>();
      let totalDownloaded = 0;
      let totalSize = 0;

      channel.onmessage = (message) => {
        if (message.event === 'Progress' && message.data) {
          totalDownloaded += message.data.chunkLength;
          if (message.data.contentLength) {
            totalSize = message.data.contentLength;
            setDownloadProgress(Math.round((totalDownloaded / totalSize) * 100));
          }
        } else if (message.event === 'Finished') {
          setDownloadProgress(100);
        }
      };

      await invoke('download_and_install_update', {
        onProgress: channel,
      });

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

  // Auto-check on mount if enabled (handled by caller)
  return {
    updateInfo,
    isChecking,
    isDownloading,
    downloadProgress,
    error,
    checkForUpdate,
    downloadAndInstall,
    hasUpdate: !!updateInfo,
  };
}
