import { useState, useEffect } from 'react';
import { RotateCcw, AlertCircle } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { useSettingsStore, type ShortcutConfig } from '@/stores/settingsStore';
import { KeyRecorder } from '../components/KeyRecorder';
import { PageHeader } from '../components/SettingsPrimitives';

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
      <PageHeader
        title="快捷键"
        description="自定义全局快捷操作"
        actions={
          <Tooltip content="恢复默认" placement="bottom">
            <button
              onClick={handleResetAll}
              className="px-3 py-1.5 rounded-lg text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <RotateCcw size={13} />
              恢复默认
            </button>
          </Tooltip>
        }
      />

      {shortcutsLoading ? (
        <div className="text-app-text-disabled text-center py-12">
          <div className="inline-block w-6 h-6 border-2 border-white/20 border-t-app-brand-primary-light rounded-full animate-spin mb-3" />
          <p className="text-sm">加载中...</p>
        </div>
      ) : (
        <div>
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

      <p className="mt-5 px-3 text-app-text-tertiary text-xs leading-relaxed">
        点击快捷键区域即可编辑，支持 Ctrl、Shift、Alt、Meta 组合键，修改后立即生效。
      </p>
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
      <div className="rounded-lg px-3 py-2.5 bg-white/5">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-app-text-primary text-sm font-medium">{config.name}</p>
            <p className="text-app-text-tertiary text-xs mt-0.5">{config.description}</p>
          </div>
          <KeyRecorder
            onSave={handleSave}
            onCancel={onCancel}
          />
        </div>
        {conflict && (
          <div className="mt-3 flex items-center gap-2 text-app-status-warning text-xs bg-app-status-warning/10 px-3 py-2 rounded-lg">
            <AlertCircle size={14} />
            与 "{conflict.name}" 冲突
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="group rounded-lg px-3 py-2.5 flex items-center gap-4 hover:bg-white/5 transition-colors cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex-1 min-w-0">
        <p className="text-app-text-primary text-sm font-medium">{config.name}</p>
        <p className="text-app-text-tertiary text-xs mt-0.5">{config.description}</p>
      </div>
      <div className="flex items-center gap-2">
        <kbd className="px-3 py-1 rounded-md bg-app-bg-elevated border border-white/10 text-app-text-secondary text-xs font-mono min-w-[96px] text-center group-hover:text-app-text-primary transition-colors">
          {effectiveKeys}
        </kbd>
        {isCustom && (
          <Tooltip content="恢复默认" placement="top">
            <button
              onClick={handleReset}
              className="p-1.5 rounded-lg text-app-text-disabled hover:text-app-status-warning hover:bg-app-status-warning/10 transition-colors cursor-pointer"
            >
              <RotateCcw size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
