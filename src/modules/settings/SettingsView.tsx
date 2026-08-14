import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Command,
  Settings,
  Bot,
  BookOpen,
  Info,
  Sparkles,
  BarChart3,
  Wrench,
  Store,
  Package,
  SlidersHorizontal,
  AppWindow,
  Clipboard,
  Plug,
  GraduationCap,
} from 'lucide-react';
import { immediateResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { useExternalPluginsStore } from '@/stores/externalPluginsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { createExternalIconComponent } from '@/plugins/external';
import { GeneralSettings } from './tabs/GeneralSettings';
import { BuiltinSettings } from './tabs/BuiltinSettings';
import { AppsSettings } from './tabs/AppsSettings';
import { ShortcutsSettings } from './tabs/ShortcutsSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { CompanionSettings } from './tabs/CompanionSettings';
import { ToolsSettings } from './tabs/ToolsSettings';
import { McpSettings } from './tabs/McpSettings';
import { SkillSettings } from './tabs/SkillSettings';
import { StatsSettings } from './tabs/StatsSettings';
import { AdvancedSettings } from './tabs/AdvancedSettings';
import { ManualSettings } from './tabs/ManualSettings';
import { PluginMarketSettings } from './tabs/PluginMarketSettings';
import { PluginSettingsTab } from './tabs/PluginSettingsTab';
import { AboutSettings } from './tabs/AboutSettings';

/** 插件设置 tab id 前缀：`plugin-settings:<pluginId>`，随外部插件安装/卸载动态增减 */
const PLUGIN_SETTINGS_TAB_PREFIX = 'plugin-settings:';

/** 侧边导航图标：Lucide 或外部插件的 img 图标组件（external.tsx，接口兼容 className/size） */
type NavIcon = React.ComponentType<{ className?: string; size?: number | string }>;

interface NavItem {
  id: string;
  name: string;
  icon: NavIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const SYSTEM_NAV_GROUP: NavGroup = {
  label: '系统',
  items: [
    { id: 'general', name: '通用', icon: Settings },
    { id: 'builtin', name: '内置功能', icon: Clipboard },
    { id: 'apps', name: '应用', icon: AppWindow },
    { id: 'shortcuts', name: '快捷键', icon: Command },
    { id: 'stats', name: '统计', icon: BarChart3 },
    { id: 'advanced', name: '高级', icon: SlidersHorizontal }
  ],
};

const AI_NAV_GROUP: NavGroup = {
  label: 'AI',
  items: [
    { id: 'model', name: '模型', icon: Bot },
    { id: 'tools', name: '工具', icon: Wrench },
    { id: 'mcp', name: 'MCP', icon: Plug },
    { id: 'skill', name: 'SKILL', icon: GraduationCap },
    { id: 'companion', name: '陪伴', icon: Sparkles },
  ],
};

const MISC_NAV_GROUP: NavGroup = {
  label: '其他',
  items: [
    { id: 'manual', name: '操作手册', icon: BookOpen },
    { id: 'about', name: '关于我们', icon: Info },
  ],
};

/** 固定 tab 内容（插件市场/插件设置/操作手册需回调 prop，走动态渲染，不在此表） */
const STATIC_TAB_CONTENT: Record<string, React.ReactNode> = {
  general: <GeneralSettings />,
  builtin: <BuiltinSettings />,
  apps: <AppsSettings />,
  shortcuts: <ShortcutsSettings />,
  model: <ModelSettings />,
  tools: <ToolsSettings />,
  mcp: <McpSettings />,
  skill: <SkillSettings />,
  companion: <CompanionSettings />,
  stats: <StatsSettings />,
  advanced: <AdvancedSettings />,
  about: <AboutSettings />,
};

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('general');
  const externalPlugins = useExternalPluginsStore((s) => s.items);
  const refreshExternal = useExternalPluginsStore((s) => s.refresh);
  // 未知应用提醒深链：store 里有待处理的搜索预填 → 切到「应用」tab（AppsSettings 挂载时消费）
  const appsTabQuery = useSettingsStore((s) => s.appsTabQuery);
  // 通用深链：外部模块（聊天视觉门槛等）请求直达某个 tab，消费后清除
  const pendingTab = useSettingsStore((s) => s.pendingTab);

  useEffect(() => {
    immediateResize(WINDOW_SIZE.SETTINGS.height, WINDOW_SIZE.SETTINGS.width);
  }, []);

  useEffect(() => {
    if (appsTabQuery) {
      setActiveTab('apps');
    }
  }, [appsTabQuery]);

  useEffect(() => {
    if (pendingTab) {
      setActiveTab(pendingTab);
      useSettingsStore.getState().setPendingTab(null);
    }
  }, [pendingTab]);

  // 打开设置即扫描外部插件（侧边导航的数据源；市场页的启用/安装/卸载经同一 store 回流）
  useEffect(() => {
    refreshExternal().catch((err: unknown) => {
      console.error('[settings] 外部插件扫描失败:', err);
    });
  }, [refreshExternal]);

  const openPluginSettings = useCallback(
    (pluginId: string) => setActiveTab(`${PLUGIN_SETTINGS_TAB_PREFIX}${pluginId}`),
    []
  );

  // 「插件」分组：插件市场 + 每个声明了 settings schema 的外部插件一个设置 tab
  // （未启用也显示——配置先落盘，启用后生效）
  const pluginNavGroup: NavGroup = useMemo(
    () => ({
      label: '插件',
      items: [
        { id: 'plugin-market', name: '插件市场', icon: Store },
        ...externalPlugins
          .filter((item) => item.manifest.settings.length > 0)
          .map((item) => ({
            id: `${PLUGIN_SETTINGS_TAB_PREFIX}${item.manifest.id}`,
            name: item.manifest.name,
            icon: item.manifest.icon
              ? createExternalIconComponent(item.dirPath, item.manifest.icon)
              : Package,
          })),
      ],
    }),
    [externalPlugins]
  );

  const navGroups = useMemo(
    () => [SYSTEM_NAV_GROUP, AI_NAV_GROUP, pluginNavGroup, MISC_NAV_GROUP],
    [pluginNavGroup]
  );

  let content: React.ReactNode;
  if (activeTab.startsWith(PLUGIN_SETTINGS_TAB_PREFIX)) {
    const pluginId = activeTab.slice(PLUGIN_SETTINGS_TAB_PREFIX.length);
    const item = externalPlugins.find((it) => it.manifest.id === pluginId);
    // 插件被卸载后 tab 消失，内容回退插件市场
    content = item ? (
      <PluginSettingsTab item={item} />
    ) : (
      <PluginMarketSettings onOpenPluginSettings={openPluginSettings} />
    );
  } else if (activeTab === 'plugin-market') {
    content = <PluginMarketSettings onOpenPluginSettings={openPluginSettings} />;
  } else if (activeTab === 'manual') {
    // 操作手册内含「前往快捷键」等 tab 跳转入口
    content = <ManualSettings onNavigateTab={setActiveTab} />;
  } else {
    content = STATIC_TAB_CONTENT[activeTab] ?? STATIC_TAB_CONTENT.general;
  }

  return (
    <div className="w-full h-full flex panel-glass">
      {/* 分组侧边栏：与内容区同一基座色（#1e1e21），分区靠选中态纱层暗示 */}
      <aside className="w-44 flex flex-col flex-shrink-0">
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {navGroups.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex === 0 ? 'mt-1' : 'mt-4'}>
              <div className="text-xs font-semibold text-app-text-tertiary px-2.5 mb-1">
                {group.label}
              </div>
              {group.items.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 mb-0.5 rounded-lg text-sm transition-colors duration-150 cursor-pointer ${
                      isActive
                        ? 'bg-white/10 text-app-text-primary font-medium'
                        : 'text-app-text-secondary hover:bg-white/5 hover:text-app-text-primary'
                    }`}
                  >
                    <Icon
                      size={16}
                      className={`flex-shrink-0 transition-colors ${
                        isActive ? 'text-app-brand-primary-light' : 'text-app-text-tertiary'
                      }`}
                    />
                    <span className="flex-1 text-left truncate">{tab.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* 内容区：切换时 200ms 淡入（opacity 过渡，reduced-motion 安全） */}
      <div className="flex-1 overflow-y-auto">
        <div key={activeTab} className="px-7 py-6 animate-fade-in">
          {content}
        </div>
      </div>
    </div>
  );
}
