import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  Trash2,
  Star,
  Download,
  Settings,
  FileText,
  Folder,
  Plus,
  Lock,
  RotateCcw,
  Info,
  Pin,
  Copy,
  ClipboardPaste,
  FolderOpen,
  Sparkles,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useClipboardSelectionStore } from '@/stores/clipboardSelectionStore';
import { LauncherView } from '@/modules/launcher/LauncherView';
import { ClipboardView } from '@/modules/clipboard/ClipboardView';
import { MarkdownView } from '@/modules/markdown/MarkdownView';
import { PasswordView } from '@/modules/password/PasswordView';
import { SettingsView } from '@/modules/settings/SettingsView';
import { EverythingView } from '@/modules/everything/EverythingView';
import { JsonFormatterView } from '@/modules/json_formatter';
import { ChatView } from '@/modules/chat/ChatView';
import { TopNavigationBar } from '@/components/TopNavigationBar';
import type { PrimaryAction } from '@/components/TopNavigationBar';
import { MenuPanel } from '@/components/ActionMenu';
import { UpdateNotification } from '@/components/UpdateNotification';
import { ChangelogDialog } from '@/components/ChangelogDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { ToastContainer } from '@/components/Toast';
import type { VersionCheckResult } from '@/components/ChangelogDialog';
import type { ViewMode, MenuItem, OpenViewDetail } from '@/types';

// Map backend module id to frontend ViewMode — static, no runtime dependencies
const MODULE_VIEW_MAP: Record<string, ViewMode> = {
  clipboard: 'clipboard',
  notes: 'markdown',
  passwords: 'password',
  settings: 'settings',
  everything: 'everything',
};

