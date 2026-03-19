import { useEffect, useMemo, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Trash2,
  Star,
  Download,
  Settings,
  FileText,
  Folder,
  Upload,
  Plus,
  Lock,
  RotateCcw,
  Info,
  Pin,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { LauncherView } from '@/modules/launcher/LauncherView';
import { ClipboardView } from '@/modules/clipboard/ClipboardView';
import { MarkdownView } from '@/modules/markdown/MarkdownView';
import { PasswordView } from '@/modules/password/PasswordView';
import { SettingsView } from '@/modules/settings/SettingsView';
import { EverythingView } from '@/modules/everything/EverythingView';
import { TopNavigationBar } from '@/components/TopNavigationBar';
import type { ViewMode, MenuItem } from '@/types';

function App() {
  const { activeView, setActiveView, toggleWindow } = useAppStore();
  const { always_on_top, toggleAlwaysOnTop, loadSettings } = useSettingsStore();

  // Stable callback for toggle always on top
  const handleToggleAlwaysOnTop = useCallback(async () => {
    try {
      await toggleAlwaysOnTop();
    } catch (err) {
      console.error('Failed to toggle always on top:', err);
    }
  }, [toggleAlwaysOnTop]);

  // View configurations for navigation bar
  const viewConfigs = useMemo(() => {
    const configs: Record<
      Exclude<ViewMode, 'launcher'>,
      { title: string; menuItems: MenuItem[] }
    > = {
      clipboard: {
        title: '剪贴板历史',
        menuItems: [
          {
            id: 'clear-all',
            label: '清空历史',
            icon: Trash2,
            danger: true,
            onClick: () => {
              if (confirm('确定要清空所有剪贴板历史吗？')) {
                // TODO: Implement clear all
                console.log('Clear clipboard history');
              }
            },
          },
          {
            id: 'keep-favorites',
            label: '仅保留收藏',
            icon: Star,
            onClick: () => {
              if (confirm('确定要删除所有非收藏的剪贴板记录吗？')) {
                // TODO: Implement keep favorites only
                console.log('Keep favorites only');
              }
            },
          },
          {
            id: 'export',
            label: '导出数据',
            icon: Download,
            separator: true,
            onClick: () => {
              // TODO: Implement export
              console.log('Export clipboard data');
            },
          },
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            onClick: handleToggleAlwaysOnTop,
          },
          {
            id: 'settings',
            label: '设置',
            icon: Settings,
            separator: true,
            onClick: () => setActiveView('settings'),
          },
        ],
      },
      markdown: {
        title: 'Markdown 笔记',
        menuItems: [
          {
            id: 'new-note',
            label: '新建笔记',
            icon: FileText,
            onClick: () => {
              // Dispatch custom event for markdown view
              window.dispatchEvent(new CustomEvent('markdown:new-note'));
            },
          },
          {
            id: 'new-folder',
            label: '新建文件夹',
            icon: Folder,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('markdown:new-folder'));
            },
          },
          {
            id: 'import',
            label: '导入笔记',
            icon: Upload,
            separator: true,
            onClick: () => {
              // TODO: Implement import
              console.log('Import notes');
            },
          },
          {
            id: 'export-all',
            label: '导出全部',
            icon: Download,
            onClick: () => {
              // TODO: Implement export
              console.log('Export all notes');
            },
          },
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            separator: true,
            onClick: () => toggleAlwaysOnTop(),
          },
          {
            id: 'settings',
            label: '设置',
            icon: Settings,
            onClick: () => setActiveView('settings'),
          },
        ],
      },
      password: {
        title: '密码保险库',
        menuItems: [
          {
            id: 'new-entry',
            label: '新增密码',
            icon: Plus,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('password:new-entry'));
            },
          },
          {
            id: 'new-category',
            label: '新建分类',
            icon: Folder,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('password:new-category'));
            },
          },
          {
            id: 'lock',
            label: '锁定保险库',
            icon: Lock,
            separator: true,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('password:lock'));
            },
          },
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            onClick: handleToggleAlwaysOnTop,
          },
          {
            id: 'settings',
            label: '设置',
            icon: Settings,
            separator: true,
            onClick: () => setActiveView('settings'),
          },
        ],
      },
      settings: {
        title: '设置',
        menuItems: [
          {
            id: 'reset-defaults',
            label: '恢复默认',
            icon: RotateCcw,
            danger: true,
            onClick: () => {
              if (confirm('确定要恢复所有设置为默认值吗？')) {
                // TODO: Implement reset defaults
                console.log('Reset to defaults');
              }
            },
          },
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            separator: true,
            onClick: () => toggleAlwaysOnTop(),
          },
          {
            id: 'about',
            label: '关于',
            icon: Info,
            onClick: () => {
              // TODO: Show about dialog
              console.log('Show about dialog');
            },
          },
        ],
      },
      everything: {
        title: '文件搜索',
        menuItems: [
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            onClick: handleToggleAlwaysOnTop,
          },
          {
            id: 'settings',
            label: '设置',
            icon: Settings,
            separator: true,
            onClick: () => setActiveView('settings'),
          },
        ],
      },
    };
    return configs;
  }, [always_on_top, handleToggleAlwaysOnTop, setActiveView]);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
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
  }, [toggleWindow, activeView]);

  // Listen for global shortcut events from backend
  useEffect(() => {
    const unlisten = listen('shortcut:open_module', (event) => {
      const moduleId = event.payload as string;

      // Map backend module id to frontend ViewMode
      const viewMap: Record<string, ViewMode> = {
        'clipboard': 'clipboard',
        'notes': 'markdown',
        'passwords': 'password',
        'settings': 'settings',
      };

      const viewMode = viewMap[moduleId];
      if (viewMode) {
        setActiveView(viewMode);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setActiveView]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    setActiveView('launcher');
  }, [setActiveView]);

  // Render current view
  const renderView = () => {
    switch (activeView) {
      case 'launcher':
        return <LauncherView />;
      case 'clipboard':
        return <ClipboardView />;
      case 'markdown':
        return <MarkdownView />;
      case 'password':
        return <PasswordView />;
      case 'settings':
        return <SettingsView />;
      case 'everything':
        return <EverythingView />;
      default:
        return <LauncherView />;
    }
  };

  const isHome = activeView === 'launcher';
  const currentConfig = isHome ? null : viewConfigs[activeView as Exclude<ViewMode, 'launcher'>];

  return (
    <div className="w-full h-full bg-transparent overflow-hidden flex flex-col relative selection:bg-blue-500/30 rounded-2xl">
      {isHome ? (
        // Launcher view - no navigation bar
        <main className="flex-1 overflow-hidden">{renderView()}</main>
      ) : (
        // Other views - with navigation bar
        <>
          <div className="relative z-50">
            <TopNavigationBar
              title={currentConfig?.title || ''}
              menuItems={currentConfig?.menuItems || []}
              alwaysOnTop={always_on_top}
              onToggleAlwaysOnTop={toggleAlwaysOnTop}
              onBack={handleBack}
            />
          </div>
          <main className="flex-1 overflow-hidden isolate">{renderView()}</main>
        </>
      )}
    </div>
  );
}

export default App;
