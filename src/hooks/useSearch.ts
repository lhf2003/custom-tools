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
  const [files, setFiles] = useState<FileResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasEverything, setHasEverything] = useState<boolean | null>(null);

  // Check if Everything is available (lazy check - only when needed)
  const checkEverythingAvailable = useCallback(async () => {
    if (hasEverything !== null) return hasEverything;
    try {
      const available = await invoke<boolean>('is_everything_available');
      setHasEverything(available);
      return available;
    } catch (err) {
      setHasEverything(false);
      return false;
    }
  }, [hasEverything]);

  const searchApps = useCallback(async (query: string) => {
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const results = await invoke<AppItem[]>('search_apps', { query });
        setApps(results);

        // Also search files via Everything if available and query is not empty
        if (query.length > 0) {
          const everythingAvailable = await checkEverythingAvailable();
          if (everythingAvailable) {
            const fileResults = await invoke<FileResult[]>('search_everything', { query, limit: 10 });
            setFiles(fileResults);
          } else {
            setFiles([]);
          }
        } else {
          setFiles([]);
        }
      } else {
        setApps([]);
        setFiles([]);
      }
    } catch (err) {
      console.error('Failed to search apps:', err);
      setApps([]);
      setFiles([]);
    }
  }, [checkEverythingAvailable]);

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
    }
  }, []);

  const getRecentApps = useCallback(async (limit: number = 14) => {
    try {
      // Check if we're in Tauri environment
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        const results = await invoke<AppItem[]>('get_recent_apps', { limit });
        return results;
      }
      return [];
    } catch (err) {
      console.error('Failed to get recent apps:', err);
      return [];
    }
  }, []);

  useEffect(() => {
    // Initial load
    searchApps('');
  }, [searchApps]);

  return {
    apps,
    files,
    isLoading,
    hasEverything,
    searchApps,
    refreshApps,
    launchApp,
    getRecentApps,
  };
}
