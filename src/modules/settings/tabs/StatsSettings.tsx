import { useEffect } from 'react';
import { useStatsStore } from '@/stores/statsStore';
import { LocalDataSection } from './stats/LocalDataSection';

export function StatsSettings() {
  const loadLocalDataStats = useStatsStore((s) => s.loadLocalDataStats);

  // 进页自动统计一次磁盘占用（之后由「重新统计」与清理动作驱动刷新）
  useEffect(() => {
    loadLocalDataStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="space-y-8">
        <LocalDataSection />
      </div>
    </>
  );
}
