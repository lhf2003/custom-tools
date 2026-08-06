import { useState, useEffect } from 'react';
import { safeInvoke } from '@/utils/tauri';
import { PageHeader, SettingGroup, SettingRow } from '../components/SettingsPrimitives';

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
      <PageHeader title="搜索" description="配置启动器的应用索引来源" />

      <SettingGroup title="索引来源">
        <SettingRow title="注册表应用" description="自动扫描已安装软件（绿色软件）">
          <span className="flex items-center gap-1.5 text-xs text-app-text-tertiary">
            <span className="w-1.5 h-1.5 rounded-full bg-app-status-success" />
            已启用
          </span>
        </SettingRow>
        <SettingRow title="Microsoft Store 应用" description="自动扫描 UWP 应用">
          <span className="flex items-center gap-1.5 text-xs text-app-text-tertiary">
            <span className="w-1.5 h-1.5 rounded-full bg-app-status-success" />
            已启用
          </span>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="自定义扫描目录">
        <SettingRow title="扫描目录" description="添加包含 .lnk 快捷方式的自定义目录">
          <button
            onClick={addDir}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors cursor-pointer ${
              loading
                ? 'text-app-text-disabled cursor-not-allowed'
                : 'text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary'
            }`}
          >
            + 添加目录
          </button>
        </SettingRow>

        {loading ? (
          <p className="px-3 py-2 text-app-text-disabled text-xs">加载中...</p>
        ) : dirs.length === 0 ? (
          <p className="px-3 py-2 text-app-text-disabled text-xs">暂无自定义目录</p>
        ) : (
          dirs.map((dir) => (
            <div
              key={dir}
              className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
            >
              <span
                className="text-app-text-secondary text-xs truncate flex-1 font-mono"
                title={dir}
              >
                {dir}
              </span>
              <button
                onClick={() => removeDir(dir)}
                className="text-app-text-disabled hover:text-app-status-error-text transition-colors text-xs cursor-pointer flex-shrink-0 opacity-0 group-hover:opacity-100"
              >
                删除
              </button>
            </div>
          ))
        )}
      </SettingGroup>
    </>
  );
}
