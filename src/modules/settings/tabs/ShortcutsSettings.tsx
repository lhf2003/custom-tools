import { useState, useEffect } from 'react';
import { Keyboard, RotateCcw, AlertCircle } from 'lucide-react';
import { useSettingsStore, type ShortcutConfig } from '@/stores/settingsStore';
import { KeyRecorder } from '../components/KeyRecorder';

export function ShortcutsSettings() {
  const { shortcuts, shortcutsLoading, loadShortcuts, resetAllShortcuts } = useSettingsStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    loadShortcuts();
  }, [loadShortcuts]);

  const getEffectiveKeys = (config: ShortcutConfig) => config.custom_keys || config.default_keys;
  const hasCustom = (config: ShortcutConfig) =>
    config.custom_keys !== null && config.custom_keys !== config.default_keys;

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
        <p className="text-white/80 text-sm font-medium group-hover:text-white transition-colors">
          {config.name}
        </p>
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
