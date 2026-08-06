import { useSettingsStore } from '@/stores/settingsStore';
import { PageHeader, SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';
import { Check } from 'lucide-react';

const clipboardKeepDaysOptions = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '0', label: '永久' },
];

/* ==================== 主题三卡片 ==================== */

type ThemeMode = 'system' | 'dark' | 'light';

const THEME_OPTIONS: { id: ThemeMode; label: string; description: string }[] = [
  { id: 'system', label: '跟随系统', description: '随 Windows 深浅色自动切换' },
  { id: 'dark', label: '深色', description: '始终使用深色主题' },
  { id: 'light', label: '浅色', description: '始终使用浅色主题' },
];

interface PreviewSideColors {
  titlebar: string;
  sidebar: string;
  content: string;
  text: string;
  border: string;
}

/** 主题预览两侧的固定示意色：预览表达"另一种主题的样子"，不跟随当前主题 */
const PREVIEW_COLORS: Record<'dark' | 'light', PreviewSideColors> = {
  dark: {
    titlebar: '#26262a',
    sidebar: '#26262a',
    content: '#1e1e21',
    text: '#38383e',
    border: 'rgba(255, 255, 255, 0.10)',
  },
  light: {
    titlebar: '#f4f4f5',
    sidebar: '#f4f4f5',
    content: '#fafafa',
    text: '#d4d4d8',
    border: 'rgba(0, 0, 0, 0.08)',
  },
};

/** 预览单侧：titlebar 三点 + 侧栏 + 内容行抽象 */
function MiniSide({ colors }: { colors: PreviewSideColors }) {
  return (
    <div
      className="w-full overflow-hidden rounded-[10px] border"
      style={{ borderColor: colors.border, backgroundColor: colors.content }}
    >
      <div
        className="h-4 flex items-center gap-[3px] px-1.5"
        style={{ backgroundColor: colors.titlebar }}
      >
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
      </div>
      <div className="p-2 flex gap-1.5">
        <div className="w-[34px] h-[46px] rounded" style={{ backgroundColor: colors.sidebar }} />
        <div className="flex-1 flex flex-col gap-[5px]">
          <div className="h-[7px] rounded-sm w-[70%]" style={{ backgroundColor: colors.text }} />
          <div className="h-[7px] rounded-sm" style={{ backgroundColor: colors.text }} />
          <div className="h-[7px] rounded-sm w-[55%]" style={{ backgroundColor: colors.text }} />
          <div className="h-[7px] rounded-sm w-[80%]" style={{ backgroundColor: colors.text }} />
        </div>
      </div>
    </div>
  );
}

/** 主题预览卡片：dark/light 单侧，system 左深右浅分裂示意 */
function ThemeMiniPreview({ variant }: { variant: ThemeMode }) {
  if (variant === 'system') {
    return (
      <div className="flex gap-px">
        <div className="flex-1 min-w-0">
          <MiniSide colors={PREVIEW_COLORS.dark} />
        </div>
        <div className="flex-1 min-w-0">
          <MiniSide colors={PREVIEW_COLORS.light} />
        </div>
      </div>
    );
  }
  return <MiniSide colors={variant === 'dark' ? PREVIEW_COLORS.dark : PREVIEW_COLORS.light} />;
}

function ThemeSelector() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const current = (THEME_OPTIONS.some((o) => o.id === theme) ? theme : 'system') as ThemeMode;

  return (
    <div className="flex gap-3 px-3 pb-1">
      {THEME_OPTIONS.map((option) => {
        const selected = current === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => setTheme(option.id)}
            aria-pressed={selected}
            className={`flex-1 min-w-0 flex flex-col items-center gap-2 rounded-lg border p-3 pt-2.5 transition-colors cursor-pointer ${
              selected
                ? 'border-app-brand-primary bg-app-brand-primary/10'
                : 'border-transparent hover:bg-app-bg-hover'
            }`}
          >
            <ThemeMiniPreview variant={option.id} />
            <span
              className={`text-xs font-medium flex items-center gap-1 ${
                selected ? 'text-app-brand-primary-light' : 'text-app-text-secondary'
              }`}
            >
              {option.label}
              {selected && <Check size={12} strokeWidth={3} />}
            </span>
            <span className="text-[10px] text-app-text-tertiary leading-tight text-center">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ==================== 通用设置页 ==================== */

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
      <PageHeader title="通用" description="启动、窗口、外观与剪贴板" />

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

      <SettingGroup title="外观">
        <ThemeSelector />
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
