import { Settings } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingCard, Toggle } from '../components/SettingCard';
import { CustomSelect } from '../components/CustomSelect';

const clipboardKeepDaysOptions = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '0', label: '永久' },
];

export function GeneralSettings() {
  const {
    always_on_top,
    hide_on_blur,
    startup_launch,
    clipboard_keep_days,
    auto_update,
    clipboard_auto_paste,
    debug_mode,
    toggleAlwaysOnTop,
    toggleHideOnBlur,
    setStartupLaunch,
    setClipboardKeepDays,
    setAutoUpdate,
    toggleClipboardAutoPaste,
    toggleDebugMode,
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
          <CustomSelect
            value={String(clipboard_keep_days)}
            onChange={(v) => setClipboardKeepDays(Number(v))}
            options={clipboardKeepDaysOptions}
            className="min-w-[100px]"
          />
        </SettingCard>

        <SettingCard title="自动更新" description="启动时自动检查并下载最新版本">
          <Toggle enabled={auto_update} onToggle={setAutoUpdate} />
        </SettingCard>

        <SettingCard
          title="调试模式"
          description="写入 debug 级日志（含模型调用的系统提示词），位于 %LOCALAPPDATA%\com.flowhub.app\logs"
        >
          <Toggle enabled={debug_mode} onToggle={toggleDebugMode} />
        </SettingCard>
      </div>
    </>
  );
}
