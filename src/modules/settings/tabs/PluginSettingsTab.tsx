import { SettingGroup } from '../components/SettingsPrimitives';
import { PluginSettingsForm } from '@/plugins/pluginSettings';
import type { ExternalPluginItem } from '@/stores/externalPluginsStore';

/**
 * 单个外部插件的独立设置 tab：设置页「插件」分组下随插件安装动态出现
 * （未启用也显示——配置先落盘，启用后生效）。表单为 plugin.json 声明式
 * schema 的自动渲染（pluginSettings.tsx，KV 存 plugins.<id>.<key>）。
 */
export function PluginSettingsTab({ item }: { item: ExternalPluginItem }) {
  const { manifest, enabled } = item;
  return (
    <SettingGroup title={`${manifest.name} · v${manifest.version}`}>
      {manifest.description && (
        <div className="px-3 py-2.5 text-xs text-app-text-tertiary leading-relaxed">
          {manifest.description}
        </div>
      )}
      {!enabled && (
        <div className="px-3 py-2.5 text-xs text-app-text-disabled leading-relaxed">
          插件当前未启用，此处配置会先保存，启用后生效。
        </div>
      )}
      <PluginSettingsForm pluginId={manifest.id} schema={manifest.settings} />
    </SettingGroup>
  );
}
