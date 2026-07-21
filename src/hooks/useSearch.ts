import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface AppItem {
  name: string;
  path: string;
  icon?: string;
}

export interface FileResult {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export function useSearch() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searchApps = useCallback(async (query: string) => {
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const results = await invoke<AppItem[]>('search_apps', { query });
        setApps(results);
        setSearchError(null);
      } else {
        setApps([]);
      }
    } catch (err) {
      console.error('Failed to search apps:', err);
      setApps([]);
      // 暴露错误态：搜索失败不能伪装成"未找到"
      setSearchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshApps = useCallback(async () => {
    setIsLoading(true);
    try {
      await invoke('refresh_apps');
      const results = await invoke<AppItem[]>('search_apps', { query: '' });
      setApps(results);
    } catch (err) {
      console.error('Failed to refresh apps:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const launchApp = useCallback(async (path: string, name: string) => {
    try {
      await invoke('launch_app', { path, name });
    } catch (err) {
      console.error('Failed to launch app:', err);
      // 抛回给调用方：启动失败时窗口必须保持可见并提示用户
      throw err;
    }
  }, []);

  const getRecentApps = useCallback(async (limit?: number) => {
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const results = await invoke<AppItem[]>('get_recent_apps', { limit: limit ?? null });
        return results;
      }
      return [];
    } catch (err) {
      console.error('Failed to get recent apps:', err);
      return [];
    }
  }, []);

  // Record app usage for built-in tools (they don't go through launch_app)
  const recordAppUsage = useCallback(async (path: string, name: string) => {
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        await invoke('record_app_usage', { path, name });
      }
    } catch (err) {
      console.error('Failed to record app usage:', err);
    }
  }, []);

  useEffect(() => {
    // Initial load
    searchApps('');
  }, [searchApps]);

  return {
    apps,
    isLoading,
    searchError,
    searchApps,
    refreshApps,
    launchApp,
    getRecentApps,
    recordAppUsage,
  };
}
