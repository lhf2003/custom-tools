import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { FolderOpen, MoreHorizontal, Package, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { MenuPanel } from '@/components/ActionMenu';
import { useToastStore } from '@/stores/toastStore';
import { Tooltip } from '@/components/Tooltip';
import { useExternalPluginsStore, type ExternalPluginItem } from '@/stores/externalPluginsStore';
import {
  isBuiltInPluginEnabled,
  listPlugins,
  loadBuiltInPluginStates,
  setBuiltInPluginEnabled,
} from '@/plugins/registry';
import { setPluginEnabled, isPluginTrusted, markPluginTrusted } from '@/plugins/external';
import { getPluginShortcutConflicts } from '@/plugins/pluginShortcuts';
import { useAppStore } from '@/stores/appStore';

/** 内置插件 id → 全局快捷键 id（禁用插件时联动禁用快捷键并释放组合键；反之为恢复） */
const BUILTIN_SHORTCUT_MAP: Record<string, string> = {
  clipboard: 'open_clipboard',
  markdown: 'open_notes',
  password: 'open_passwords',
  everything: 'open_everything',
  translate: 'translate_selection',
};

/** 信任确认弹窗 */
function TrustConfirmModal({
  name,
  dirPath,
  onConfirm,
  onCancel,
}: {
  name: string;
  dirPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[400px] bg-app-bg-tertiary border border-app-border rounded-xl shadow-2xl p-5 animate-in fade-in duration-100">
        <h3 className="text-sm font-semibold text-app-text-primary mb-2">启用插件「{name}」？</h3>
        <p className="text-xs text-app-text-tertiary leading-relaxed mb-1">
          该插件与本应用同权限运行，可访问本应用的剪贴板、笔记、密码等全部数据与功能。
        </p>
        <p className="text-xs text-app-text-disabled leading-relaxed mb-4 break-all">来源目录：{dirPath}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg text-sm text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer"
          >
            启用
          </button>
        </div>
      </div>
    </div>
  );
}

/** 行内更多菜单（AI 更新 / 设置 / 打开目录 / 卸载）；设置项仅在插件声明了 settings schema 时出现 */
function MoreMenu({
  onAiUpdate,
  onReveal,
  onUninstall,
  onSettings,
  hasSettings,
}: {
  onAiUpdate: () => void;
  onReveal: () => void;
  onUninstall: () => void;
  onSettings: () => void;
  hasSettings: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 菜单 portal 到 body + fixed 定位：SettingGroup 容器 overflow-hidden 会裁剪 absolute 菜单
  const [menuBox, setMenuBox] = useState<{ top?: number; bottom?: number; right: number }>({ right: 0 });
  const [dropUp, setDropUp] = useState(false);

  // fixed 几何：右缘对齐触发器；下方空间不足且上方够时向上翻（与 CustomSelect 同一策略）
  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const itemCount = hasSettings ? 4 : 3;
    const estimatedHeight = itemCount * 36 + 12 + 13; // 项高 + 面板 padding + 分隔线
    const gap = 8;
    const up = window.innerHeight - rect.bottom < estimatedHeight && rect.top > estimatedHeight;
    setDropUp(up);
    setMenuBox({
      right: window.innerWidth - rect.right,
      ...(up
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    });
  }, [hasSettings]);

  useEffect(() => {
    if (isOpen) updateMenuPosition();
  }, [isOpen, updateMenuPosition]);

  // 滚动/缩放时跟随触发器重新定位（设置页在内部容器滚动，需 capture 阶段捕获）
  useEffect(() => {
    if (!isOpen) return;
    let raf = 0;
    const handler = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateMenuPosition);
    };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      // 菜单 portal 在 body 下、不在 containerRef 内，需单独判定
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen((v) => !v)}
        aria-label="更多操作"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
      >
        <MoreHorizontal size={16} />
      </button>
      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className={`fixed min-w-[180px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-lg z-50 animate-in fade-in duration-150 ${
              dropUp ? 'slide-in-from-bottom-1' : 'slide-in-from-top-1'
            }`}
            style={{ ...menuBox, WebkitBackdropFilter: 'blur(20px)', backdropFilter: 'blur(20px)' }}
          >
            <MenuPanel
              items={[
                ...(hasSettings
                  ? [
                      {
                        id: 'settings',
                        label: '设置',
                        icon: Settings2,
                        onClick: () => {
                          onSettings();
                          setIsOpen(false);
                        },
                      },
                    ]
                  : []),
                {
                  id: 'ai-update',
                  label: 'AI 更新',
                  icon: Sparkles,
                  onClick: () => {
                    onAiUpdate();
                    setIsOpen(false);
                  },
                },
                {
                  id: 'reveal',
                  label: '打开插件目录',
                  icon: FolderOpen,
                  onClick: () => {
                    onReveal();
                    setIsOpen(false);
                  },
                },
                {
                  id: 'uninstall',
                  label: '卸载插件',
                  icon: Trash2,
                  danger: true,
                  separator: true,
                  onClick: () => {
                    onUninstall();
                    setIsOpen(false);
                  },
                },
              ]}
              onItemClick={(item) => item.onClick()}
            />
          </div>,
          document.body
        )}
    </div>
  );
}

