import { useEffect, useState } from 'react';
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
  Puzzle,
  SlidersHorizontal,
  AppWindow,
  GraduationCap,
} from 'lucide-react';
import { immediateResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { useExternalPluginsStore } from '@/stores/externalPluginsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { GeneralSettings } from './tabs/GeneralSettings';
import { BuiltinSettings } from './tabs/BuiltinSettings';
import { AppsSettings } from './tabs/AppsSettings';
import { ShortcutsSettings } from './tabs/ShortcutsSettings';
import { ModelSettings } from './tabs/ModelSettings';
import { CompanionSettings } from './tabs/CompanionSettings';
import { ToolsSettings } from './tabs/ToolsSettings';
import { SkillSettings } from './tabs/SkillSettings';
import { StatsSettings } from './tabs/StatsSettings';
import { AdvancedSettings } from './tabs/AdvancedSettings';
import { ManualSettings } from './tabs/ManualSettings';
import { PluginMarketSettings } from './tabs/PluginMarketSettings';
import { AboutSettings } from './tabs/AboutSettings';
import { EditServerView } from './tabs/McpServerModals';

/** 侧边导航图标：Lucide 组件（接口兼容 className/size） */
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

/** 「插件」分组：系统插件（内置能力管理）+ 插件市场（外部插件，行内展开设置，不开独立 tab） */
const PLUGIN_NAV_GROUP: NavGroup = {
  label: '插件',
  items: [
    { id: 'builtin', name: '系统插件', icon: Puzzle },
    { id: 'plugin-market', name: '插件市场', icon: Store },
  ],
};

const NAV_GROUPS: NavGroup[] = [SYSTEM_NAV_GROUP, AI_NAV_GROUP, PLUGIN_NAV_GROUP, MISC_NAV_GROUP];

/** 固定 tab 内容（操作手册需回调 prop，走动态渲染，不在此表） */
const STATIC_TAB_CONTENT: Record<string, React.ReactNode> = {
  general: <GeneralSettings />,
  builtin: <BuiltinSettings />,
  apps: <AppsSettings />,
  shortcuts: <ShortcutsSettings />,
  model: <ModelSettings />,
  tools: <ToolsSettings />,
  skill: <SkillSettings />,
  companion: <CompanionSettings />,
  stats: <StatsSettings />,
  advanced: <AdvancedSettings />,
  'plugin-market': <PluginMarketSettings />,
  about: <AboutSettings />,
};

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('general');
  const refreshExternal = useExternalPluginsStore((s) => s.refresh);
  // 未知应用提醒深链：store 里有待处理的搜索预填 → 切到「应用」tab（AppsSettings 挂载时消费）
  const appsTabQuery = useSettingsStore((s) => s.appsTabQuery);
  // 通用深链：外部模块（聊天视觉门槛等）请求直达某个 tab，消费后清除
  const pendingTab = useSettingsStore((s) => s.pendingTab);
  // 第三方 MCP server 编辑二级页面：非空时内容区整体切换为独立编辑页
  const mcpEditServer = useSettingsStore((s) => s.mcpEditServer);
  const setMcpEditServer = useSettingsStore((s) => s.setMcpEditServer);

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

  // 打开设置即扫描外部插件（系统插件/插件市场两个 tab 共用同一 store 数据源）
  useEffect(() => {
    refreshExternal().catch((err: unknown) => {
      console.error('[settings] 外部插件扫描失败:', err);
    });
  }, [refreshExternal]);

  let content: React.ReactNode;
  if (mcpEditServer) {
    content = (
      <EditServerView
        server={mcpEditServer}
        onBack={() => setMcpEditServer(null)}
        onSaved={() => setMcpEditServer(null)}
      />
    );
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
          {NAV_GROUPS.map((group, groupIndex) => (
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
                    onClick={() => {
                      setMcpEditServer(null);
                      setActiveTab(tab.id);
                    }}
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
