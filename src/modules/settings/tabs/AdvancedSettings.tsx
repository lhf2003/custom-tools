import { useSettingsStore } from '@/stores/settingsStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';

/** 高级设置：网络等系统级行为 */
export function AdvancedSettings() {
  const { system_proxy_enabled, setSystemProxyEnabled } = useSettingsStore();

  return (
    <>
      <SettingGroup title="网络">
        <SettingRow
          title="系统代理"
          description="应用内网络请求使用系统代理设置"
        >
          <Toggle enabled={system_proxy_enabled} onToggle={setSystemProxyEnabled} />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
