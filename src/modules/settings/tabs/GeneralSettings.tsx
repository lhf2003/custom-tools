import { Settings } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingCard, Toggle } from '../components/SettingCard';

export function GeneralSettings() {
  const {
    always_on_top,
    hide_on_blur,
    startup_launch,
    clipboard_keep_days,
    auto_update,
    clipboard_auto_paste,
    toggleAlwaysOnTop,
    toggleHideOnBlur,
    setStartupLaunch,
    setClipboardKeepDays,
    setAutoUpdate,
    toggleClipboardAutoPaste,
  } = useSettingsStore();

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500/30 to-green-600/20 flex items-center justify-center">
          <Settings size={20} className="text-green-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">通用设置</h2>
          <p className="text-white/40 text-xs">基础功能配置</p>
        </div>
      </div>

      <div className="space-y-3">
        <SettingCard title="窗口置顶" description="窗口始终显示在最前端">
          <Toggle enabled={always_on_top} onToggle={toggleAlwaysOnTop} />
        </SettingCard>

        <SettingCard title="失去焦点时隐藏" description="点击窗口外部自动隐藏">
          <Toggle enabled={hide_on_blur} onToggle={toggleHideOnBlur} />
        </SettingCard>

        <SettingCard title="开机启动" description="系统启动时自动运行">
          <Toggle enabled={startup_launch} onToggle={setStartupLaunch} />
        </SettingCard>

        <SettingCard
          title="剪贴板自动粘贴"
          description="双击剪贴板历史项后自动粘贴到光标所在位置"
        >
          <Toggle enabled={clipboard_auto_paste} onToggle={toggleClipboardAutoPaste} />
        </SettingCard>

        <SettingCard
          title="剪贴板历史保存天数"
          description="超过此天数的历史将被自动清理（0=永久保存）"
        >
          <select
            value={clipboard_keep_days}
            onChange={(e) => setClipboardKeepDays(parseInt(e.target.value))}
            className="bg-zinc-700 text-white text-sm rounded-lg px-3 py-2 outline-none cursor-pointer border border-zinc-600 hover:border-zinc-500 transition-colors appearance-none min-w-[100px]"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 8px center',
              backgroundSize: '16px',
              paddingRight: '32px',
            }}
          >
            <option value={7} className="bg-zinc-700 text-white">7天</option>
            <option value={30} className="bg-zinc-700 text-white">30天</option>
            <option value={90} className="bg-zinc-700 text-white">90天</option>
            <option value={0} className="bg-zinc-700 text-white">永久</option>
          </select>
        </SettingCard>

        <SettingCard title="自动更新" description="启动时自动检查并下载最新版本">
          <Toggle enabled={auto_update} onToggle={setAutoUpdate} />
        </SettingCard>
      </div>
    </>
  );
}
