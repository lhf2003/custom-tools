import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import { useExternalPluginsStore } from '@/stores/externalPluginsStore';
import { useToastStore } from '@/stores/toastStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { ExpandableSettingRow } from '../components/ExpandableSettingRow';
import { CustomSelect } from '../components/CustomSelect';
import { DEFAULT_TARGET_LANG, TARGET_LANG_KEY, TARGET_LANG_OPTIONS } from '@/modules/translate/constants';
import { MemorySettingsPanel } from '@/modules/memory/MemorySettingsPanel';
import {
  isBuiltInPluginEnabled,
  listPlugins,
  loadBuiltInPluginStates,
  setBuiltInPluginEnabled,
} from '@/plugins/registry';

const clipboardKeepDaysOptions = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '0', label: '永久' },
];

/** 内置插件 id → 全局快捷键 id（禁用插件时联动禁用快捷键并释放组合键；反之为恢复） */
const BUILTIN_SHORTCUT_MAP: Record<string, string> = {
  clipboard: 'open_clipboard',
  markdown: 'open_notes',
  password: 'open_passwords',
  everything: 'open_everything',
  translate: 'translate_selection',
};

/* ==================== 各插件的行内设置面板 ==================== */

/** 剪贴板：双击自动粘贴 + 历史保存天数 */
function ClipboardSettingsPanel() {
  const {
    clipboard_keep_days,
    clipboard_auto_paste,
    setClipboardKeepDays,
    toggleClipboardAutoPaste,
  } = useSettingsStore();

  return (
    <div className="divide-y divide-app-border-subtle">
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
    </div>
  );
}

/** 划词翻译：默认目标语言（翻译视图下拉与其共用同一 KV） */
function TranslateSettingsPanel() {
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG);
  useEffect(() => {
    invoke<string | null>('get_setting', { key: TARGET_LANG_KEY })
      .then((v) => {
        if (v) setTargetLang(v);
      })
      .catch(() => {});
  }, []);

  return (
    <SettingRow title="目标语言" description="划词翻译的默认目标语言（翻译视图下拉可临时切换）">
      <CustomSelect
        value={targetLang}
        options={TARGET_LANG_OPTIONS.map((lang) => ({ value: lang, label: lang }))}
        onChange={(value) => {
          setTargetLang(value);
          invoke('set_setting', { key: TARGET_LANG_KEY, value }).catch((e: unknown) => {
            alert(`设置目标语言失败: ${e}`);
          });
        }}
        placeholder="目标语言"
        className="w-24"
        menuClassName="w-28"
      />
    </SettingRow>
  );
}

/** 内置插件 id → 行内设置面板（缺省的插件展开显示「暂无可配置项」占位） */
const BUILTIN_SETTINGS_PANELS: Record<string, React.ComponentType> = {
  clipboard: ClipboardSettingsPanel,
  translate: TranslateSettingsPanel,
  memory: MemorySettingsPanel,
};

/* ==================== 系统插件设置页 ==================== */

export function BuiltinSettings() {
  const { addToast } = useToastStore();
  // 内置插件开关的本地镜像（初始化/加载后刷新；切换时同步）
  const [builtInEnabled, setBuiltInEnabled] = useState<Record<string, boolean>>({});
  // 内置插件 = 注册表 − 外部扫描结果（注册表只含启用的外部插件，
  // 扫描结果含全部外部插件，差集恰好是内置；依赖 items 让刷新后重算）
  const externalItems = useExternalPluginsStore((s) => s.items);

  // 内置插件状态：内存集加载后刷新本地镜像（listPlugins 含外部已注册项，仅内置行消费）
  useEffect(() => {
    loadBuiltInPluginStates()
      .catch((err: unknown) => {
        console.error('[plugins] 内置插件状态加载失败:', err);
      })
      .finally(() => {
        setBuiltInEnabled(
          Object.fromEntries(listPlugins().map((p) => [p.id, isBuiltInPluginEnabled(p.id)]))
        );
      });
  }, []);

  const builtInPlugins = useMemo(() => {
    const externalIds = new Set(externalItems.map((it) => it.manifest.id));
    return listPlugins().filter((p) => !externalIds.has(p.id));
  }, [externalItems]);

  /**
   * 内置插件开关：落盘 builtin.<id>.enabled → 同步注册表内存集 → 本地镜像 →
   * 联动全局快捷键（保留用户自定义键位，仅强制 enabled 与插件一致；reregister 在 update_shortcut 内部）。
   */
  const handleBuiltInToggle = useCallback(async (pluginId: string, pluginName: string, enabled: boolean) => {
    try {
      await invoke('set_setting', {
        key: `builtin.${pluginId}.enabled`,
        value: enabled ? '1' : '0',
      });
      setBuiltInPluginEnabled(pluginId, enabled);
      setBuiltInEnabled((s) => ({ ...s, [pluginId]: enabled }));
      const shortcutId = BUILTIN_SHORTCUT_MAP[pluginId];
      if (shortcutId) {
        const shortcuts = await invoke<{ id: string; custom_keys: string | null }[]>('get_shortcuts');
        const current = shortcuts.find((s) => s.id === shortcutId);
        await invoke('update_shortcut', {
          id: shortcutId,
          customKeys: current?.custom_keys ?? null,
          enabled,
        });
      }
      addToast({ type: 'success', title: enabled ? `已启用「${pluginName}」` : `已禁用「${pluginName}」` });
    } catch (err) {
      addToast({ type: 'error', title: '设置失败', message: String(err) });
    }
  }, [addToast]);

  return (
    /* 系统插件：系统能力，支持开关；禁用联动其全局快捷键（释放组合键）；
       essential 插件常驻不可禁用；每行点击展开行内设置（无配置项显示占位文案） */
    <SettingGroup title="系统插件">
      {builtInPlugins.map((plugin) => {
        const Panel = BUILTIN_SETTINGS_PANELS[plugin.id];
        return (
          <ExpandableSettingRow
            key={plugin.id}
            title={plugin.name}
            description={plugin.description}
            controls={
              plugin.essential ? (
                <span className="text-xs text-app-text-disabled">系统必需</span>
              ) : (
                <Toggle
                  enabled={builtInEnabled[plugin.id] ?? true}
                  onToggle={(v) => handleBuiltInToggle(plugin.id, plugin.name, v)}
                />
              )
            }
          >
            {Panel ? <Panel /> : undefined}
          </ExpandableSettingRow>
        );
      })}
    </SettingGroup>
  );
}
