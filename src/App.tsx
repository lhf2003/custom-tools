import { useEffect, useMemo, useCallback, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Info, Pin, RotateCcw, Settings } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { LauncherView } from '@/modules/launcher/LauncherView';
import { SettingsView } from '@/modules/settings/SettingsView';
import { ChatView } from '@/modules/chat/ChatView';
import { TopNavigationBar } from '@/components/TopNavigationBar';
import { UpdateNotification } from '@/components/UpdateNotification';
import { ChangelogDialog } from '@/components/ChangelogDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { ToastContainer } from '@/components/Toast';
import type { VersionCheckResult } from '@/components/ChangelogDialog';
import type { MenuItem, OpenViewDetail, ShellView } from '@/types';
import { getPlugin, getPluginByShortcutModule, isPluginView, preloadPlugins } from '@/plugins/registry';
import { PluginHost } from '@/plugins/PluginHost';

const SHELL_VIEWS: readonly ShellView[] = ['launcher', 'chat', 'settings'];

function isShellView(view: string): view is ShellView {
  return (SHELL_VIEWS as readonly string[]).includes(view);
}

function App() {
  const { activeView, setActiveView, toggleWindow } = useAppStore();
  const { always_on_top, toggleAlwaysOnTop, loadSettings } = useSettingsStore();
  const { addToast } = useToastStore();
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogData, setChangelogData] = useState<VersionCheckResult | null>(null);
  const [showAbout, setShowAbout] = useState(false);

  // Stable callback for toggle always on top
  const handleToggleAlwaysOnTop = useCallback(async () => {
    try {
      await toggleAlwaysOnTop();
    } catch (err) {
      console.error('Failed to toggle always on top:', err);
    }
  }, [toggleAlwaysOnTop]);

  // 恢复所有设置为默认值
  const handleResetSettings = useCallback(async () => {
    if (!confirm('确定要恢复所有设置为默认值吗？（包括 LLM 配置）')) return;
    try {
      await invoke('reset_settings');
      await loadSettings();
      addToast({ type: 'success', title: '已恢复默认设置' });
    } catch (err) {
      addToast({
        type: 'error',
        title: '恢复默认失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToast, loadSettings]);

  // 公共菜单项：壳统一追加到所有带导航栏的视图（插件项之后）。
  // 「设置」项在设置视图自过滤；「关于」为公共项。
  const commonMenuItems = useMemo((): MenuItem[] => {
    const items: MenuItem[] = [
      {
        id: 'always-on-top',
        label: always_on_top ? '取消置顶' : '窗口置顶',
        icon: Pin,
        separator: true,
        onClick: handleToggleAlwaysOnTop,
      },
    ];
    if (activeView !== 'settings') {
      items.push({
        id: 'settings',
        label: '设置',
        icon: Settings,
        onClick: () => setActiveView('settings'),
      });
    }
    items.push({
      id: 'about',
      label: '关于',
      icon: Info,
      onClick: () => setShowAbout(true),
    });
    return items;
  }, [always_on_top, activeView, handleToggleAlwaysOnTop, setActiveView]);

  // 设置是壳视图：菜单配置留在壳里（自有项 + 公共项）
  const settingsMenuItems = useMemo((): MenuItem[] => [
    {
      id: 'reset-defaults',
      label: '恢复默认',
      icon: RotateCcw,
      danger: true,
      onClick: handleResetSettings,
    },
    ...commonMenuItems,
  ], [handleResetSettings, commonMenuItems]);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Check for unread changelogs on mount (after auto-update)
  useEffect(() => {
    const checkChangelogs = async () => {
      try {
        const result = await invoke<VersionCheckResult>('check_version_changelog');
        if (result.unread_changelogs.length > 0) {
          setChangelogData(result);
          setShowChangelog(true);
        }
      } catch (err) {
        console.error('Failed to check changelogs:', err);
      }
    };

    // Delay slightly to ensure app is fully loaded
    const timer = setTimeout(checkChangelogs, 1000);
    return () => clearTimeout(timer);
  }, []);

  // Clean up old changelog entries on mount (keep last 10 versions)
  useEffect(() => {
    invoke('cleanup_old_changelogs', { keepCount: 10 }).catch((err: unknown) => {
      console.error('Failed to cleanup old changelogs:', err);
    });
  }, []);

  // 启动空闲时预加载全部插件 chunk：消灭首次进入插件的加载态（本地并行，不阻塞）
  useEffect(() => {
    const timer = setTimeout(preloadPlugins, 1000);
    return () => clearTimeout(timer);
  }, []);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeView !== 'launcher') {
          setActiveView('launcher');
        } else {
          toggleWindow();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleWindow, activeView, setActiveView]);

  // Listen for global shortcut events from backend（shortcutModuleId → 插件映射由注册表吸收）
  useEffect(() => {
    const unlisten = listen('shortcut:open_module', (event) => {
      const moduleId = event.payload as string;
      if (moduleId === 'settings') {
        setActiveView('settings');
        return;
      }
      const plugin = getPluginByShortcutModule(moduleId);
      if (plugin) {
        setActiveView(plugin.id);
      } else {
        console.warn(`[plugins] 快捷键事件未知 moduleId「${moduleId}」，已忽略`);
      }
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup shortcut listener:', err);
      });
    };
  }, [setActiveView]);

  // Listen for companion "AI 分析" requests: prefill chat and switch to chat view
  useEffect(() => {
    const unlisten = listen<string>('companion:analyze', (event) => {
      // 错误日志的分析包装文案在这里组装，chatPrefill 通道本身只承载「填入输入框的原文」
      useAppStore.getState().setChatPrefill(`请分析以下错误日志的原因和解决方案：\n\n${event.payload}`);
      setActiveView('chat');
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup companion:analyze listener:', err);
      });
    };
  }, [setActiveView]);

  // 应用内视图切换请求（如陪伴设置「在笔记中查看」→ 笔记视图）：
  // 插件视图走载荷通道 openPluginView，壳视图直接 setActiveView；未知 id warn + 忽略
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenViewDetail>).detail;
      if (!detail) return;
      if (isPluginView(detail.view)) {
        useAppStore.getState().openPluginView(detail.view, detail.payload);
        return;
      }
      if (isShellView(detail.view)) {
        setActiveView(detail.view);
        return;
      }
      console.warn(`[plugins] app:open-view 未知视图「${detail.view}」，已忽略`);
    };
    window.addEventListener('app:open-view', handler);
    return () => window.removeEventListener('app:open-view', handler);
  }, [setActiveView]);

  // Reset launcher search state every time the window is shown:
  // 唤起即全新查询，保证「唤起 → 输入 → 回车」肌肉记忆链路可预测
  useEffect(() => {
    const unlisten = listen('window:shown', () => {
      useAppStore.getState().setSearchQuery('');
    });

    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup window:shown listener:', err);
      });
    };
  }, []);

  // Handle back navigation
  const handleBack = useCallback(() => {
    setActiveView('launcher');
  }, [setActiveView]);

  const activePlugin = isPluginView(activeView) ? getPlugin(activeView) : undefined;
  const isHome = activeView === 'launcher' || activeView === 'chat';

  // Render current view
  const renderView = () => {
    if (activePlugin) {
      return (
        <PluginHost
          key={activePlugin.id}
          plugin={activePlugin}
          commonMenuItems={commonMenuItems}
          onBack={handleBack}
        />
      );
    }
    if (isHome) {
      return (
        <main className="flex-1 overflow-hidden">
          {activeView === 'chat' ? <ChatView /> : <LauncherView />}
        </main>
      );
    }
    if (activeView === 'settings') {
      return (
        <>
          <div className="relative z-50">
            <TopNavigationBar
              title="设置"
              menuItems={settingsMenuItems}
              onBack={handleBack}
            />
          </div>
          <main className="flex-1 overflow-hidden isolate">
            <SettingsView />
          </main>
        </>
      );
    }
    // 未知视图 id：warn + 回退启动器（替代旧 OPEN_VIEW_TARGETS 的静默拒绝）
    console.warn(`[plugins] 未知视图「${activeView}」，回退启动器`);
    return (
      <main className="flex-1 overflow-hidden">
        <LauncherView />
      </main>
    );
  };

  return (
    <div
      className="w-full h-full flex flex-col relative select-none selection:bg-blue-500/30 rounded-lg overflow-hidden bg-transparent"
    >
      {renderView()}

      {/* Update Notification */}
      <UpdateNotification />

      {/* Changelog Dialog - shown after auto-update */}
      <ChangelogDialog
        isOpen={showChangelog}
        onClose={() => setShowChangelog(false)}
        initialData={changelogData}
      />

      {/* About Dialog */}
      <AboutDialog isOpen={showAbout} onClose={() => setShowAbout(false)} />

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  );
}

export default App;
