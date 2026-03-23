import { useState, useEffect } from 'react';
import { Command, Settings, Palette, Keyboard, Search, Bot, BookOpen, History, Info } from 'lucide-react';
import { debouncedResize } from '@/utils/tauri';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';
import { GeneralSettings } from './tabs/GeneralSettings';
import { ShortcutsSettings } from './tabs/ShortcutsSettings';
import { AppearanceSettings } from './tabs/AppearanceSettings';
import { SearchSettings } from './tabs/SearchSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { ManualSettings } from './tabs/ManualSettings';
import { ChangelogSettings } from './tabs/ChangelogSettings';
import { AboutSettings } from './tabs/AboutSettings';

const SETTING_TABS = [
  { id: 'general', name: '通用', icon: Settings },
  { id: 'shortcuts', name: '快捷键', icon: Command },
  { id: 'appearance', name: '外观', icon: Palette },
  { id: 'search', name: '搜索', icon: Search },
  { id: 'model', name: 'AI 模型', icon: Bot },
  { id: 'manual', name: '操作手册', icon: BookOpen },
  { id: 'changelog', name: '更新日志', icon: History },
  { id: 'about', name: '关于我们', icon: Info },
] as const;

type TabId = (typeof SETTING_TABS)[number]['id'];

const TAB_CONTENT: Record<TabId, React.ReactNode> = {
  general: <GeneralSettings />,
  shortcuts: <ShortcutsSettings />,
  appearance: <AppearanceSettings />,
  search: <SearchSettings />,
  model: <ModelSettings />,
  manual: <ManualSettings />,
  changelog: <ChangelogSettings />,
  about: <AboutSettings />,
};

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<TabId>('shortcuts');

  useEffect(() => {
    debouncedResize(WINDOW_SIZE.SETTINGS.height);
  }, []);

  return (
    <div className="w-full h-full flex" style={{ backgroundColor: THEME.BG_PRIMARY }}>
      {/* Sidebar */}
      <aside className="w-40 border-r border-white/10 p-3 flex flex-col flex-shrink-0">
        <h3 className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-4 px-3">
          偏好设置
        </h3>
        <div className="space-y-1">
          {SETTING_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
                  isActive
                    ? 'bg-white/15 text-white shadow-sm'
                    : 'text-white/60 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon
                  size={18}
                  className={`transition-colors ${isActive ? 'text-blue-400' : 'text-white/40'}`}
                />
                <span className="font-medium">{tab.name}</span>
                {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-3xl">{TAB_CONTENT[activeTab]}</div>
      </div>
    </div>
  );
}
