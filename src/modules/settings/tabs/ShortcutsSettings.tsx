import { useState, useEffect, useMemo } from 'react';
import { RotateCcw, AlertCircle } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { useSettingsStore, type ShortcutConfig } from '@/stores/settingsStore';
import { useExternalPluginsStore } from '@/stores/externalPluginsStore';
import { useToastStore } from '@/stores/toastStore';
import {
  getPluginShortcutConflicts,
  getPluginShortcutOverride,
  updatePluginShortcut,
} from '@/plugins/pluginShortcuts';
import { KeyRecorder } from '../components/KeyRecorder';
import { SettingGroup } from '../components/SettingsPrimitives';

/** 插件快捷键行（已启用插件的 manifest.shortcuts 展开 + 用户自定义键位覆盖） */
interface PluginShortcutRow {
  pluginId: string;
  pluginName: string;
  shortcutId: string;
  label: string;
  defaultKey: string;
  customKey: string | null;
}

export function ShortcutsSettings() {
  const { shortcuts, shortcutsLoading, loadShortcuts, resetAllShortcuts } = useSettingsStore();
  const { addToast } = useToastStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflictInfo, setConflictInfo] = useState<{ id: string; name: string } | null>(null);

  // 插件快捷键：已启用插件的 manifest.shortcuts（与市场页同一共享 store）
  const pluginItems = useExternalPluginsStore((s) => s.items);
  const refreshPlugins = useExternalPluginsStore((s) => s.refresh);
  /** 自定义键位覆盖：「pluginId.shortcutId」→ keys */
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    loadShortcuts();
  }, [loadShortcuts]);

  // 共享 store 可能尚未扫描（未开过插件市场直接进本页），挂载时保证一次刷新
  useEffect(() => {
    refreshPlugins().catch((err: unknown) => {
      console.error('[shortcuts] 插件列表加载失败:', err);
      addToast({ type: 'error', title: '插件快捷键加载失败', message: String(err) });
    });
  }, [refreshPlugins, addToast]);

  // 读取各插件快捷键的自定义键位覆盖
  useEffect(() => {
    const targets: { pluginId: string; shortcutId: string }[] = [];
    for (const item of pluginItems) {
      if (!item.enabled || item.error) continue;
      for (const sc of item.manifest.shortcuts) {
        targets.push({ pluginId: item.manifest.id, shortcutId: sc.id });
      }
    }
    if (targets.length === 0) {
      setOverrides({});
      return;
    }
    let cancelled = false;
    Promise.all(
      targets.map(({ pluginId, shortcutId }) =>
        getPluginShortcutOverride(pluginId, shortcutId).then(
          (v) => [`${pluginId}.${shortcutId}`, v] as const
        )
      )
    )
      .then((entries) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const [key, value] of entries) {
          if (value !== null) map[key] = value;
        }
        setOverrides(map);
      })
      .catch((err: unknown) => {
        console.error('[shortcuts] 插件快捷键覆盖读取失败:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginItems]);

  const pluginRows = useMemo<PluginShortcutRow[]>(() => {
    const rows: PluginShortcutRow[] = [];
    for (const item of pluginItems) {
      if (!item.enabled || item.error) continue;
      for (const sc of item.manifest.shortcuts) {
        rows.push({
          pluginId: item.manifest.id,
          pluginName: item.manifest.name,
          shortcutId: sc.id,
          label: sc.label,
          defaultKey: sc.key,
          customKey: overrides[`${item.manifest.id}.${sc.id}`] ?? null,
        });
      }
    }
    return rows;
  }, [pluginItems, overrides]);

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
      <SettingGroup
        title="全局快捷键"
        actions={
          <Tooltip content="恢复默认" placement="bottom">
            <button
              onClick={handleResetAll}
              className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <RotateCcw size={13} />
              恢复默认
            </button>
          </Tooltip>
        }
      >
        {shortcutsLoading ? (
          <div className="text-app-text-disabled text-center py-12">
            <div className="inline-block w-6 h-6 border-2 border-white/20 border-t-app-brand-primary-light rounded-full animate-spin mb-3" />
            <p className="text-sm">加载中...</p>
          </div>
        ) : (
          shortcuts.map((shortcut) => (
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
          ))
        )}
      </SettingGroup>

      {/* 插件快捷键：已启用外部插件声明的全局快捷键，支持改键/恢复 manifest 默认 */}
      {pluginRows.length > 0 && (
        <SettingGroup title="插件快捷键">
          {pluginRows.map((row) => {
            const rowId = `plugin.${row.pluginId}.${row.shortcutId}`;
            return (
              <PluginShortcutItem
                key={rowId}
                row={row}
                isEditing={editingId === rowId}
                conflict={conflictInfo?.id === rowId ? conflictInfo : null}
                registerError={
                  getPluginShortcutConflicts(row.pluginId).find((c) => c.shortcut_id === row.shortcutId)
                    ?.reason ?? null
                }
                onEdit={() => setEditingId(rowId)}
                onCancel={() => {
                  setEditingId(null);
                  setConflictInfo(null);
                }}
                onConflict={(name) => setConflictInfo({ id: rowId, name })}
                onClearConflict={() => setConflictInfo(null)}
                onSaved={(customKey) =>
                  setOverrides((prev) => {
                    const next = { ...prev };
                    const key = `${row.pluginId}.${row.shortcutId}`;
                    if (customKey) next[key] = customKey;
                    else delete next[key];
                    return next;
                  })
                }
              />
            );
          })}
        </SettingGroup>
      )}

      <p className="mt-5 px-3 text-app-text-tertiary text-xs leading-relaxed">
        点击快捷键区域即可编辑，支持 Ctrl、Shift、Alt、Meta 组合键，修改后立即生效。
      </p>
    </>
  );
}

interface PluginShortcutItemProps {
  row: PluginShortcutRow;
  isEditing: boolean;
  conflict: { id: string; name: string } | null;
  /** OS 注册失败原因（与内置键位/其他插件占用的冲突在保存前已拦截，此处兜系统级占用） */
  registerError: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onConflict: (name: string) => void;
  onClearConflict: () => void;
  onSaved: (customKey: string | null) => void;
}

function PluginShortcutItem({
  row,
  isEditing,
  conflict,
  registerError,
  onEdit,
  onCancel,
  onConflict,
  onClearConflict,
  onSaved,
}: PluginShortcutItemProps) {
  const { checkShortcutConflict } = useSettingsStore();
  const effectiveKeys = row.customKey ?? row.defaultKey;

  const handleReset = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await updatePluginShortcut(row.pluginId, row.shortcutId, null);
      onSaved(null);
    } catch (err) {
      console.error('Failed to reset plugin shortcut:', err);
    }
  };

  const handleSave = async (keys: string) => {
    try {
      const conflictConfig = await checkShortcutConflict(
        keys,
        `plugin.${row.pluginId}.${row.shortcutId}`
      );
      if (conflictConfig) {
        onConflict(conflictConfig.name);
        return;
      }
      const customKey = keys === row.defaultKey ? null : keys;
      await updatePluginShortcut(row.pluginId, row.shortcutId, customKey);
      onSaved(customKey);
      onCancel();
      onClearConflict();
    } catch (err) {
      console.error('Failed to save plugin shortcut:', err);
    }
  };

  if (isEditing) {
    return (
      <div className="px-3 py-3 bg-white/5">
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-app-text-primary text-sm font-medium">{row.label}</p>
            <p className="text-app-text-tertiary text-xs mt-0.5">{row.pluginName}</p>
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
      className="group px-3 py-3 flex items-center gap-4 hover:bg-white/5 transition-colors cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex-1 min-w-0">
        <p className="text-app-text-primary text-sm font-medium">{row.label}</p>
        <p className="text-app-text-tertiary text-xs mt-0.5">{row.pluginName}</p>
      </div>
      <div className="flex items-center gap-2">
        {registerError && (
          <span className="text-xs text-app-status-error cursor-help" title={registerError}>
            注册失败
          </span>
        )}
        <kbd className="px-3 py-1 rounded-md bg-app-bg-elevated border border-white/10 text-app-text-secondary text-xs font-mono min-w-[96px] text-center group-hover:text-app-text-primary transition-colors">
          {effectiveKeys}
        </kbd>
        {row.customKey && (
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
      <div className="px-3 py-3 bg-white/5">
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
      className="group px-3 py-3 flex items-center gap-4 hover:bg-white/5 transition-colors cursor-pointer"
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
