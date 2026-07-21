import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface AppItem {
  name: string;
  path: string;
  icon?: string;
}

export function useSearch() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 竞态序列号：慢后端时旧响应不得覆盖新结果
  const searchSeqRef = useRef(0);

  // 返回搜索结果：调用方（如回车即时搜索）可绕过防抖直接使用新鲜结果
  const searchApps = useCallback(async (query: string): Promise<AppItem[]> => {
    const seq = ++searchSeqRef.current;
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const results = await invoke<AppItem[]>('search_apps', { query });
        if (seq === searchSeqRef.current) {
          setApps(results);
          setSearchError(null);
        }
        return results;
      }
      if (seq === searchSeqRef.current) {
        setApps([]);
      }
      return [];
    } catch (err) {
      console.error('Failed to search apps:', err);
      if (seq === searchSeqRef.current) {
        setApps([]);
        // 暴露错误态：搜索失败不能伪装成"未找到"
        setSearchError(err instanceof Error ? err.message : String(err));
      }
      return [];
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

  return {
    apps,
    searchError,
    searchApps,
    launchApp,
    getRecentApps,
    recordAppUsage,
  };
}
