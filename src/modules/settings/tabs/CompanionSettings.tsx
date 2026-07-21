import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Sparkles,
  Brain,
  Clock,
  Trash2,
  RefreshCw,
  History,
  Activity,
  Eraser,
  Bot,
  Pin,
  Check,
  X,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { SettingCard, Toggle } from '../components/SettingCard';

interface HabitPattern {
  id: number;
  pattern_type: string;
  signature: string;
  description: string;
  pattern_data: string;
  confidence: number;
  occurrences: number;
  status: string;
  first_seen: number;
  last_seen: number;
}

interface Suggestion {
  id: number;
  suggestion_type: string;
  title: string;
  body: string | null;
  status: string;
  created_at: number;
  trigger_data?: string | null;
  due_date?: string | null;
  source?: string | null;
}

interface IntentTriggers {
  due?: string | null;
  person?: string | null;
  channel?: string | null;
  keywords?: string[];
}

function parseTriggers(triggerData: string | null | undefined): IntentTriggers | null {
  if (!triggerData) return null;
  try {
    return JSON.parse(triggerData) as IntentTriggers;
  } catch {
    return null;
  }
}

function formatTriggers(t: IntentTriggers | null): string {
  if (!t) return '触发器解析中…';
  const parts: string[] = [];
  if (t.due) parts.push(`📅 ${t.due}`);
  if (t.person) parts.push(`👤 ${t.person}`);
  if (t.channel) parts.push(`💬 ${t.channel}`);
  if (t.keywords && t.keywords.length > 0) parts.push(`🔑 ${t.keywords.join('、')}`);
  return parts.length > 0 ? parts.join('  ') : '仅晨间汇总提醒';
}

