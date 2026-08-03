import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// ── 与后端 commands/stats.rs 对应的类型 ─────────────────────

export interface ObserveFilter {
  source: string | null;
  model: string | null;
  /** unix 秒，闭区间起点 */
  since: number;
  /** unix 秒，开区间终点 */
  until: number;
}

export interface ObservabilitySummary {
  total_tokens: number;
  model_calls: number;
  tool_calls: number;
  errors: number;
}

export interface SourceStatRow {
  source: string;
  calls: number;
  errors: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  total_duration_ms: number;
  tool_calls: number;
}

export interface ObservabilityResult {
  summary: ObservabilitySummary;
  rows: SourceStatRow[];
}

export interface CallLogRow {
  id: number;
  source: string;
  channel: string;
  scene: string | null;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  duration_ms: number;
  tool_call_count: number;
  status: string;
  error: string | null;
  created_at: number;
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

export interface ObserveOptions {
  sources: string[];
  model_groups: ModelGroup[];
}

export interface DataCategory {
  key: string;
  label: string;
  description: string;
  bytes: number;
  file_count: number;
  dir_count: number;
  cleanable: boolean;
}

export interface LocalDataStats {
  total_bytes: number;
  disk_free_bytes: number | null;
  categories: DataCategory[];
  scanned_at: number;
}

interface StatsState {
  localStats: LocalDataStats | null;
  localStatsLoading: boolean;
  observeOptions: ObserveOptions | null;
  observability: ObservabilityResult | null;
  observabilityLoading: boolean;

  loadLocalDataStats: () => Promise<void>;
  /** 清理指定分类（logs / icon_cache），返回释放字节数；完成后自动重新统计 */
  cleanupCategory: (key: 'logs' | 'icon_cache') => Promise<number>;
  loadObserveOptions: () => Promise<void>;
  loadObservability: (filter: ObserveFilter) => Promise<void>;
  loadCallLogs: (filter: ObserveFilter, limit?: number) => Promise<CallLogRow[]>;
}

export const useStatsStore = create<StatsState>((set) => ({
  localStats: null,
  localStatsLoading: false,
  observeOptions: null,
  observability: null,
  observabilityLoading: false,

  loadLocalDataStats: async () => {
    set({ localStatsLoading: true });
    try {
      const stats = await invoke<LocalDataStats>('get_local_data_stats');
      set({ localStats: stats });
    } catch (err) {
      console.error('Failed to load local data stats:', err);
    } finally {
      set({ localStatsLoading: false });
    }
  },

  cleanupCategory: async (key) => {
    const command = key === 'logs' ? 'cleanup_app_logs' : 'cleanup_icon_cache';
    const freed = await invoke<number>(command);
    // 清理完目录大小变了，刷新统计让数字闭环
    const stats = await invoke<LocalDataStats>('get_local_data_stats');
    set({ localStats: stats });
    return freed;
  },

  loadObserveOptions: async () => {
    try {
      const options = await invoke<ObserveOptions>('get_llm_observe_options');
      set({ observeOptions: options });
    } catch (err) {
      console.error('Failed to load observe options:', err);
    }
  },

  loadObservability: async (filter) => {
    set({ observabilityLoading: true });
    try {
      const result = await invoke<ObservabilityResult>('get_llm_observability', { filter });
      set({ observability: result });
    } catch (err) {
      console.error('Failed to load LLM observability:', err);
    } finally {
      set({ observabilityLoading: false });
    }
  },

  loadCallLogs: async (filter, limit = 50) => {
    return invoke<CallLogRow[]>('get_llm_call_logs', { filter, limit });
  },
}));
