import { useEffect } from 'react';
import { BarChart3 } from 'lucide-react';
import { useStatsStore } from '@/stores/statsStore';
import { LocalDataSection } from './stats/LocalDataSection';
import { LlmObserveSection } from './stats/LlmObserveSection';

export function StatsSettings() {
  const loadLocalDataStats = useStatsStore((s) => s.loadLocalDataStats);

  // 进页自动统计一次磁盘占用（之后由「重新统计」与清理动作驱动刷新）
  useEffect(() => {
    loadLocalDataStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-app-brand-primary/30 to-app-brand-primary/20 flex items-center justify-center">
          <BarChart3 size={20} className="text-app-brand-primary-light" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">统计</h2>
          <p className="text-white/40 text-xs">本地数据空间与模型调用观测</p>
        </div>
      </div>

      <div className="space-y-8">
        <LocalDataSection />
        <LlmObserveSection />
      </div>
    </>
  );
}