const SUGGESTION_TYPE_LABEL: Record<string, string> = {
  error_analysis: '错误分析',
  long_work_break: '休息提醒',
  work_suite: '工作套装',
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending: { text: '待处理', color: 'text-amber-400' },
  accepted: { text: '已接受', color: 'text-emerald-400' },
  dismissed: { text: '已忽略', color: 'text-white/30' },
  learning: { text: '学习中', color: 'text-amber-400' },
  confirmed: { text: '已确认', color: 'text-emerald-400' },
};

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}min`;
  return `${(secs / 3600).toFixed(1)}h`;
}

export function CompanionSettings() {
  const {
    companion_enabled,
    companion_paused,
    companion_retention_days,
    companion_long_work_minutes,
    companion_agent_enabled,
    setCompanionEnabled,
    setCompanionPaused,
    setCompanionRetentionDays,
    setCompanionLongWorkMinutes,
    setCompanionAgentEnabled,
  } = useSettingsStore();
  const { addToast } = useToastStore();

  const [todaySummary, setTodaySummary] = useState<[string, number][]>([]);
  const [patterns, setPatterns] = useState<HabitPattern[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [intents, setIntents] = useState<Suggestion[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [summary, patternList, suggestionList, intentList] = await Promise.all([
        invoke<[string, number][]>('get_companion_today_summary'),
        invoke<HabitPattern[]>('get_companion_patterns'),
        invoke<Suggestion[]>('get_companion_suggestions', { limit: 20 }),
        invoke<Suggestion[]>('get_companion_intents', { limit: 50 }),
      ]);
      setTodaySummary(summary);
      setPatterns(patternList);
      setSuggestions(suggestionList);
      setIntents(intentList);
    } catch (err) {
      console.error('Failed to load companion data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAnalyzeNow = async () => {
    setAnalyzing(true);
    try {
      const result = await invoke<string>('analyze_companion_now');
      addToast({ type: 'success', title: '分析完成', message: result, duration: 5000 });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '分析失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 5000,
      });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRunAgent = async () => {
    setAgentRunning(true);
    try {
      const result = await invoke<string>('run_companion_agent_now');
      addToast({ type: 'success', title: '日报已生成', message: result, duration: 6000 });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '日报 agent 失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 6000,
      });
    } finally {
      setAgentRunning(false);
    }
  };

  const handleClearData = async () => {
    if (!confirm('确定要清空全部采集的活动数据吗？此操作不可恢复。')) return;
    try {
      await invoke('clear_companion_activities');
      addToast({ type: 'success', title: '已清空采集数据' });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '清空失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDismissPattern = async (id: number) => {
    try {
      await invoke('set_companion_pattern_status', { id, status: 'dismissed' });
      await loadData();
    } catch (err) {
      console.error('Failed to dismiss pattern:', err);
    }
  };

  const handleActSuggestion = async (id: number) => {
    try {
      await invoke('act_on_companion_suggestion', { id });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDismissSuggestion = async (id: number) => {
    try {
      await invoke('dismiss_companion_suggestion', { id });
      await loadData();
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    }
  };

  const retentionOptions = [
    { value: 7, label: '7 天' },
    { value: 30, label: '30 天' },
    { value: 90, label: '90 天' },
    { value: 180, label: '180 天' },
  ];

  const longWorkOptions = [
    { value: 45, label: '45 分钟' },
    { value: 60, label: '1 小时' },
    { value: 90, label: '1.5 小时' },
    { value: 120, label: '2 小时' },
    { value: 180, label: '3 小时' },
  ];

  const selectStyle = {
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
    backgroundSize: '16px',
    paddingRight: '32px',
  } as const;

  const maxTotal = todaySummary.length > 0 ? todaySummary[0][1] : 1;

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-violet-600/20 flex items-center justify-center">
          <Sparkles size={20} className="text-violet-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">陪伴</h2>
          <p className="text-white/40 text-xs">学习你的工作习惯，适时给出建议（数据仅存本机）</p>
        </div>
      </div>

      <div className="space-y-3">
        <SettingCard title="启用陪伴" description="后台采集窗口活动并生成主动建议">
          <Toggle enabled={companion_enabled} onToggle={setCompanionEnabled} />
        </SettingCard>

        <SettingCard
          title="暂停采集"
          description="临时停止记录窗口活动（已收集的数据保留）"
        >
          <Toggle enabled={companion_paused} onToggle={setCompanionPaused} />
        </SettingCard>

        <SettingCard title="数据保留时长" description="活动数据超过保留期后自动清理">
          <select
            value={companion_retention_days}
            onChange={(e) => setCompanionRetentionDays(Number(e.target.value))}
            className="bg-zinc-700 text-white text-sm rounded-lg px-3 py-2 outline-none cursor-pointer border border-zinc-600 hover:border-zinc-500 transition-colors appearance-none min-w-[100px]"
            style={selectStyle}
          >
            {retentionOptions.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-zinc-700 text-white">
                {opt.label}
              </option>
            ))}
          </select>
        </SettingCard>

        <SettingCard
          title="长时工作提醒"
          description="同一应用连续使用超过该时长时提醒休息"
        >
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-white/30" />
            <select
              value={companion_long_work_minutes}
              onChange={(e) => setCompanionLongWorkMinutes(Number(e.target.value))}
              className="bg-zinc-700 text-white text-sm rounded-lg px-3 py-2 outline-none cursor-pointer border border-zinc-600 hover:border-zinc-500 transition-colors appearance-none min-w-[100px]"
              style={selectStyle}
            >
              {longWorkOptions.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-zinc-700 text-white">
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </SettingCard>

        <SettingCard
          title="日报 agent（Claude Code）"
          description="每晚 21 点由 Claude agent 自主查询数据并生成日报写入笔记；关闭则使用普通模型分析"
        >
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-white/30" />
            <Toggle enabled={companion_agent_enabled} onToggle={setCompanionAgentEnabled} />
          </div>
        </SettingCard>

        {/* 今日概览 */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={16} className="text-violet-400" />
            <span className="text-white text-sm font-medium">今日使用概览</span>
          </div>
          {todaySummary.length === 0 ? (
            <p className="text-white/30 text-xs">今天还没有采集到数据</p>
          ) : (
            <div className="space-y-1.5">
              {todaySummary.slice(0, 8).map(([proc, secs]) => (
                <div key={proc} className="flex items-center gap-2 text-xs">
                  <span className="text-white/60 w-32 truncate">{proc}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-violet-500/70"
                      style={{ width: `${Math.max(2, (secs / maxTotal) * 100)}%` }}
                    />
                  </div>
                  <span className="text-white/40 w-14 text-right tabular-nums">
                    {formatDuration(secs)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 学习到的模式 */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Brain size={16} className="text-violet-400" />
              <span className="text-white text-sm font-medium">学到的习惯模式</span>
            </div>
            <div className="flex items-center gap-2">
              {companion_agent_enabled && (
                <button
                  onClick={handleRunAgent}
                  disabled={agentRunning || !companion_enabled}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 text-xs border border-blue-500/30 hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Bot size={12} className={agentRunning ? 'animate-pulse' : ''} />
                  {agentRunning ? 'agent 运行中…' : '立即生成日报'}
                </button>
              )}
              <button
                onClick={handleAnalyzeNow}
                disabled={analyzing || !companion_enabled}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-300 text-xs border border-violet-500/30 hover:bg-violet-500/30 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
                {analyzing ? '分析中…' : '立即分析'}
              </button>
            </div>
          </div>
          {patterns.length === 0 ? (
            <p className="text-white/30 text-xs">
              还没有学到模式。积累一天数据后，每晚 21 点自动分析，或点「立即分析」。
            </p>
          ) : (
            <div className="space-y-2">
              {patterns.map((p) => {
                const status = STATUS_LABEL[p.status] ?? STATUS_LABEL.learning;
                return (
                  <div
                    key={p.id}
                    className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-white/80 text-xs">{p.description}</div>
                      <div className="text-white/30 text-xs mt-1">
                        置信度 {Math.round(p.confidence * 100)}% · 观察到 {p.occurrences} 次 ·{' '}
                        <span className={status.color}>{status.text}</span>
                      </div>
                    </div>
                    {p.status !== 'dismissed' && (
                      <button
                        onClick={() => handleDismissPattern(p.id)}
                        className="text-white/30 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                        title="不再使用此模式"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 我的备忘（意图暂存） */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Pin size={16} className="text-violet-400" />
              <span className="text-white text-sm font-medium">我的备忘</span>
            </div>
            <span className="text-white/30 text-xs">启动器输入「记 xxx」回车即可记下</span>
          </div>
          {intents.length === 0 ? (
            <p className="text-white/30 text-xs">
              还没有备忘。试试：Alt+Space → 输入「记 明天在微信与张三对接接口」→ 回车
            </p>
          ) : (
            <div className="space-y-1.5">
              {intents.map((it) => {
                const status = STATUS_LABEL[it.status] ?? STATUS_LABEL.pending;
                const triggers = parseTriggers(it.trigger_data);
                return (
                  <div
                    key={it.id}
                    className={`rounded-lg px-3 py-2 ${
                      it.status === 'pending' ? 'bg-white/5' : 'bg-white/[0.02] opacity-60'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-white/85 text-xs leading-relaxed">{it.body}</div>
                        <div className="text-white/30 text-xs mt-1">
                          {formatTriggers(triggers)} · {formatTime(it.created_at)} ·{' '}
                          <span className={status.color}>{status.text}</span>
                        </div>
                      </div>
                      {it.status === 'pending' && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleActSuggestion(it.id)}
                            className="p-1.5 rounded-md text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                            title="完成"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            onClick={() => handleDismissSuggestion(it.id)}
                            className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer"
                            title="忽略"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 建议历史 */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <History size={16} className="text-violet-400" />
            <span className="text-white text-sm font-medium">建议历史</span>
          </div>
          {suggestions.length === 0 ? (
            <p className="text-white/30 text-xs">还没有收到过建议</p>
          ) : (
            <div className="space-y-1.5">
              {suggestions.map((s) => {
                const status = STATUS_LABEL[s.status] ?? STATUS_LABEL.pending;
                return (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 text-xs rounded-lg bg-white/5 px-3 py-2"
                  >
                    <span className="text-violet-300/70 shrink-0">
                      {SUGGESTION_TYPE_LABEL[s.suggestion_type] ?? s.suggestion_type}
                    </span>
                    <span className="text-white/70 flex-1 truncate">{s.title}</span>
                    <span className="text-white/30 shrink-0 tabular-nums">
                      {formatTime(s.created_at)}
                    </span>
                    <span className={`${status.color} shrink-0`}>{status.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 隐私 */}
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white text-sm font-medium">清空采集数据</div>
              <p className="text-white/40 text-xs mt-1">
                删除全部窗口活动记录（不影响剪贴板历史）
              </p>
            </div>
            <button
              onClick={handleClearData}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/20 text-red-300 text-xs border border-red-500/30 hover:bg-red-500/30 transition-colors cursor-pointer"
            >
              <Eraser size={12} />
              清空
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
