import { type CSSProperties } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';
import { Check, LayoutGrid, List } from 'lucide-react';

const clipboardKeepDaysOptions = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '0', label: '永久' },
];

/* ==================== 主题卡片 ==================== */

type ThemeMode = 'system' | 'dark' | 'light' | 'orange-sea';

const THEME_OPTIONS: { id: ThemeMode; label: string; description: string }[] = [
  { id: 'system', label: '跟随系统', description: '随 Windows 深浅色自动切换' },
  { id: 'dark', label: '深色', description: '始终使用深色主题' },
  { id: 'light', label: '浅色', description: '始终使用浅色主题' },
  { id: 'orange-sea', label: '橘子海', description: '暮色海面渐变 · 深色族' },
];

interface PreviewSideColors {
  titlebar: string;
  sidebar: string;
  /** 纯色或渐变（橘子海为海面渐变） */
  content: string;
  text: string;
  border: string;
}

/** 主题预览的固定示意色：预览表达"该主题的样子"，不跟随当前主题 */
const PREVIEW_COLORS: Record<Exclude<ThemeMode, 'system'>, PreviewSideColors> = {
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
    content: '#ffffff',
    text: '#d4d4d8',
    border: 'rgba(0, 0, 0, 0.08)',
  },
  'orange-sea': {
    titlebar: 'rgba(26, 32, 36, 0.92)',
    sidebar: 'rgba(33, 40, 44, 0.92)',
    content: 'linear-gradient(180deg, #4d3828 0%, #33403c 46%, #1b3a45 100%)',
    text: '#a9ada7',
    border: 'rgba(251, 146, 60, 0.35)',
  },
};

/** 预览单侧：titlebar 三点 + 侧栏 + 内容行抽象 */
function MiniSide({ colors }: { colors: PreviewSideColors }) {
  return (
    <div
      className="w-full overflow-hidden rounded-[10px] border"
      style={{ borderColor: colors.border, background: colors.content }}
    >
      <div
        className="h-4 flex items-center gap-[3px] px-1.5"
        style={{ background: colors.titlebar }}
      >
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
      </div>
      <div className="p-2 flex gap-1.5">
        <div className="w-[34px] h-[46px] rounded" style={{ background: colors.sidebar }} />
        <div className="flex-1 flex flex-col gap-[5px]">
          <div className="h-[7px] rounded-sm w-[70%]" style={{ background: colors.text }} />
          <div className="h-[7px] rounded-sm" style={{ background: colors.text }} />
          <div className="h-[7px] rounded-sm w-[55%]" style={{ background: colors.text }} />
          <div className="h-[7px] rounded-sm w-[80%]" style={{ background: colors.text }} />
        </div>
      </div>
    </div>
  );
}

/** 主题预览卡片：dark/light/orange-sea 单侧，system 左深右浅分裂示意 */
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
  return <MiniSide colors={PREVIEW_COLORS[variant]} />;
}

/** 面板背景透明度滑杆：写 --app-panel-alpha（ThemeController 应用），0.4~1.0 */
function PanelAlphaSlider() {
  const panelAlpha = useSettingsStore((s) => s.panel_alpha);
  const setPanelAlpha = useSettingsStore((s) => s.setPanelAlpha);
  // 轨道填充百分比：值域 0.4~1.0 映射 0~100%，经 --range-fill 驱动（见 index.css 滑杆块）
  const fillPct = ((panelAlpha - 0.4) / 0.6) * 100;

  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0.4}
        max={1}
        step={0.01}
        value={panelAlpha}
        onChange={(e) => setPanelAlpha(Number(e.target.value))}
        className="w-32"
        style={{ '--range-fill': `${fillPct}%` } as CSSProperties}
        aria-label="面板背景不透明度"
        aria-valuetext={`${Math.round(panelAlpha * 100)}%`}
      />
      <span className="range-readout w-10 text-xs text-app-text-secondary tabular-nums text-right transition-colors duration-150">
        {Math.round(panelAlpha * 100)}%
      </span>
    </div>
  );
}

/** 启动器视图两段切换：横向网格 / 列表 */
function LauncherViewSwitch() {
  const launcherView = useSettingsStore((s) => s.launcher_view);
  const setLauncherView = useSettingsStore((s) => s.setLauncherView);

  const options = [
    { id: 'grid', label: '网格', icon: LayoutGrid },
    { id: 'list', label: '列表', icon: List },
  ] as const;

  return (
    <div className="flex gap-0.5 p-0.5 rounded-lg bg-app-bg-tertiary border border-app-border-subtle">
      {options.map((opt) => {
        const active = launcherView === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => setLauncherView(opt.id)}
            aria-pressed={active}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
              active
                ? 'bg-app-bg-elevated text-app-text-primary font-medium'
                : 'text-app-text-tertiary hover:text-app-text-secondary'
            }`}
          >
            <Icon size={13} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ThemeSelector() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const current = (THEME_OPTIONS.some((o) => o.id === theme) ? theme : 'system') as ThemeMode;

  return (
    <div className="flex gap-3 p-3">
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
        <SettingRow title="背景透明度" description="数值越低越透出桌面与主题渐变">
          <PanelAlphaSlider />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="外观">
        <SettingRow title="启动器视图" description="搜索结果的排列方式：横向网格或纵向列表">
          <LauncherViewSwitch />
        </SettingRow>
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
