import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Clock,
  Eraser,
  MapPin,
  Wifi,
  Network,
  X,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useAppStore } from '@/stores/appStore';
import { confirmDialog } from '@/stores/confirmStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';
import { MemoryCenter } from './MemoryCenter';
import { SuggestionCenter } from './SuggestionCenter';
import { EvolutionGovernance } from './EvolutionGovernance';

/** 贾维斯认下的场所（CASE-003：fingerprint 原文只在本机展示，不进 LLM 上下文） */
interface CompanionPlace {
  fingerprint: string;
  name: string;
  created_at: number;
}

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

  const [places, setPlaces] = useState<CompanionPlace[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [subView, setSubView] = useState<'main' | 'memory' | 'suggestions' | 'governance'>('main');

  const loadData = useCallback(async () => {
    try {
      const placeList = await invoke<CompanionPlace[]>('list_companion_places');
      setPlaces(placeList);
    } catch (err) {
      console.error('Failed to load companion data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
    const ok = await confirmDialog({
      title: '清空采集数据',
      message: '确定要清空全部采集的活动数据吗？',
      detail: '此操作不可恢复。',
      danger: true,
      confirmLabel: '清空',
    });
    if (!ok) return;
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

  const handleDeletePlace = async (place: CompanionPlace) => {
    const ok = await confirmDialog({
      title: `删除场所「${place.name}」`,
      message: '删除后贾维斯将不再认识这个地方（下次你常去，他会重新学习）。',
      danger: true,
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await invoke('delete_companion_place', { fingerprint: place.fingerprint });
      setPlaces((prev) => prev.filter((p) => p.fingerprint !== place.fingerprint));
      addToast({ type: 'success', title: `已删除场所「${place.name}」` });
    } catch (err) {
      addToast({
        type: 'error',
        title: '删除失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleOpenMemos = () => {
    useAppStore.getState().openPluginView('memo');
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
      <SettingGroup title="基础">
        <SettingRow title="启用陪伴" description="后台采集窗口活动并生成主动建议">
          <Toggle enabled={companion_enabled} onToggle={setCompanionEnabled} />
        </SettingRow>

        <SettingRow
          title="暂停采集"
          description="临时停止记录窗口活动（已收集的数据保留）"
        >
          <Toggle enabled={companion_paused} onToggle={setCompanionPaused} />
        </SettingRow>

        <SettingRow title="数据保留时长" description="活动数据超过保留期后自动清理">
          <CustomSelect
            value={String(companion_retention_days)}
            onChange={(v) => setCompanionRetentionDays(Number(v))}
            options={retentionOptions}
            className="min-w-[100px]"
          />
        </SettingRow>

        <SettingRow
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
        </SettingRow>

        <SettingRow
          title="日报"
          description="每晚 21 点生成昨日工作日报写入笔记，由「场景模型」配置生成"
        >
          <button
            onClick={handleRunAgent}
            disabled={agentRunning || !companion_enabled || !companion_daily_report}
            className="px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {agentRunning ? '生成中…' : '立即生成'}
          </button>
          <Toggle enabled={companion_daily_report} onToggle={setCompanionDailyReport} />
        </SettingRow>

        <SettingRow
          title="内心独白"
          description="聊天时贾维斯偶尔说出灰字「小声嘀咕」的真实想法；关闭后回答只剩正文"
        >
          <Toggle enabled={companion_monologue} onToggle={setCompanionMonologue} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="数据与洞察">
        <SettingRow
          title="我的备忘"
          description="启动器输入「记 xxx」回车记录；在备忘插件中查看打理，随日报一起沉淀"
        >
          <button
            onClick={handleOpenMemos}
            className="px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            打开备忘
          </button>
        </SettingRow>

        <SettingRow
          title="记忆中心"
          description="贾维斯记住的事与学到的习惯模式——分组查看、编辑、删除，变更有审计"
        >
          <button
            onClick={() => setSubView('memory')}
            className="px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            打开记忆中心
          </button>
        </SettingRow>

        <SettingRow
          title="建议中心"
          description="贾维斯的建议历史——接受/忽略全程可查，待处理可补操作"
        >
          <button
            onClick={() => setSubView('suggestions')}
            className="px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            打开建议中心
          </button>
        </SettingRow>

        <SettingRow
          title="进化治理"
          description="手册在线编辑（保存即快照）、经验本容量整理、版本备份一键回滚"
        >
          <button
            onClick={() => setSubView('governance')}
            className="px-2.5 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            打开进化治理
          </button>
        </SettingRow>
      </SettingGroup>

      {/* 场所感知：贾维斯认下的地方（添加全靠聊天/主动询问，这里只能看和删） */}
      {companion_enabled && (
        <div className="mb-8">
          <h3 className="text-xs font-semibold text-app-text-tertiary px-3 mb-1.5">场所感知</h3>
          <div className="px-3">
            <section>
              <div className="flex items-center gap-2 mb-2">
                <MapPin size={13} className="text-app-text-tertiary" />
                <span className="text-app-text-tertiary text-xs font-medium">他认识的场所</span>
              </div>
              {places.length === 0 ? (
                <p className="text-app-text-disabled text-xs">
                  还没有认下的场所——聊天时告诉他「我到家了」，他就会记住；
                  同一个地方待上几天，他也会自己开口问
                </p>
              ) : (
                <div className="space-y-1.5">
                  {places.map((p) => (
                    <div key={p.fingerprint} className="flex items-center gap-2 text-xs">
                      {p.fingerprint.startsWith('ssid:') ? (
                        <Wifi size={12} className="text-app-text-tertiary shrink-0" />
                      ) : (
                        <Network size={12} className="text-app-text-tertiary shrink-0" />
                      )}
                      <span className="text-app-text-secondary font-medium">{p.name}</span>
                      <span className="text-app-text-disabled flex-1 truncate">
                        {p.fingerprint.replace(/^(ssid|gwmac):/, '')}
                      </span>
                      <span className="text-app-text-tertiary tabular-nums">
                        {new Date(p.created_at * 1000).toLocaleDateString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                        })}
                      </span>
                      <button
                        onClick={() => handleDeletePlace(p)}
                        className="p-1 rounded text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
                        title="删除场所"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      <SettingGroup title="危险区">
        <SettingRow
          title="清空采集数据"
          description="删除全部窗口活动记录（不影响剪贴板历史）"
        >
          <button
            onClick={handleClearData}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-app-status-error-text text-xs hover:bg-app-status-error/10 transition-colors cursor-pointer"
          >
            <Eraser size={12} />
            清空
          </button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
