import { useState, useEffect, useRef, useCallback } from 'react';
import { Command, Settings, Palette, Keyboard, RotateCcw, AlertCircle, BookOpen, Command as CommandIcon, Search } from 'lucide-react';
import { BUILT_IN_TOOLS } from '../../constants/tools';
import { useSettingsStore, type ShortcutConfig } from '@/stores/settingsStore';
import { safeInvoke } from '@/utils/tauri';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';

const settingTabs = [
  { id: 'general', name: '通用', icon: Settings },
  { id: 'shortcuts', name: '快捷键', icon: Command },
  { id: 'appearance', name: '外观', icon: Palette },
  { id: 'search', name: '搜索', icon: Search },
  { id: 'manual', name: '操作手册', icon: BookOpen },
];

// ==================== Shared Components ====================

interface SettingCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

function SettingCard({ title, description, children }: SettingCardProps) {
  return (
    <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02] hover:border-white/15 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-white/90 text-sm font-medium">{title}</p>
          {description && (
            <p className="text-white/40 text-xs mt-0.5">{description}</p>
          )}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    </div>
  );
}

interface ToggleProps {
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

function Toggle({ enabled = false, onToggle }: ToggleProps) {
  return (
    <button
      onClick={() => onToggle?.(!enabled)}
      className={`relative w-12 h-7 rounded-full transition-colors duration-200 cursor-pointer ${
        enabled ? 'bg-blue-500' : 'bg-zinc-600 hover:bg-zinc-500'
      }`}
    >
      <span
        className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('shortcuts');

  // 设置固定窗口高度
  useEffect(() => {
    const setFixedHeight = async () => {
      try {
        await safeInvoke('resize_window', { height: WINDOW_SIZE.SETTINGS.height });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    };

    setFixedHeight();
  }, []);

  return (
    <div
      className="w-full h-full flex"
      style={{ backgroundColor: THEME.BG_PRIMARY }}
    >
      {/* Settings Sidebar */}
      <aside className="w-40 border-r border-white/10 p-3 flex flex-col flex-shrink-0">
        <h3 className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-4 px-3">
          偏好设置
        </h3>
        <div className="space-y-1">
          {settingTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
                  isActive
                    ? 'bg-white/15 text-white shadow-sm'
                    : 'text-white/60 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon
                  size={18}
                  className={`transition-colors ${isActive ? 'text-blue-400' : 'text-white/40'}`}
                />
                <span className="font-medium">{tab.name}</span>
                {isActive && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />
                )}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Settings Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-3xl">
          {activeTab === 'shortcuts' && <ShortcutsSettings />}
          {activeTab === 'general' && <GeneralSettings />}
          {activeTab === 'appearance' && <AppearanceSettings />}
          {activeTab === 'search' && <SearchSettings />}
          {activeTab === 'manual' && <ManualSettings />}
        </div>
      </div>
    </div>
  );
}

// ==================== Shortcuts Settings ====================

function ShortcutsSettings() {
  const { shortcuts, shortcutsLoading, loadShortcuts, resetAllShortcuts } = useSettingsStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ id: string; name: string } | null>(null);

  // 加载快捷键配置
  useEffect(() => {
    loadShortcuts();
  }, [loadShortcuts]);

  // 获取生效的快捷键显示
  const getEffectiveKeys = (config: ShortcutConfig) => {
    return config.custom_keys || config.default_keys;
  };

  // 检查是否有自定义
  const hasCustom = (config: ShortcutConfig) => {
    return config.custom_keys !== null && config.custom_keys !== config.default_keys;
  };

  const handleResetAll = async () => {
    if (confirm('确定要重置所有快捷键为默认值吗？')) {
      try {
        await resetAllShortcuts();
      } catch (err) {
        console.error('Failed to reset all shortcuts:', err);
      }
    }
  };

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-blue-600/20 flex items-center justify-center">
            <Keyboard size={20} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-white text-lg font-semibold">全局快捷键</h2>
            <p className="text-white/40 text-xs">自定义您的快捷操作</p>
          </div>
        </div>
        <button
          onClick={handleResetAll}
          className="px-4 py-2 rounded-lg bg-white/5 text-white/60 text-sm hover:bg-white/10 hover:text-white transition-all duration-200 flex items-center gap-2 cursor-pointer border border-white/10"
        >
          <RotateCcw size={14} />
          恢复默认
        </button>
      </div>

      {shortcutsLoading ? (
        <div className="text-white/40 text-center py-12">
          <div className="inline-block w-6 h-6 border-2 border-white/20 border-t-blue-400 rounded-full animate-spin mb-3" />
          <p className="text-sm">加载中...</p>
        </div>
      ) : (
        <div className="space-y-2">
          {shortcuts.map((shortcut) => (
            <ShortcutItem
              key={shortcut.id}
              config={shortcut}
              effectiveKeys={getEffectiveKeys(shortcut)}
              isCustom={hasCustom(shortcut)}
              isEditing={editingId === shortcut.id}
              conflict={conflictInfo?.id === shortcut.id ? conflictInfo : null}
              onEdit={() => setEditingId(shortcut.id)}
              onCancel={() => {
                setEditingId(null);
                setConflictInfo(null);
              }}
              onConflict={(name) => setConflictInfo({ id: shortcut.id, name })}
              onClearConflict={() => setConflictInfo(null)}
            />
          ))}
        </div>
      )}

      <div className="mt-6 p-4 rounded-xl bg-blue-500/5 border border-blue-500/20">
        <p className="text-blue-200/60 text-xs leading-relaxed">
          💡 提示：点击快捷键区域即可编辑。支持 Ctrl、Shift、Alt、Meta 组合键。
          修改后系统快捷键会立即生效。
        </p>
      </div>
    </>
  );
}

interface ShortcutItemProps {
  config: ShortcutConfig;
  effectiveKeys: string;
  isCustom: boolean;
  isEditing: boolean;
  conflict: { id: string; name: string } | null;
  onEdit: () => void;
  onCancel: () => void;
  onConflict: (name: string) => void;
  onClearConflict: () => void;
}

function ShortcutItem({
  config,
  effectiveKeys,
  isCustom,
  isEditing,
  conflict,
  onEdit,
  onCancel,
  onConflict,
  onClearConflict,
}: ShortcutItemProps) {
  const { updateShortcut, resetShortcut, checkShortcutConflict } = useSettingsStore();
  const [isRecording, setIsRecording] = useState(false);
  const [tempKeys, setTempKeys] = useState(effectiveKeys);

  const handleReset = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await resetShortcut(config.id);
    } catch (err) {
      console.error('Failed to reset shortcut:', err);
    }
  };

  const handleSave = async (keys: string) => {
    try {
      // 检查冲突
      const conflictConfig = await checkShortcutConflict(keys, config.id);
      if (conflictConfig) {
        onConflict(conflictConfig.name);
        return;
      }

      await updateShortcut(config.id, keys === config.default_keys ? null : keys, true);
      onCancel();
      onClearConflict();
    } catch (err) {
      console.error('Failed to save shortcut:', err);
    }
  };

  if (isEditing) {
    return (
      <div className="rounded-xl p-4 border border-blue-500/40 bg-blue-500/5">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-white/90 text-sm font-medium">{config.name}</p>
            <p className="text-white/40 text-xs mt-0.5">{config.description}</p>
          </div>
          <KeyRecorder
            value={tempKeys}
            onChange={setTempKeys}
            onSave={handleSave}
            onCancel={onCancel}
          />
        </div>
        {conflict && (
          <div className="mt-3 flex items-center gap-2 text-amber-400 text-xs bg-amber-500/10 px-3 py-2 rounded-lg">
            <AlertCircle size={14} />
            与 "{conflict.name}" 冲突
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="group rounded-xl p-4 flex items-center gap-4 border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 transition-all duration-200 cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/80 text-sm font-medium group-hover:text-white transition-colors">{config.name}</p>
        <p className="text-white/40 text-xs mt-0.5">{config.description}</p>
      </div>
      <div className="flex items-center gap-2">
        <kbd className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/70 text-sm font-mono min-w-[100px] text-center group-hover:bg-white/10 group-hover:text-white transition-all">
          {effectiveKeys}
        </kbd>
        {isCustom && (
          <button
            onClick={handleReset}
            className="p-2 rounded-lg text-white/30 hover:text-amber-400 hover:bg-amber-400/10 transition-all cursor-pointer"
            title="恢复默认"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

interface KeyRecorderProps {
  value: string;
  onChange: (keys: string) => void;
  onSave: (keys: string) => void;
  onCancel: () => void;
}

// 键名映射表
const KEY_NAME_MAP: Record<string, string> = {
  'Control': 'Ctrl',
  ' ': 'Space',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
};

function formatKey(key: string): string {
  const mapped = KEY_NAME_MAP[key] || key;
  if (mapped.length === 1 || Object.values(KEY_NAME_MAP).includes(mapped)) {
    return mapped;
  }
  return mapped.charAt(0).toUpperCase() + mapped.slice(1);
}

function buildCombo(e: React.KeyboardEvent): string {
  const parts: string[] = [];

  // 修饰键顺序：Ctrl -> Shift -> Alt -> Meta
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');

  // 主键（如果不是纯修饰键）
  const mainKey = formatKey(e.key);
  if (!['Ctrl', 'Shift', 'Alt', 'Meta'].includes(mainKey)) {
    parts.push(mainKey);
  }

  return parts.join('+');
}

function KeyRecorder({ value, onChange, onSave, onCancel }: KeyRecorderProps) {
  const [currentCombo, setCurrentCombo] = useState<string>('');
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 忽略单独的修饰键（只记录组合）
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        // 但显示当前按下的修饰键状态
        const combo = buildCombo(e);
        setCurrentCombo(combo);
        return;
      }

      // 记录完整组合键
      const combo = buildCombo(e);
      setCurrentCombo(combo);
    },
    []
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 如果所有键都释放了，清除显示
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        setCurrentCombo('');
      } else {
        // 还有修饰键被按住，更新显示
        const combo = buildCombo(e);
        setCurrentCombo(combo);
      }
    },
    []
  );

  const handleSave = () => {
    if (currentCombo) {
      onSave(currentCombo);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        className="px-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm font-mono min-w-[140px] text-center outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-blue-500/20 select-none cursor-pointer"
      >
        {currentCombo || '按快捷键...'}
      </div>
      <button
        onClick={handleSave}
        disabled={!currentCombo}
        className="px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        保存
      </button>
      <button
        onClick={onCancel}
        className="px-4 py-2 rounded-lg bg-white/5 text-white/60 text-sm hover:bg-white/10 hover:text-white transition-all duration-200 cursor-pointer border border-white/10"
      >
        取消
      </button>
    </div>
  );
}

// ==================== General Settings ====================

function GeneralSettings() {
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

  const handleStartupChange = (enabled: boolean) => {
    setStartupLaunch(enabled);
  };

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
        <SettingCard
          title="窗口置顶"
          description="窗口始终显示在最前端"
        >
          <Toggle enabled={always_on_top} onToggle={toggleAlwaysOnTop} />
        </SettingCard>

        <SettingCard
          title="失去焦点时隐藏"
          description="点击窗口外部自动隐藏"
        >
          <Toggle enabled={hide_on_blur} onToggle={toggleHideOnBlur} />
        </SettingCard>

        <SettingCard
          title="开机启动"
          description="系统启动时自动运行"
        >
          <Toggle enabled={startup_launch} onToggle={handleStartupChange} />
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
              paddingRight: '32px'
            }}
          >
            <option value={7} className="bg-zinc-700 text-white">7天</option>
            <option value={30} className="bg-zinc-700 text-white">30天</option>
            <option value={90} className="bg-zinc-700 text-white">90天</option>
            <option value={0} className="bg-zinc-700 text-white">永久</option>
          </select>
        </SettingCard>

        <SettingCard
          title="自动更新"
          description="启动时自动检查并下载最新版本"
        >
          <Toggle enabled={auto_update} onToggle={setAutoUpdate} />
        </SettingCard>
      </div>
    </>
  );
}

