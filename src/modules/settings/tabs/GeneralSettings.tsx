import { useSettingsStore } from '@/stores/settingsStore';
import { PageHeader, SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
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
      <PageHeader title="通用" description="启动、窗口行为与剪贴板" />

      <SettingGroup title="启动">
        <SettingRow title="开机启动" description="登录 Windows 后自动运行 FlowHub">
          <Toggle enabled={startup_launch} onToggle={setStartupLaunch} />
        </SettingRow>
        <SettingRow title="自动更新" description="启动时自动检查并下载最新版本">
          <Toggle enabled={auto_update} onToggle={setAutoUpdate} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="窗口">
        <SettingRow title="窗口置顶" description="窗口始终显示在最前端">
          <Toggle enabled={always_on_top} onToggle={toggleAlwaysOnTop} />
        </SettingRow>
        <SettingRow title="失去焦点时隐藏" description="点击窗口外部自动隐藏，保持桌面整洁">
          <Toggle enabled={hide_on_blur} onToggle={toggleHideOnBlur} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="剪贴板">
        <SettingRow
          title="双击自动粘贴"
          description="双击剪贴板历史项后自动粘贴到光标所在位置"
        >
          <Toggle enabled={clipboard_auto_paste} onToggle={toggleClipboardAutoPaste} />
        </SettingRow>
        <SettingRow title="历史保存天数" description="超过此天数的历史将被自动清理（0=永久保存）">
          <CustomSelect
            value={String(clipboard_keep_days)}
            onChange={(v) => setClipboardKeepDays(Number(v))}
            options={clipboardKeepDaysOptions}
            className="min-w-[100px]"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="系统">
        <SettingRow
          title="调试模式"
          description="写入 debug 级日志（含模型调用的系统提示词），位于 %LOCALAPPDATA%\com.flowhub.app\logs"
        >
          <Toggle enabled={debug_mode} onToggle={toggleDebugMode} />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
