import { create } from 'zustand';
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

/**
 * 下载状态机：
 * - idle：未下载（或结果被用户关掉）
 * - downloading：后台下载中（不占页面，关于页行内可见进度）
 * - ready：已下载待安装 → 弹「立即安装 / 稍后安装」
 * - error：下载/安装失败 → 弹错误提示（可重试）
 */
export type DownloadState = 'idle' | 'downloading' | 'ready' | 'error';

interface UpdaterState {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  downloadState: DownloadState;
  downloadProgress: number;
  // 已下载字节数：进度条按百分比；KB/MB 标签展示真实字节数（总大小缺失时兜底）
  downloadedBytes: number;
  error: string | null;
  checkForUpdate: () => Promise<UpdateInfo | null>;
  /** 后台下载更新（不安装）；成功后置 ready，由用户决定何时安装 */
  startDownload: () => Promise<void>;
  /** 安装已下载的更新：进程退出由安装器完成安装并自动重启新版本 */
  installNow: () => Promise<void>;
  /** 稍后安装：安装包已落盘，下次启动应用时自动完成安装 */
  dismissReady: () => void;
  dismissError: () => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
}

// 下载期间累计字节数的模块级真值源：listen 回调是闭包，直接 set 会读到过期 state
let totalDownloaded = 0;
let totalSize: number | null = null;

// 订阅下载进度事件（Channel 在 WebView2 透明窗口下投递静默失败，改用 emit 事件流）。
// 模块级订阅一次：store 全局唯一，多组件挂载不会重复 listen。
if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
  listen<DownloadProgress>('update-download-progress', (event) => {
    const msg = event.payload;
    if (msg.event === 'Progress' && msg.data) {
      totalDownloaded += msg.data.chunkLength;
      const next: Partial<UpdaterState> = { downloadedBytes: totalDownloaded };
      if (msg.data.contentLength) {
        totalSize = msg.data.contentLength;
        next.downloadProgress = Math.round((totalDownloaded / totalSize) * 100);
      }
      useUpdaterStore.setState(next);
    } else if (msg.event === 'Finished') {
      useUpdaterStore.setState({ downloadProgress: 100 });
    }
  }).catch((err: unknown) => {
    console.error('Failed to subscribe download progress:', err);
  });

  // 订阅「发现新版本」事件。同样模块级：后端启动检查后单次发射不重发，
  // 组件级监听在欢迎页抑制期间组件不挂载，事件会永久丢失（横幅不再出现）。
  listen<UpdateInfo>('update-available', (event) => {
    useUpdaterStore.setState({ updateInfo: event.payload });
  }).catch((err: unknown) => {
    console.error('Failed to subscribe update-available:', err);
  });
}

function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  updateInfo: null,
  isChecking: false,
  downloadState: 'idle',
  downloadProgress: 0,
  downloadedBytes: 0,
  error: null,

  checkForUpdate: async () => {
    set({ isChecking: true, error: null });
    try {
      const result = (await safeInvoke('check_for_update')) as UpdateInfo | null;
      set({ updateInfo: result });
      return result;
    } catch (err) {
      const msg = toErrorMessage(err, '检查更新失败');
      set({ error: msg });
      console.error('Failed to check for update:', err);
      // 抛出让调用方区分「已是最新」（resolve null）与「检查失败」（reject）
      throw err;
    } finally {
      set({ isChecking: false });
    }
  },

  startDownload: async () => {
    if (!get().updateInfo || get().downloadState === 'downloading') return;

    totalDownloaded = 0;
    totalSize = null;
    set({ downloadState: 'downloading', downloadProgress: 0, downloadedBytes: 0, error: null });

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // 后端仅下载+落盘+预写更新日志，进程保持存活
      await invoke('download_update');
      set({ downloadState: 'ready' });
    } catch (err) {
      const msg = toErrorMessage(err, '下载更新失败');
      set({ downloadState: 'error', error: msg });
      console.error('Failed to download update:', err);
    }
  },

  installNow: async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // 成功时进程立即退出（NSIS 装完自动启动新版本），invoke 不会 resolve
      await invoke('install_downloaded_update');
    } catch (err) {
      const msg = toErrorMessage(err, '安装失败');
      set({ downloadState: 'error', error: msg });
      console.error('Failed to install update:', err);
    }
  },

  dismissReady: () => set({ downloadState: 'idle' }),
  dismissError: () => set({ downloadState: 'idle', error: null }),

  setUpdateInfo: (info) => set({ updateInfo: info, error: null }),
}));

export function useUpdater() {
  const state = useUpdaterStore();
  return { ...state, hasUpdate: !!state.updateInfo };
}