// ==================== Appearance Settings ====================

// Maps between UI display labels and the store's theme values
const THEME_LABEL_MAP: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};
const THEME_VALUE_MAP: Record<string, string> = {
  '浅色': 'light',
  '深色': 'dark',
  '跟随系统': 'system',
};

function AppearanceSettings() {
  const { theme, window_opacity, setSetting } = useSettingsStore();

  // Derive display label from store value; default to '跟随系统' for unknown values
  const activeTheme = THEME_LABEL_MAP[theme] ?? '跟随系统';

  const handleThemeChange = (label: string) => {
    const storeValue = THEME_VALUE_MAP[label] ?? 'system';
    setSetting('theme', storeValue);
  };

  // window_opacity is stored as 0–1; slider shows 0–100
  const opacityPercent = Math.round(window_opacity * 100);

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const percent = parseInt(e.target.value, 10);
    setSetting('window_opacity', percent / 100);
  };

  // TODO: 连接到 settingsStore 持久化（store 暂无 window_border_radius 字段）
  const [borderRadius, setBorderRadius] = useState(16);

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/30 to-purple-600/20 flex items-center justify-center">
          <Palette size={20} className="text-purple-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">外观设置</h2>
          <p className="text-white/40 text-xs">个性化您的界面</p>
        </div>
        <span className="ml-auto px-2 py-1 text-[11px] text-white/60 bg-white/10 rounded-md border border-white/10">敬请期待</span>
      </div>

      <div className="space-y-3">
        <SettingCard title="主题" description="选择您喜欢的界面风格">
          <div className="flex gap-2">
            {['浅色', '深色', '跟随系统'].map((label) => (
              <button
                key={label}
                onClick={() => handleThemeChange(label)}
                className={`px-4 py-2 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
                  activeTheme === label
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                    : 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingCard>

        <SettingCard title="窗口透明度" description="调整窗口背景透明程度">
          <div className="flex items-center gap-3">
            <span className="text-white/40 text-xs">0%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={opacityPercent}
              onChange={handleOpacityChange}
              className="w-32 accent-blue-500 cursor-pointer"
            />
            <span className="text-white/40 text-xs">100%</span>
          </div>
        </SettingCard>

        <SettingCard title="窗口圆角" description="调整窗口边框圆角大小">
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-3 opacity-40">
              <span className="text-white/40 text-xs">0px</span>
              <input
                type="range"
                min="0"
                max="24"
                value={borderRadius}
                onChange={(e) => setBorderRadius(parseInt(e.target.value, 10))}
                className="w-32 accent-blue-500 cursor-not-allowed"
                disabled
              />
              <span className="text-white/40 text-xs">24px</span>
            </div>
            <span className="text-white/30 text-xs">暂未开放</span>
          </div>
        </SettingCard>
      </div>
    </>
  );
}

// ==================== Manual Settings ====================

function ManualSettings() {
  const toolsWithDescription = BUILT_IN_TOOLS.filter(
    (tool): tool is typeof tool & { description: string } => tool.description !== undefined,
  );

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500/30 to-orange-600/20 flex items-center justify-center">
          <BookOpen size={20} className="text-orange-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">操作手册</h2>
          <p className="text-white/40 text-xs">快速上手本系统的使用方法</p>
        </div>
      </div>

      {/* 内置工具介绍 */}
      <div className="mb-8">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-blue-500 rounded-full" />
          内置工具
        </h3>
        <div className="space-y-3">
          {toolsWithDescription.map((tool) => {
            const Icon = tool.icon;
            return (
              <div
                key={tool.id}
                className="rounded-xl p-4 border border-white/10 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04] transition-all"
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg ${tool.color} flex items-center justify-center flex-shrink-0`}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-white/90 text-sm font-medium">{tool.name}</h4>
                    <p className="text-white/50 text-xs mt-1 leading-relaxed">{tool.description}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 搜索框使用方法 */}
      <div className="mb-8">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-green-500 rounded-full" />
          搜索框使用
        </h3>
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <Search className="w-4 h-4 text-white/60" />
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">应用搜索</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索框中输入应用名称，系统会实时显示匹配的程序。支持模糊搜索，无需输入完整名称。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <CommandIcon className="w-4 h-4 text-white/60" />
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">快速启动内置工具</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  输入"剪贴板"、"笔记"、"密码"等关键词可直接启动对应工具。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <span className="text-white/60 text-xs font-mono">Ctrl+V</span>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">粘贴文件/图片</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索框中粘贴文件或图片，系统会自动处理：文件可直接打开，图片会保存到剪贴板历史。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 快捷键使用 */}
      <div className="mb-6">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-purple-500 rounded-full" />
          快捷键绑定
        </h3>
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <kbd className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70 text-xs font-mono">
                  Alt+Space
                </kbd>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">显示/隐藏窗口</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  全局快捷键，在任何界面按下即可快速呼出或隐藏本工具。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <kbd className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70 text-xs font-mono">
                  Esc
                </kbd>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">返回/关闭</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在各功能页面按 Esc 键可返回主界面或关闭当前窗口。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <kbd className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70 text-xs font-mono">
                  ↑ ↓
                </kbd>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">上下选择</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索结果或列表中使用方向键快速切换选中项，按 Enter 确认。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 提示信息 */}
      <div className="p-4 rounded-xl bg-blue-500/5 border border-blue-500/20">
        <p className="text-blue-200/60 text-xs leading-relaxed">
          💡 提示：您可以在"快捷键"设置页自定义全局快捷键，在"通用"设置中调整窗口行为（如置顶、失焦隐藏等）。
        </p>
      </div>
    </>
  );
}

// ==================== Search Settings ====================

function SearchSettings() {
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
      setDirs(prev); // rollback
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

        {/* Custom Directories */}
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
