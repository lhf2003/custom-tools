import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Check, X, Inbox } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';

interface Suggestion {
  id: number;
  suggestion_type: string;
  title: string;
  body: string | null;
  action_payload: string | null;
  status: string;
  created_at: number;
  acted_at: number | null;
  source: string | null;
  due_date: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  error_analysis: '错误分析',
  long_work_break: '休息提醒',
  work_suite: '工作套装',
  context_routine: '情境联动',
  daily_digest: '今日备忘',
  daily_report: '日报',
  auto_executed: '自动执行',
  agent_insight: '贾维斯发现',
  intent_reminder: '备忘提醒',
  manual_edit: '手册修改',
  evolution_cleanup: '经验本整理',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  accepted: '已接受',
  dismissed: '已忽略',
  seen: '已提示',
};

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'accepted', label: '已接受' },
  { key: 'dismissed', label: '已忽略' },
  { key: 'seen', label: '已提示' },
];

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SuggestionCenterProps {
  onBack: () => void;
}

/** 建议中心：贾维斯的建议历史——接受/忽略全程可查，待处理可补操作 */
export function SuggestionCenter({ onBack }: SuggestionCenterProps) {
  const { addToast } = useToastStore();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [filter, setFilter] = useState('all');

  const loadData = useCallback(async () => {
    try {
      const list = await invoke<Suggestion[]>('get_companion_suggestions', {
        status: null,
        limit: 200,
      });
      setSuggestions(list);
    } catch (err) {
      console.error('Failed to load suggestions:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filtered = useMemo(() => {
    if (filter === 'all') return suggestions;
    return suggestions.filter((s) => s.status === filter);
  }, [suggestions, filter]);

  const pendingCount = useMemo(
    () => suggestions.filter((s) => s.status === 'pending').length,
    [suggestions]
  );

  const handleAct = async (id: number) => {
    try {
      await invoke('act_on_companion_suggestion', { id });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '执行失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDismiss = async (id: number) => {
    try {
      await invoke('dismiss_companion_suggestion', { id });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-1 pb-3">
        <button
          onClick={onBack}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          aria-label="返回"
        >
          <ArrowLeft size={15} />
        </button>
        <h2 className="text-white/90 text-sm font-medium">建议中心</h2>
        {pendingCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-brand-primary/20 text-app-brand-primary">
            {pendingCount} 条待处理
          </span>
        )}
      </div>

      {/* 状态筛选 */}
      <div className="flex gap-1 px-1 pb-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded-lg text-xs transition-colors cursor-pointer ${
              filter === f.key
                ? 'bg-white/10 text-white'
                : 'text-white/40 hover:text-white/70'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto space-y-2 px-1 pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-white/30">
            <Inbox size={28} className="mb-2 opacity-50" />
            <p className="text-xs">
              {filter === 'pending' ? '没有待处理的建议' : '还没有建议记录'}
            </p>
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">
                  {TYPE_LABEL[s.suggestion_type] ?? s.suggestion_type}
                </span>
                <span className="text-white/30 text-[10px]">
                  {formatTime(s.created_at)}
                </span>
                <span
                  className={`ml-auto text-[10px] ${
                    s.status === 'pending'
                      ? 'text-amber-400/80'
                      : s.status === 'accepted'
                        ? 'text-emerald-400/70'
                        : 'text-white/30'
                  }`}
                >
                  {STATUS_LABEL[s.status] ?? s.status}
                  {s.acted_at && s.status !== 'pending' && ` · ${formatTime(s.acted_at)}`}
                </span>
              </div>
              <p className="text-white/85 text-xs font-medium">{s.title}</p>
              {s.body && (
                <p className="text-white/45 text-xs mt-1 whitespace-pre-wrap break-words">
                  {s.body}
                </p>
              )}
              {s.due_date && (
                <p className="text-white/35 text-[10px] mt-1">截止：{s.due_date}</p>
              )}
              {s.status === 'pending' && (
                <div className="flex gap-1.5 mt-2">
                  <button
                    onClick={() => handleAct(s.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-app-brand-primary/20 text-app-brand-primary hover:bg-app-brand-primary/30 transition-colors cursor-pointer"
                  >
                    <Check size={11} />
                    接受
                  </button>
                  <button
                    onClick={() => handleDismiss(s.id)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors cursor-pointer"
                  >
                    <X size={11} />
                    忽略
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
