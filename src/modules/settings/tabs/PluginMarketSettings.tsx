import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { FolderOpen, MoreHorizontal, Package, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { PageHeader, SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { MenuPanel } from '@/components/ActionMenu';
import { useToastStore } from '@/stores/toastStore';
import { listPlugins, listExternalPluginIds } from '@/plugins/registry';
import { refreshExternalPlugins, setPluginEnabled, isPluginTrusted, markPluginTrusted } from '@/plugins/external';
import { PluginSettingsForm } from '@/plugins/pluginSettings';
import { getPluginShortcutConflicts } from '@/plugins/pluginShortcuts';
import { GeneratePluginModal } from './GeneratePluginModal';
import type { PluginScanItem } from '@/plugins/external';

/** 合并启用状态的外部插件展示条目 */
interface ExternalItem {
  manifest: NonNullable<PluginScanItem['manifest']>;
  dirPath: string;
  error: string | null;
  enabled: boolean;
}

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
      <div className="w-[400px] bg-app-bg-card border border-app-border rounded-xl shadow-2xl p-5 animate-in fade-in duration-100">
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

/** 行内更多菜单（设置 / 打开目录 / 卸载）；设置项仅在插件声明了 settings schema 时出现 */
function MoreMenu({
  onReveal,
  onUninstall,
  onSettings,
  hasSettings,
}: {
  onReveal: () => void;
  onUninstall: () => void;
  onSettings: () => void;
  hasSettings: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative flex-shrink-0">
      <button
        onClick={() => setIsOpen((v) => !v)}
        aria-label="更多操作"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
      >
        <MoreHorizontal size={16} />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 min-w-[180px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-2xl z-50 animate-in fade-in slide-in-from-top-1 duration-100">
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
        </div>
      )}
    </div>
  );
}

export function PluginMarketSettings() {
  const { addToast } = useToastStore();
  const [items, setItems] = useState<ExternalItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 待确认启用的插件（信任流程）
  const [pendingEnable, setPendingEnable] = useState<ExternalItem | null>(null);
  // 行下展开设置表单的插件 id（schema 渲染，见 pluginSettings.tsx）
  const [expandedSettingsId, setExpandedSettingsId] = useState<string | null>(null);
  // AI 生成弹窗（任务 12：流式步骤 + 校验 + 预览 + 试运行 + 安装）
  const [showGenerate, setShowGenerate] = useState(false);

  const load = useCallback(async () => {
    try {
      const scanItems = await refreshExternalPlugins();
      const items: ExternalItem[] = [];
      for (const item of scanItems) {
        if (!item.manifest) continue;
        const enabled = await invoke<string | null>('get_setting', {
          key: `plugins.${item.manifest.id}.enabled`,
        });
        items.push({
          manifest: item.manifest,
          dirPath: item.dir_path,
          error: item.error,
          enabled: enabled === '1',
        });
      }
      setItems(items);
    } catch (err) {
      console.error('[plugins] 插件列表加载失败:', err);
      addToast({ type: 'error', title: '插件列表加载失败', message: String(err) });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    load();
  }, [load]);

  // 内置插件：注册表中非外部的部分
  const builtInPlugins = useMemo(
    () => listPlugins().filter((p) => !listExternalPluginIds().includes(p.id)),
    [items]
  );

  const handleToggle = useCallback(async (item: ExternalItem, enabled: boolean) => {
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

  const handleUninstall = useCallback(async (item: ExternalItem) => {
    if (!confirm(`确定要卸载插件「${item.manifest.name}」吗？将删除其插件目录。`)) return;
    try {
      await invoke('uninstall_plugin', { pluginId: item.manifest.id });
      await load();
      addToast({ type: 'success', title: `已卸载「${item.manifest.name}」` });
    } catch (err) {
      addToast({ type: 'error', title: '卸载失败', message: String(err) });
    }
  }, [load, addToast]);

  const handleReveal = useCallback(async (item: ExternalItem) => {
    try {
      await revealItemInDir(item.dirPath);
    } catch (err) {
      addToast({ type: 'error', title: '打开目录失败', message: String(err) });
    }
  }, [addToast]);

  // 设置展开/收起（同一时刻只展开一行）
  const handleSettings = useCallback((id: string) => {
    setExpandedSettingsId((prev) => (prev === id ? null : id));
  }, []);

  const handleAiGenerate = useCallback(() => {
    setShowGenerate(true);
  }, []);

  // 生成安装成功后的刷新（新插件出现在列表；启用走现有信任确认流程）
  const handleGeneratedInstalled = useCallback(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="插件市场"
        description="管理本地插件，或让 AI 帮你生成新插件"
        actions={
          <button
            onClick={handleAiGenerate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer"
          >
            <Sparkles size={14} />
            AI 生成
          </button>
        }
      />

      {/* 内置插件：系统能力，锁定展示 */}
      <SettingGroup title="内置插件">
        {builtInPlugins.map((plugin) => {
          const Icon = plugin.icon;
          return (
            <SettingRow key={plugin.id} title={plugin.name} description={plugin.description}>
              <span className="text-xs text-app-text-disabled">系统内置</span>
            </SettingRow>
          );
        })}
      </SettingGroup>

      {/* 外部插件：可启停 / 打开目录 / 卸载 */}
      <SettingGroup title="已安装插件">
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
            const Icon = item.manifest.icon ? null : Package;
            const hasSettings = item.manifest.settings.length > 0;
            const shortcutConflicts = getPluginShortcutConflicts(item.manifest.id);
            return (
              <div key={item.manifest.id}>
                <SettingRow
                  title={item.manifest.name}
                  description={item.manifest.description ?? item.dirPath}
                >
                  <div className="flex items-center gap-2">
                    {item.error ? (
                      <span className="text-xs text-app-status-error">加载失败</span>
                    ) : shortcutConflicts.length > 0 ? (
                      <span
                        className="text-xs text-app-status-error cursor-help"
                        title={`${shortcutConflicts.map((c) => c.key).join('、')} 注册失败：${shortcutConflicts[0].reason}`}
                      >
                        快捷键冲突
                      </span>
                    ) : !item.enabled ? (
                      <span className="text-xs text-app-text-disabled">已禁用</span>
                    ) : null}
                    <Toggle
                      enabled={item.enabled}
                      onToggle={(v) => handleToggle(item, v)}
                    />
                    <MoreMenu
                      hasSettings={hasSettings}
                      onSettings={() => handleSettings(item.manifest.id)}
                      onReveal={() => handleReveal(item)}
                      onUninstall={() => handleUninstall(item)}
                    />
                  </div>
                </SettingRow>
                {/* 设置展开区：纱层底 + 缩进，层级靠排版建立（不卡片化） */}
                {expandedSettingsId === item.manifest.id && hasSettings && (
                  <div className="mx-1 mb-1.5 rounded-lg bg-white/[0.03]">
                    <div className="px-5 py-1.5">
                      <PluginSettingsForm
                        pluginId={item.manifest.id}
                        schema={item.manifest.settings}
                      />
                    </div>
                  </div>
                )}
              </div>
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

      {/* AI 生成弹窗 */}
      {showGenerate && (
        <GeneratePluginModal onClose={() => setShowGenerate(false)} onInstalled={handleGeneratedInstalled} />
      )}
    </>
  );
}
