import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { safeInvoke } from '@/utils/tauri';
import { SettingCard } from '../components/SettingCard';

export function SearchSettings() {
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    safeInvoke('get_custom_scan_dirs')
      .then((result) => setDirs((result as string[]) ?? []))
      .catch(() => setDirs([]))
      .finally(() => setLoading(false));
  }, []);

  const save = async (newDirs: string[]) => {
    const prev = dirs;
    setDirs(newDirs);
    try {
      await safeInvoke('set_custom_scan_dirs', { dirs: newDirs });
    } catch (e) {
      console.error('Failed to save custom dirs:', e);
      setDirs(prev);
    }
  };

  const addDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string' && !dirs.includes(selected)) {
        await save([...dirs, selected]);
      }
    } catch (e) {
      console.error('Failed to open directory picker:', e);
    }
  };

  const removeDir = (dir: string) => save(dirs.filter((d) => d !== dir));

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500/30 to-green-600/20 flex items-center justify-center">
          <Search size={20} className="text-green-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">搜索设置</h2>
          <p className="text-white/40 text-xs">配置额外的应用扫描目录</p>
        </div>
      </div>

      <div className="space-y-3">
        <SettingCard title="注册表应用" description="自动扫描已安装软件（绿色软件）">
          <span className="text-xs text-green-400 font-medium">已启用</span>
        </SettingCard>

        <SettingCard title="Microsoft Store 应用" description="自动扫描 UWP 应用">
          <span className="text-xs text-green-400 font-medium">已启用</span>
        </SettingCard>

        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-white/90 text-sm font-medium">自定义扫描目录</p>
              <p className="text-white/40 text-xs mt-0.5">添加包含 .lnk 快捷方式的自定义目录</p>
            </div>
            <button
              onClick={addDir}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer ${
                loading
                  ? 'bg-white/5 text-white/30 cursor-not-allowed'
                  : 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-400'
              }`}
            >
              + 添加目录
            </button>
          </div>

          {loading ? (
            <p className="text-white/30 text-xs">加载中...</p>
          ) : dirs.length === 0 ? (
            <p className="text-white/30 text-xs">暂无自定义目录</p>
          ) : (
            <div className="space-y-2">
              {dirs.map((dir) => (
                <div
                  key={dir}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5"
                >
                  <span className="text-white/70 text-xs truncate flex-1" title={dir}>
                    {dir}
                  </span>
                  <button
                    onClick={() => removeDir(dir)}
                    className="text-white/30 hover:text-red-400 transition-colors text-xs cursor-pointer flex-shrink-0"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
