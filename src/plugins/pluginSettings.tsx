import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SettingRow, Toggle } from '@/modules/settings/components/SettingsPrimitives';
import { CustomSelect, type SelectOption } from '@/modules/settings/components/CustomSelect';
import type { ExternalPluginManifest } from './external';

/**
 * 设置贡献点：外部插件 plugin.json 的声明式 settings schema → 主应用自动渲染表单。
 * 二期设计裁决 6：schema 渲染为主，renderSettings 仅协议位（二期不实现自绘挂载）。
 * 存储：settings 表 KV `plugins.<id>.<key>`；toggle 存 '1'/'0'，其余存字符串。
 * 控件复用主应用设计系统原语（SettingRow/Toggle/CustomSelect），变更即持久化。
 */

type SettingSchemaItem = ExternalPluginManifest['settings'][number];

/** 输入框统一样式（对齐 CustomSelect 触发按钮：tertiary 底 + border + 焦点蓝圈） */
const INPUT_CLASS =
  'w-56 px-3 py-1.5 rounded-lg text-sm bg-app-bg-tertiary border border-app-border text-app-text-primary ' +
  'placeholder:text-app-text-placeholder outline-none focus:border-app-status-info focus:ring-2 focus:ring-app-status-info/20 ' +
  'transition-all duration-200';

interface PluginSettingsFormProps {
  pluginId: string;
  schema: SettingSchemaItem[];
}

export function PluginSettingsForm({ pluginId, schema }: PluginSettingsFormProps) {
  // 当前值统一用 string 承载（settings 表 KV 本身就是 string；toggle 为 '1'/'0'）
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded: Record<string, string> = {};
      for (const item of schema) {
        const stored = await invoke<string | null>('get_setting', {
          key: `plugins.${pluginId}.${item.key}`,
        }).catch(() => null);
        if (cancelled) return;
        // 未存储回退 default；toggle 默认 '0'
        loaded[item.key] = stored ?? item.default ?? (item.type === 'toggle' ? '0' : '');
      }
      setValues(loaded);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, schema]);

  const update = useCallback(
    (key: string, value: string) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      invoke('set_setting', { key: `plugins.${pluginId}.${key}`, value }).catch((err: unknown) => {
        console.error(`[plugins] 插件「${pluginId}」设置「${key}」写入失败:`, err);
      });
    },
    [pluginId]
  );

  if (loading) {
    return <div className="py-3 text-xs text-app-text-tertiary">加载插件设置…</div>;
  }

  const toSelectOptions = (item: SettingSchemaItem): SelectOption[] =>
    (item.options ?? []).map((value) => ({ value, label: value }));

  return (
    <div>
      {schema.map((item) => (
        <SettingRow key={item.key} title={item.label}>
          {item.type === 'toggle' ? (
            <Toggle enabled={values[item.key] === '1'} onToggle={(v) => update(item.key, v ? '1' : '0')} />
          ) : item.type === 'select' ? (
            <div className="w-56">
              <CustomSelect
                value={values[item.key]}
                options={toSelectOptions(item)}
                placeholder={item.placeholder ?? '请选择'}
                onChange={(v) => update(item.key, v)}
              />
            </div>
          ) : (
            <input
              type={item.type === 'number' ? 'number' : 'text'}
              className={INPUT_CLASS}
              value={values[item.key]}
              placeholder={item.placeholder}
              onChange={(e) => update(item.key, e.target.value)}
            />
          )}
        </SettingRow>
      ))}
    </div>
  );
}
