import { useState, useEffect, useRef, useCallback } from 'react';
import { Command, Settings, Palette, Keyboard, RotateCcw, AlertCircle } from 'lucide-react';
import { useSettingsStore, type ShortcutConfig } from '@/stores/settingsStore';

// Safe invoke that only works in Tauri environment
const safeInvoke = async (cmd: string, args?: Record<string, unknown>) => {
  if (typeof window !== 'undefined' && (window as unknown as { __TAURI__?: unknown }).__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  }
  // In browser, just log
  console.log(`[Browser Mode] Would invoke: ${cmd}`, args);
  return Promise.resolve();
  }
  ;

const settingTabs = [
  { id: 'general', name: '通用', icon: Settings },
  { id: 'shortcuts', name: '快捷键', icon: Command },
  { id: 'appearance', name: '外观', icon: Palette },
];

const FIXED_HEIGHT = 500; // 设置页面固定高度

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('shortcuts');

  // 设置固定窗口高度
  useEffect(() => {
    const setFixedHeight = async () => {
      try {
        await safeInvoke('resize_window', { height: FIXED_HEIGHT });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    };

    setFixedHeight();
  }, []);

  return (
    <div className="w-full h-full flex bg-gradient-to-br from-slate-900/90 via-slate-800/85 to-slate-900/90 backdrop-blur-3xl">
      {/* Settings Sidebar */}
      <aside className="w-48 border-r border-white/20 p-4 bg-black/20">
        <h3 className="text-white/60 text-sm font-medium mb-4">偏好设置</h3>
        <div className="space-y-1">
          {settingTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-white/10 text-white'
                    : 'text-white/60 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon size={16} />
                <span>{tab.name}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Settings Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {activeTab === 'shortcuts' && <ShortcutsSettings />}
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'appearance' && <AppearanceSettings />}
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
        <h2 className="text-white text-lg font-medium flex items-center gap-2">
          <span className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center">
            <Keyboard size={16} />
          </span>
          全局快捷键
        </h2>
        <button
          onClick={handleResetAll}
          className="px-3 py-1.5 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/15 transition-colors flex items-center gap-2"
        >
          <RotateCcw size={14} />
          恢复默认
        </button>
      </div>

      {shortcutsLoading ? (
        <div className="text-white/50 text-center py-8">加载中...</div>
      ) : (
        <div className="space-y-3">
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

      <div className="mt-6 p-4 rounded-xl bg-white/5 border border-white/10">
        <p className="text-white/50 text-xs leading-relaxed">
          提示：点击快捷键区域即可编辑。支持 Ctrl、Shift、Alt、Meta 组合键。
          <br />
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
      <div className="glass-panel rounded-xl p-4 border border-blue-500/30 shadow-md">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-white/80 text-sm">{config.name}</p>
            <p className="text-white/40 text-xs mt-1">{config.description}</p>
          </div>
          <KeyRecorder
            value={tempKeys}
            onChange={setTempKeys}
            onSave={handleSave}
            onCancel={onCancel}
          />
        </div>
        {conflict && (
          <div className="mt-3 flex items-center gap-2 text-amber-400 text-xs">
            <AlertCircle size={14} />
            与 "{conflict.name}" 冲突
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="glass-panel rounded-xl p-4 flex items-center gap-4 border border-white/20 shadow-md hover:border-white/30 transition-colors cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex-1">
        <p className="text-white/80 text-sm">{config.name}</p>
        <p className="text-white/40 text-xs mt-1">{config.description}</p>
      </div>
      <div className="flex items-center gap-3">
        <kbd className="px-3 py-1.5 rounded-lg bg-white/10 text-white/80 text-sm font-mono min-w-[120px] text-center">
          {effectiveKeys}
        </kbd>
        {isCustom && (
          <button
            onClick={handleReset}
            className="p-2 rounded-lg text-white/40 hover:text-amber-400 transition-colors"
            title="恢复默认"
          >
            <RotateCcw size={16} />
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

function KeyRecorder({ value, onChange, onSave, onCancel }: KeyRecorderProps) {
  const [currentCombo, setCurrentCombo] = useState<string>('');
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const formatKey = (key: string): string => {
    // 使用映射表或原值
    const mapped = KEY_NAME_MAP[key] || key;
    // 单个大写字母或已映射的特殊键直接返回
    if (mapped.length === 1 || Object.values(KEY_NAME_MAP).includes(mapped)) {
      return mapped;
    }
    // 其他情况首字母大写
    return mapped.charAt(0).toUpperCase() + mapped.slice(1);
  };

  const buildCombo = (e: React.KeyboardEvent): string => {
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
  };

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
        className="px-3 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-400 text-sm font-mono min-w-[150px] text-center outline-none focus:ring-2 focus:ring-blue-500/50 select-none"
      >
        {currentCombo || '按快捷键...'}
      </div>
      <button
        onClick={handleSave}
        disabled={!currentCombo}
        className="px-3 py-1.5 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        保存
      </button>
      <button
        onClick={onCancel}
        className="px-3 py-1.5 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/15 transition-colors"
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
    toggleAlwaysOnTop,
    toggleHideOnBlur,
    setSetting,
  } = useSettingsStore();

  const handleStartupChange = (enabled: boolean) => {
    setSetting('startup_launch', enabled.toString());
  };

  return (
    <>
      <h2 className="text-white text-lg font-medium mb-6 flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-green-500/20 text-green-400 flex items-center justify-center">
          <Settings size={16} />
        </span>
        通用设置
      </h2>

      <div className="space-y-4">
        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">窗口置顶</p>
              <p className="text-white/50 text-xs mt-1">窗口始终显示在最前端</p>
            </div>
            <Toggle enabled={always_on_top} onToggle={toggleAlwaysOnTop} />
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">失去焦点时隐藏</p>
              <p className="text-white/50 text-xs mt-1">点击窗口外部自动隐藏</p>
            </div>
            <Toggle enabled={hide_on_blur} onToggle={toggleHideOnBlur} />
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">开机启动</p>
              <p className="text-white/50 text-xs mt-1">系统启动时自动运行</p>
            </div>
            <Toggle enabled={startup_launch} onToggle={handleStartupChange} />
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">剪贴板历史保存天数</p>
              <p className="text-white/50 text-xs mt-1">超过此天数的历史将被自动清理</p>
            </div>
            <select className="bg-white/15 text-white text-sm rounded-lg px-3 py-2 outline-none cursor-pointer border border-white/20">
              <option>7天</option>
              <option>30天</option>
              <option>90天</option>
              <option>永久</option>
            </select>
          </div>
        </div>
      </div>
    </>
  );
}

// ==================== Appearance Settings ====================

function AppearanceSettings() {
  return (
    <>
      <h2 className="text-white text-lg font-medium mb-6 flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center">
          <Palette size={16} />
        </span>
        外观设置
      </h2>

      <div className="space-y-4">
        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <p className="text-white/90 text-sm mb-3">主题</p>
          <div className="flex gap-2">
            {['浅色', '深色', '跟随系统'].map((theme) => (
              <button
                key={theme}
                className="px-4 py-2 rounded-lg bg-white/15 text-white/90 text-sm hover:bg-white/25 transition-colors border border-white/10"
              >
                {theme}
              </button>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">窗口透明度</p>
              <p className="text-white/50 text-xs mt-1">调整窗口背景透明程度</p>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              defaultValue="90"
              className="w-32 accent-blue-500"
            />
          </div>
        </div>

        <div className="glass-panel rounded-xl p-4 border border-white/20 shadow-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white/90 text-sm">窗口圆角</p>
              <p className="text-white/50 text-xs mt-1">调整窗口边框圆角大小</p>
            </div>
            <input
              type="range"
              min="0"
              max="24"
              defaultValue="16"
              className="w-32 accent-blue-500"
            />
          </div>
        </div>
      </div>
    </>
  );
}

// ==================== Shared Components ====================

interface ToggleProps {
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

function Toggle({ enabled = false, onToggle }: ToggleProps) {
  return (
    <button
      onClick={() => onToggle?.(!enabled)}
      className={`w-11 h-6 rounded-full relative transition-colors cursor-pointer ${
        enabled ? 'bg-blue-500' : 'bg-white/20'
      }`}
    >
      <span
        className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
          enabled ? 'right-1' : 'left-1'
        }`}
      />
    </button>
  );
}
