import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Sparkles,
  Brain,
  Clock,
  Trash2,
  RefreshCw,
  Activity,
  Eraser,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { SettingCard, Toggle } from '../components/SettingCard';
import { CustomSelect } from '../components/CustomSelect';
import { MemoryCenter } from './MemoryCenter';
import { SuggestionCenter } from './SuggestionCenter';
import { EvolutionGovernance } from './EvolutionGovernance';
import { MEMO_VIEW_PATH } from '../../markdown/components/MemosView';
import type { OpenViewDetail } from '@/types';

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

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  dismissed: { text: '已忽略', color: 'text-white/30' },
  learning: { text: '学习中', color: 'text-amber-400' },
  confirmed: { text: '已确认', color: 'text-emerald-400' },
};

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}min`;
  return `${(secs / 3600).toFixed(1)}h`;
}

/** 学习概览各子区默认展示条数，超出「查看全部」inline 展开 */
const PREVIEW_COUNT = 3;

/** 备忘笔记的相对路径（与后端 commands/companion.rs 的 INTENT_NOTE_RELATIVE 对应） */

export function CompanionSettings() {
  const {
    companion_enabled,
    companion_paused,
    companion_retention_days,
    companion_long_work_minutes,
    companion_daily_report,
    companion_monologue,
    setCompanionEnabled,
    setCompanionPaused,
    setCompanionRetentionDays,
    setCompanionLongWorkMinutes,
    setCompanionDailyReport,
    setCompanionMonologue,
  } = useSettingsStore();
  const { addToast } = useToastStore();

  const [todaySummary, setTodaySummary] = useState<[string, number][]>([]);
  const [patterns, setPatterns] = useState<HabitPattern[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [expandPatterns, setExpandPatterns] = useState(false);
  const [subView, setSubView] = useState<'main' | 'memory' | 'suggestions' | 'governance'>('main');

  const loadData = useCallback(async () => {
    try {
      const [summary, patternList] = await Promise.all([
        invoke<[string, number][]>('get_companion_today_summary'),
        invoke<HabitPattern[]>('get_companion_patterns'),
      ]);
      setTodaySummary(summary);
      setPatterns(patternList);
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

  const handleOpenNotes = async () => {
    // 备忘已迁 memos 表（DB 唯一真源）：打开笔记模块的备忘视图而非旧 md 文件
    window.dispatchEvent(
      new CustomEvent<OpenViewDetail>('app:open-view', {
        detail: { view: 'markdown', notePath: MEMO_VIEW_PATH },
      })
    );
  };

  const retentionOptions = [
    { value: '7', label: '7 天' },
    { value: '30', label: '30 天' },
    { value: '90', label: '90 天' },
    { value: '180', label: '180 天' },
  ];

  const longWorkOptions = [
    { value: '45', label: '45 分钟' },
    { value: '60', label: '1 小时' },
    { value: '90', label: '1.5 小时' },
    { value: '120', label: '2 小时' },
    { value: '180', label: '3 小时' },
  ];

  const maxTotal = todaySummary.length > 0 ? todaySummary[0][1] : 1;
  const visiblePatterns = expandPatterns ? patterns : patterns.slice(0, PREVIEW_COUNT);

  // 二级视图：记忆中心 / 建议中心 / 进化治理
  if (subView === 'memory') {
    return <MemoryCenter onBack={() => setSubView('main')} />;
  }
  if (subView === 'suggestions') {
    return <SuggestionCenter onBack={() => setSubView('main')} />;
  }
  if (subView === 'governance') {
    return <EvolutionGovernance onBack={() => setSubView('main')} />;
  }

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-app-brand-primary/30 to-app-brand-primary/20 flex items-center justify-center">
          <Sparkles size={20} className="text-app-brand-primary-light" />
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
          <CustomSelect
            value={String(companion_retention_days)}
            onChange={(v) => setCompanionRetentionDays(Number(v))}
            options={retentionOptions}
            className="min-w-[100px]"
          />
        </SettingCard>

        <SettingCard
          title="长时工作提醒"
          description="同一应用连续使用超过该时长时提醒休息"
        >
          <CustomSelect
            value={String(companion_long_work_minutes)}
            onChange={(v) => setCompanionLongWorkMinutes(Number(v))}
            options={longWorkOptions}
            icon={<Clock size={16} />}
            className="min-w-[100px]"
          />
        </SettingCard>

        <SettingCard
          title="日报"
          description="每晚 21 点生成昨日工作日报写入笔记；AI 模型开启 Claude Code 后用它生成，否则用「场景模型」配置"
        >
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunAgent}
              disabled={agentRunning || !companion_enabled || !companion_daily_report}
              className="px-2.5 py-1.5 rounded-lg bg-blue-500/20 text-blue-300 text-xs border border-blue-500/30 hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50"
            >
              {agentRunning ? '生成中…' : '立即生成'}
            </button>
            <Toggle enabled={companion_daily_report} onToggle={setCompanionDailyReport} />
          </div>
        </SettingCard>

        <SettingCard
          title="内心独白"
          description="聊天时贾维斯偶尔说出灰字「小声嘀咕」的真实想法；关闭后回答只剩正文"
        >
          <Toggle enabled={companion_monologue} onToggle={setCompanionMonologue} />
        </SettingCard>

        <SettingCard
          title="我的备忘"
          description="启动器输入「记 xxx」回车记录；备忘写入笔记，随日报一起沉淀"
        >
          <button
            onClick={handleOpenNotes}
            className="px-2.5 py-1.5 rounded-lg text-white/50 text-xs hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            在笔记中查看
          </button>
        </SettingCard>

        <SettingCard
          title="记忆中心"
          description="贾维斯记住的事——五维分组查看、编辑、删除，变更有审计"
        >
          <button
            onClick={() => setSubView('memory')}
            className="px-2.5 py-1.5 rounded-lg text-white/50 text-xs hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            打开记忆中心
          </button>
        </SettingCard>

        <SettingCard
          title="建议中心"
          description="贾维斯的建议历史——接受/忽略全程可查，待处理可补操作"
        >
          <button
            onClick={() => setSubView('suggestions')}
            className="px-2.5 py-1.5 rounded-lg text-white/50 text-xs hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            打开建议中心
          </button>
        </SettingCard>

        <SettingCard
          title="进化治理"
          description="手册在线编辑（保存即快照）、经验本容量整理、版本备份一键回滚"
        >
          <button
            onClick={() => setSubView('governance')}
            className="px-2.5 py-1.5 rounded-lg text-white/50 text-xs hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            打开进化治理
          </button>
        </SettingCard>

        {/* 学习概览：未启用陪伴时隐藏（没有数据可学） */}
        {companion_enabled && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-5">
            {/* 今日使用 */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <Activity size={13} className="text-white/40" />
                <span className="text-white/50 text-xs font-medium">今日使用</span>
              </div>
              {todaySummary.length === 0 ? (
                <p className="text-white/30 text-xs">今天还没有采集到数据</p>
              ) : (
                <div className="space-y-1.5">
                  {todaySummary.slice(0, PREVIEW_COUNT).map(([proc, secs]) => (
                    <div key={proc} className="flex items-center gap-2 text-xs">
                      <span className="text-white/60 w-32 truncate">{proc}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-app-brand-primary/70"
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
            </section>

            {/* 习惯模式 */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Brain size={13} className="text-white/40" />
                  <span className="text-white/50 text-xs font-medium">学到的习惯模式</span>
                </div>
                <button
                  onClick={handleAnalyzeNow}
                  disabled={analyzing}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/20 text-blue-300 text-xs border border-blue-500/30 hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
                  {analyzing ? '分析中…' : '立即分析'}
                </button>
              </div>
              {patterns.length === 0 ? (
                <p className="text-white/30 text-xs">
                  还没有学到模式——积累一天数据后每晚 21 点自动分析，也可点「立即分析」
                </p>
              ) : (
                <div>
                  {visiblePatterns.map((p) => {
                    const status = STATUS_LABEL[p.status] ?? STATUS_LABEL.learning;
                    return (
                      <div
                        key={p.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-white/5 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-white/80 text-xs truncate" title={p.description}>
                            {p.description}
                          </div>
                          <div className="text-white/30 text-xs mt-0.5">
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
                  {patterns.length > PREVIEW_COUNT && (
                    <button
                      onClick={() => setExpandPatterns(!expandPatterns)}
                      className="mt-1 px-2 text-white/40 hover:text-white/70 text-xs transition-colors cursor-pointer"
                    >
                      {expandPatterns ? '收起' : `查看全部 (${patterns.length})`}
                    </button>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

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
