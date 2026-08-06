import { Store } from 'lucide-react';
import { PageHeader } from '../components/SettingsPrimitives';

export function PluginMarketSettings() {
  return (
    <>
      <PageHeader title="插件市场" description="发现与安装插件" />

      <div className="border border-dashed border-white/15 rounded-[10px] px-6 py-14 text-center">
        <Store size={30} className="mx-auto mb-3 text-app-text-disabled" />
        <p className="text-sm font-medium text-app-text-secondary mb-2">插件市场即将推出</p>
        <p className="text-xs text-app-text-tertiary leading-relaxed max-w-[400px] mx-auto">
          插件系统正在规划中：每个插件通过清单文件注册自己的能力与配置项，
          安装后会在左侧导航「插件」组下获得独立的设置页面。
        </p>
      </div>
    </>
  );
}