// Runtime guard for `app:open-view` custom event targets (detail 来自 dispatch 方，不受类型约束)。
// 注意：ViewMode 新增视图时需同步补充此列表，否则新视图会被静默拒绝。
const OPEN_VIEW_TARGETS: readonly ViewMode[] = [
  'launcher',
  'clipboard',
  'markdown',
  'password',
  'settings',
  'everything',
  'json_formatter',
  'chat',
];

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

  // 清空剪贴板历史（keepFavorites=true 时仅删除非收藏记录）
  const handleClearClipboard = useCallback(async (keepFavorites: boolean) => {
    const confirmed = confirm(
      keepFavorites
        ? '确定要删除所有非收藏的剪贴板记录吗？'
        : '确定要清空所有剪贴板历史吗？（含收藏）'
    );
    if (!confirmed) return;
    try {
      const count = await invoke<number>('clear_clipboard_history', { keepFavorites });
      addToast({
        type: 'success',
        title: keepFavorites ? '已删除非收藏记录' : '已清空历史',
        message: `已删除 ${count} 条记录`,
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: '清空失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToast]);

  // 导出剪贴板历史为 JSON 文件
  const handleExportClipboard = useCallback(async () => {
    try {
      const path = await save({
        defaultPath: 'clipboard-history.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      const count = await invoke<number>('export_clipboard_history', { path });
      addToast({ type: 'success', title: '导出完成', message: `已导出 ${count} 条记录` });
    } catch (err) {
      addToast({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToast]);

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

  // Common menu items shared across all views
  const commonMenuItems = useMemo((): MenuItem[] => [
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
  ], [always_on_top, handleToggleAlwaysOnTop, setActiveView]);

  // 剪贴板选中项的菜单状态（由 ClipboardView 写入 store）
  const clipboardSelection = useClipboardSelectionStore();
  // 条目级动作通过 custom event 下发给 ClipboardView 执行（与 markdown:new-note 等同一模式）
  const dispatchClipboardAction = useCallback((action: 'paste' | 'copy' | 'favorite' | 'delete' | 'reveal' | 'send-to-ai') => {
    window.dispatchEvent(new CustomEvent(`clipboard:${action}-selected`));
  }, []);

  // 剪贴板条目级动作：右键菜单只显示这组；顶部「操作」下拉在此基础上追加列表级与通用项
  const clipboardItemMenuItems = useMemo<MenuItem[]>(() => [
    {
      id: 'paste',
      label: '粘贴',
      icon: ClipboardPaste,
      shortcut: '⏎',
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('paste'),
    },
    {
      id: 'copy',
      label: '复制',
      icon: Copy,
      shortcut: 'Ctrl+⏎',
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('copy'),
    },
    {
      id: 'send-to-ai',
      label: '发送给AI',
      icon: Sparkles,
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('send-to-ai'),
    },
    {
      id: 'favorite',
      label: clipboardSelection.isFavorite ? '取消收藏' : '收藏',
      icon: Star,
      shortcut: 'F',
      disabled: !clipboardSelection.hasSelection,
      separator: true,
      onClick: () => dispatchClipboardAction('favorite'),
    },
    {
      id: 'delete',
      label: '删除',
      icon: Trash2,
      shortcut: 'Del',
      danger: true,
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('delete'),
    },
    ...(clipboardSelection.isImage
      ? [{
          id: 'reveal',
          label: '在资源管理器中打开',
          icon: FolderOpen,
          separator: true,
          onClick: () => dispatchClipboardAction('reveal'),
        }]
      : []),
  ], [clipboardSelection, dispatchClipboardAction]);

  // View configurations for navigation bar
  const viewConfigs = useMemo(() => {
    const configs: Record<
      Exclude<ViewMode, 'launcher' | 'chat'>,
      { title: string; menuItems: MenuItem[]; primaryAction?: PrimaryAction; menuLabel?: string }
    > & Record<'chat', { title: string; menuItems: MenuItem[] }> = {
      clipboard: {
        title: '剪贴板历史',
        menuLabel: '操作',
        menuItems: [
          ...clipboardItemMenuItems,
          {
            id: 'clear-all',
            label: '清空历史',
            icon: Trash2,
            danger: true,
            separator: true,
            onClick: () => handleClearClipboard(false),
          },
          {
            id: 'keep-favorites',
            label: '仅保留收藏',
            icon: Star,
            onClick: () => handleClearClipboard(true),
          },
          {
            id: 'export',
            label: '导出数据',
            icon: Download,
            separator: true,
            onClick: handleExportClipboard,
          },
          ...commonMenuItems,
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
          ...commonMenuItems,
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
          ...commonMenuItems,
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
            onClick: handleResetSettings,
          },
          {
            id: 'always-on-top',
            label: always_on_top ? '取消置顶' : '窗口置顶',
            icon: Pin,
            separator: true,
            onClick: handleToggleAlwaysOnTop,
          },
          {
            id: 'about',
            label: '关于',
            icon: Info,
            onClick: () => setShowAbout(true),
          },
        ],
      },
      everything: {
        title: '文件搜索',
        menuItems: [...commonMenuItems],
      },
      json_formatter: {
        title: 'JSON 格式化',
        menuItems: [...commonMenuItems],
      },
      chat: {
        title: 'AI 对话',
        menuItems: [...commonMenuItems],
      },
    };
    return configs;
  }, [always_on_top, commonMenuItems, clipboardItemMenuItems, handleToggleAlwaysOnTop, handleClearClipboard, handleExportClipboard, handleResetSettings]);

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

  // Listen for global shortcut events from backend
  useEffect(() => {
    const unlisten = listen('shortcut:open_module', (event) => {
      const moduleId = event.payload as string;
      const viewMode = MODULE_VIEW_MAP[moduleId];
      if (viewMode) {
        setActiveView(viewMode);
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

  // Listen for in-app view switch requests (e.g. 陪伴设置「在笔记中查看」→ 笔记视图)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenViewDetail>).detail;
      if (!detail || !OPEN_VIEW_TARGETS.includes(detail.view)) return;
      if (detail.view === 'markdown' && detail.notePath) {
        useAppStore.getState().setPendingOpenNotePath(detail.notePath);
      }
      setActiveView(detail.view);
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
      case 'json_formatter':
        return <JsonFormatterView />;
      case 'chat':
        return <ChatView />;
      default:
        return <LauncherView />;
    }
  };

  const isHome = activeView === 'launcher' || activeView === 'chat';
  const currentConfig = isHome ? null : viewConfigs[activeView as Exclude<ViewMode, 'launcher' | 'chat'>];

  // 剪贴板视图的右键菜单：复用动作菜单内容，在光标处浮出
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 视图切换时关闭右键菜单
  useEffect(() => {
    setContextMenu(null);
  }, [activeView]);

  // 点击菜单外 / Esc 关闭
  useEffect(() => {
    if (!contextMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    // 输入框/文本域内保留 WebView 原生编辑菜单（剪切/复制/粘贴）
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    e.preventDefault();
    const MENU_WIDTH = 240;
    const menuHeight = clipboardItemMenuItems.length * 37 + 20;
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
      y: Math.min(e.clientY, window.innerHeight - menuHeight),
    });
  };

  return (
    <div
      className="w-full h-full flex flex-col relative select-none selection:bg-blue-500/30 rounded-lg overflow-hidden bg-transparent"
    >
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
              onBack={handleBack}
              primaryAction={currentConfig?.primaryAction}
              menuLabel={currentConfig?.menuLabel}
            />
          </div>
          <main
            className="flex-1 overflow-hidden isolate"
            onContextMenu={activeView === 'clipboard' ? handleContextMenu : undefined}
          >{renderView()}</main>
        </>
      )}

      {/* 剪贴板右键菜单（条目级动作子集，浮现在光标处；列表级/通用项只在顶部「操作」下拉） */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] min-w-[220px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-2xl animate-in fade-in duration-100"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            WebkitBackdropFilter: 'blur(20px)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <MenuPanel
            items={clipboardItemMenuItems}
            onItemClick={(item) => {
              if (!item.disabled) {
                item.onClick();
                setContextMenu(null);
              }
            }}
          />
        </div>
      )}

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
