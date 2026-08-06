import { useState, useEffect } from 'react';
import {
  Command,
  Settings,
  Bot,
  BookOpen,
  History,
  Info,
  Sparkles,
  BarChart3,
  Wrench,
  Store,
} from 'lucide-react';
import { immediateResize } from '@/utils/tauri';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';
import { GeneralSettings } from './tabs/GeneralSettings';
import { ShortcutsSettings } from './tabs/ShortcutsSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { CompanionSettings } from './tabs/CompanionSettings';
import { ToolsSettings } from './tabs/ToolsSettings';
import { StatsSettings } from './tabs/StatsSettings';
import { ManualSettings } from './tabs/ManualSettings';
import { PluginMarketSettings } from './tabs/PluginMarketSettings';
import { ChangelogSettings } from './tabs/ChangelogSettings';
import { AboutSettings } from './tabs/AboutSettings';

const NAV_GROUPS = [
  {
    label: '系统配置',
    items: [
      { id: 'general', name: '通用', icon: Settings },
      { id: 'shortcuts', name: '快捷键', icon: Command },
    ],
  },
  {
    label: 'AI 配置',
    items: [
      { id: 'model', name: '模型', icon: Bot },
      { id: 'tools', name: '工具', icon: Wrench },
      { id: 'companion', name: '陪伴', icon: Sparkles },
      { id: 'observe', name: '观测', icon: BarChart3 }
    ],
  },
  {
    label: '插件',
    items: [{ id: 'plugin-market', name: '插件市场', icon: Store }],
  },
  {
    label: '其他',
    items: [
      { id: 'manual', name: '操作手册', icon: BookOpen },
      { id: 'about', name: '关于我们', icon: Info },
      { id: 'changelog', name: '更新日志', icon: History },
    ],
  },
] as const;

type TabId = (typeof NAV_GROUPS)[number]['items'][number]['id'];

const TAB_CONTENT: Record<TabId, React.ReactNode> = {
  general: <GeneralSettings />,
  shortcuts: <ShortcutsSettings />,
  model: <ModelSettings />,
  tools: <ToolsSettings />,
  companion: <CompanionSettings />,
  observe: <StatsSettings />,
  manual: <ManualSettings />,
  'plugin-market': <PluginMarketSettings />,
  about: <AboutSettings />,
  changelog: <ChangelogSettings />,
};

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>('general');

  useEffect(() => {
    immediateResize(WINDOW_SIZE.SETTINGS.height, WINDOW_SIZE.SETTINGS.width);
  }, []);

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* 分组侧边栏：与内容区同一基座色（#1e1e21），分区靠选中态纱层暗示 */}
      <aside className="w-52 flex flex-col flex-shrink-0">
        <h3 className="text-base font-semibold text-app-text-primary px-3.5 pt-4 pb-2">设置</h3>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="text-xs font-semibold text-app-text-tertiary px-2.5 mt-4 mb-1 first:mt-1">
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
          {TAB_CONTENT[activeTab]}
        </div>
      </div>
    </div>
  );
}