interface PluginMarketSettingsProps {
  /** 跳转到某插件的独立设置 tab（设置页「插件」分组下） */
  onOpenPluginSettings: (pluginId: string) => void;
}

export function PluginMarketSettings({ onOpenPluginSettings }: PluginMarketSettingsProps) {
  const { addToast } = useToastStore();
  // 列表数据走共享 store：本页操作刷新后，设置导航的插件设置 tab 同步增减
  const items = useExternalPluginsStore((s) => s.items);
  const loading = useExternalPluginsStore((s) => s.loading);
  const refresh = useExternalPluginsStore((s) => s.refresh);
  // 待确认启用的插件（信任流程）
  const [pendingEnable, setPendingEnable] = useState<ExternalPluginItem | null>(null);
  // 聊天页入口：AI 生成/更新经 chatPrefill 跳转聊天页驱动（layout_ui/generate_plugin_chat 工具链路）
  const { setActiveView, setChatPrefill } = useAppStore();
  // 内置插件开关的本地镜像（初始化/加载后刷新；切换时同步）
  const [builtInEnabled, setBuiltInEnabled] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      await refresh();
    } catch (err) {
      console.error('[plugins] 插件列表加载失败:', err);
      addToast({ type: 'error', title: '插件列表加载失败', message: String(err) });
    }
  }, [refresh, addToast]);

  useEffect(() => {
    load();
  }, [load]);

  // 内置插件状态：内存集加载后刷新本地镜像（listPlugins 含外部已注册项，仅内置行消费）
  useEffect(() => {
    loadBuiltInPluginStates()
      .catch((err: unknown) => {
        console.error('[plugins] 内置插件状态加载失败:', err);
      })
      .finally(() => {
        setBuiltInEnabled(
          Object.fromEntries(listPlugins().map((p) => [p.id, isBuiltInPluginEnabled(p.id)]))
        );
      });
  }, []);

  // 内置插件：注册表中不在扫描结果里的部分（注册表只含启用的外部插件，
  // 扫描结果含全部外部插件，差集恰好是内置；依赖 items 让刷新后重算）
  const builtInPlugins = useMemo(() => {
    const externalIds = new Set(items.map((it) => it.manifest.id));
    return listPlugins().filter((p) => !externalIds.has(p.id));
  }, [items]);

  const handleToggle = useCallback(async (item: ExternalPluginItem, enabled: boolean) => {
    if (enabled) {
      // 启用：未信任则先弹确认
      const trusted = await isPluginTrusted(item.manifest.id).catch(() => false);
      if (!trusted) {
        setPendingEnable(item);
        return;
      }
    }
    await setPluginEnabled(item.manifest.id, enabled);
    await load();
    addToast({ type: 'success', title: enabled ? `已启用「${item.manifest.name}」` : `已禁用「${item.manifest.name}」` });
  }, [load, addToast]);

  /**
   * 内置插件开关：落盘 builtin.<id>.enabled → 同步注册表内存集 → 本地镜像 →
   * 联动全局快捷键（保留用户自定义键位，仅强制 enabled 与插件一致；reregister 在 update_shortcut 内部）。
   */
  const handleBuiltInToggle = useCallback(async (pluginId: string, pluginName: string, enabled: boolean) => {
    try {
      await invoke('set_setting', {
        key: `builtin.${pluginId}.enabled`,
        value: enabled ? '1' : '0',
      });
      setBuiltInPluginEnabled(pluginId, enabled);
      setBuiltInEnabled((s) => ({ ...s, [pluginId]: enabled }));
      const shortcutId = BUILTIN_SHORTCUT_MAP[pluginId];
      if (shortcutId) {
        const shortcuts = await invoke<{ id: string; custom_keys: string | null }[]>('get_shortcuts');
        const current = shortcuts.find((s) => s.id === shortcutId);
        await invoke('update_shortcut', {
          id: shortcutId,
          customKeys: current?.custom_keys ?? null,
          enabled,
        });
      }
      addToast({ type: 'success', title: enabled ? `已启用「${pluginName}」` : `已禁用「${pluginName}」` });
    } catch (err) {
      addToast({ type: 'error', title: '设置失败', message: String(err) });
    }
  }, [addToast]);

  const confirmEnable = useCallback(async () => {
    if (!pendingEnable) return;
    const item = pendingEnable;
    setPendingEnable(null);
    try {
      await markPluginTrusted(item.manifest.id);
      await setPluginEnabled(item.manifest.id, true);
      await load();
      addToast({ type: 'success', title: `已启用「${item.manifest.name}」` });
    } catch (err) {
      addToast({ type: 'error', title: '启用失败', message: String(err) });
    }
  }, [pendingEnable, load, addToast]);

  const handleUninstall = useCallback(async (item: ExternalPluginItem) => {
    if (!confirm(`确定要卸载插件「${item.manifest.name}」吗？将删除其插件目录。`)) return;
    try {
      await invoke('uninstall_plugin', { pluginId: item.manifest.id });
      await load();
      addToast({ type: 'success', title: `已卸载「${item.manifest.name}」` });
    } catch (err) {
      addToast({ type: 'error', title: '卸载失败', message: String(err) });
    }
  }, [load, addToast]);

  const handleReveal = useCallback(async (item: ExternalPluginItem) => {
    try {
      await revealItemInDir(item.dirPath);
    } catch (err) {
      addToast({ type: 'error', title: '打开目录失败', message: String(err) });
    }
  }, [addToast]);

  // AI 生成：跳聊天页，文案进输入框（用户补充细节后发送）
  const handleAiGenerate = useCallback(() => {
    setChatPrefill('帮我做一个插件：');
    setActiveView('chat');
  }, [setChatPrefill, setActiveView]);

  // AI 更新：读现有插件代码进聊天上下文（Q19：现有代码塞进提示词），
  // 模型据上下文调 generate_plugin_chat（mode=update）
  const handleAiUpdate = useCallback(
    (item: ExternalPluginItem) => {
      (async () => {
        const files = await invoke<{ manifest: string; bundle: string }>('read_plugin_files', {
          pluginId: item.manifest.id,
        });
        setChatPrefill(
          `请更新插件「${item.manifest.name}」（id: ${item.manifest.id}），这是我的修改需求：\n\n` +
            `现有 plugin.json：\n${files.manifest}\n\n现有 plugin.js：\n${files.bundle}`,
        );
        setActiveView('chat');
      })().catch((err: unknown) => {
        addToast({
          type: 'error',
          title: '读取插件代码失败',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [setChatPrefill, setActiveView, addToast],
  );

  return (
    <>
      {/* 内置插件：系统能力，支持开关；禁用联动其全局快捷键（释放组合键） */}
      <SettingGroup title="内置插件">
        {builtInPlugins.map((plugin) => {
          return (
            <SettingRow key={plugin.id} title={plugin.name} description={plugin.description}>
              <Toggle
                enabled={builtInEnabled[plugin.id] ?? true}
                onToggle={(v) => handleBuiltInToggle(plugin.id, plugin.name, v)}
              />
            </SettingRow>
          );
        })}
      </SettingGroup>

      {/* 外部插件：可启停 / 打开目录 / 卸载 */}
      <SettingGroup
        title="已安装插件"
        actions={
          <button
            onClick={handleAiGenerate}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            <Sparkles size={13} />
            AI 生成
          </button>
        }
      >
        {loading ? (
          <div className="px-3 py-8 text-center text-xs text-app-text-tertiary">加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <Package size={30} className="mx-auto mb-3 text-app-text-disabled" />
            <p className="text-sm font-medium text-app-text-secondary mb-1">还没有外部插件</p>
            <p className="text-xs text-app-text-tertiary leading-relaxed max-w-[420px] mx-auto mb-4">
              用 AI 生成你的第一个插件，或将插件目录手动复制到应用数据目录的 plugins 文件夹下。
            </p>
            <button
              onClick={handleAiGenerate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer"
            >
              <Sparkles size={14} />
              AI 生成第一个插件
            </button>
          </div>
        ) : (
          items.map((item) => {
            const hasSettings = item.manifest.settings.length > 0;
            const shortcutConflicts = getPluginShortcutConflicts(item.manifest.id);
            return (
              <SettingRow
                key={item.manifest.id}
                title={item.manifest.name}
                description={item.manifest.description ?? item.dirPath}
              >
                <div className="flex items-center gap-2">
                  {item.error ? (
                    <span className="text-xs text-app-status-error">加载失败</span>
                  ) : shortcutConflicts.length > 0 ? (
                    <Tooltip
                      content={`${shortcutConflicts.map((c) => c.key).join('、')} 注册失败：${shortcutConflicts[0].reason}`}
                    >
                      <span className="text-xs text-app-status-error cursor-help">
                        快捷键冲突
                      </span>
                    </Tooltip>
                  ) : !item.enabled ? (
                    <span className="text-xs text-app-text-disabled">已禁用</span>
                  ) : null}
                  <Toggle
                    enabled={item.enabled}
                    onToggle={(v) => handleToggle(item, v)}
                  />
                  <MoreMenu
                    hasSettings={hasSettings}
                    onAiUpdate={() => handleAiUpdate(item)}
                    onSettings={() => onOpenPluginSettings(item.manifest.id)}
                    onReveal={() => handleReveal(item)}
                    onUninstall={() => handleUninstall(item)}
                  />
                </div>
              </SettingRow>
            );
          })
        )}
      </SettingGroup>

      {/* 信任确认弹窗 */}
      {pendingEnable && (
        <TrustConfirmModal
          name={pendingEnable.manifest.name}
          dirPath={pendingEnable.dirPath}
          onConfirm={confirmEnable}
          onCancel={() => setPendingEnable(null)}
        />
      )}

    </>
  );
}
