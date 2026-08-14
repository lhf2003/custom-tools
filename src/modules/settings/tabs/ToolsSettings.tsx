import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, ChevronRight, Lock, Terminal, Globe } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';

interface CompanionToolInfo {
  name: string;
  display_name: string;
  description: string;
  group: string;
  group_label: string;
  group_description: string;
  core: boolean;
  /** 对外数据面工具：经 MCP 通道暴露给外部客户端（见「MCP」页签） */
  external: boolean;
  enabled: boolean;
}

/** 分组展示顺序（与后端 ToolGroup::all 一致） */
const GROUP_ORDER = ['perception', 'growth', 'interface', 'system', 'network'];

const SHELL_MODE_OPTIONS = [
  { value: 'confirm_all', label: '默认模式 — 每条命令都需系统弹窗确认' },
  { value: 'accept_edits', label: '可编辑模式 — 文件读取自动放行，Bash 需系统弹窗确认' },
  { value: 'unattended', label: '无打扰模式 — 文件读取与只读安全命令自动放行' },
];

export function ToolsSettings() {
  const { shell_permission_mode, setShellPermissionMode } = useSettingsStore();
  const { addToast } = useToastStore();

  const [tools, setTools] = useState<CompanionToolInfo[]>([]);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadTools = useCallback(async () => {
    try {
      const list = await invoke<CompanionToolInfo[]>('list_companion_tools');
      setTools(list);
    } catch (err) {
      console.error('Failed to load companion tools:', err);
    }
  }, []);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const handleToggle = async (tool: CompanionToolInfo, enabled: boolean) => {
    // 乐观更新，失败回滚
    setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled } : t)));
    try {
      await invoke('set_companion_tool_enabled', { name: tool.name, enabled });
    } catch (err) {
      setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled: !enabled } : t)));
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.display_name.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [tools, query]);

  // 权限模式选择器主要挂在「执行命令」下；它关闭而「读取文件」开启时下沉到后者
  const shellEnabled = useMemo(
    () => tools.some((t) => t.name === 'run_shell_command' && t.enabled),
    [tools]
  );

  const groups = useMemo(() => {
    const byGroup = new Map<string, CompanionToolInfo[]>();
    for (const t of filtered) {
      const list = byGroup.get(t.group) ?? [];
      list.push(t);
      byGroup.set(t.group, list);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
      const items = byGroup.get(g)!;
      return {
        id: g,
        label: items[0].group_label,
        description: items[0].group_description,
        tools: items,
        allCore: items.every((t) => t.core),
        enabledCount: items.filter((t) => t.enabled).length,
      };
    });
  }, [filtered]);

  const handleGroupToggle = async (groupTools: CompanionToolInfo[], enable: boolean) => {
    for (const t of groupTools.filter((t) => !t.core && t.enabled !== enable)) {
      await handleToggle(t, enable);
    }
  };

  return (
    <>

      {/* 搜索过滤 */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-tertiary" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工具名称或描述…"
          className="w-full bg-app-bg-tertiary border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors"
        />
      </div>

      <div>
        {groups.length === 0 && (
          <p className="text-app-text-disabled text-sm text-center py-8">没有匹配「{query}」的工具</p>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed[g.id] ?? false;
          return (
            <div key={g.id} className="mb-1">
              {/* 分组头（div + role=button：内部嵌 Toggle 按钮，不能用 button 标签） */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setCollapsed((prev) => ({ ...prev, [g.id]: !isCollapsed }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setCollapsed((prev) => ({ ...prev, [g.id]: !isCollapsed }));
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
              >
                <ChevronRight
                  size={14}
                  className={`text-app-text-tertiary transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                />
                <span className="text-app-text-primary text-sm font-medium">{g.label}</span>
                <span className="text-app-text-disabled text-xs">{g.description}</span>
                <span className="ml-auto flex items-center gap-2">
                  {g.allCore ? (
                    <span className="text-app-text-disabled text-xs">全部锁定</span>
                  ) : (
                    <>
                      <span className="text-app-text-tertiary text-xs">
                        {g.enabledCount}/{g.tools.length} 开启
                      </span>
                      <Toggle
                        enabled={g.tools.filter((t) => !t.core).every((t) => t.enabled)}
                        onToggle={(v) => handleGroupToggle(g.tools, v)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </>
                  )}
                </span>
              </div>

              {/* 工具行 */}
              {!isCollapsed && (
                <div>
                  {g.tools.map((t) => (
                    <div key={t.name} className="px-3 py-2.5 ml-6 rounded-lg hover:bg-white/5 transition-colors">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-app-text-primary text-sm font-medium">
                              {t.display_name}
                            </span>
                            <code className="text-app-text-disabled text-xs">{t.name}</code>
                            {t.external && (
                              <span
                                title="经 MCP 通道暴露给外部客户端（见「MCP」页签）"
                                className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-app-brand-primary-light"
                              >
                                MCP 开放
                              </span>
                            )}
                          </div>
                          <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">
                            {t.description}
                          </p>
                        </div>
                        <div className="flex-shrink-0">
                          {t.core ? (
                            <span className="flex items-center gap-1 text-app-text-disabled text-xs">
                              <Lock size={12} />
                              锁定
                            </span>
                          ) : (
                            <Toggle
                              enabled={t.enabled}
                              onToggle={(v) => handleToggle(t, v)}
                            />
                          )}
                        </div>
                      </div>

                      {/* 系统工具附加：权限模式（执行命令/读取文件共用，挂在首个开启者下） */}
                      {(t.name === 'run_shell_command' ||
                        (t.name === 'read_file' && !shellEnabled)) &&
                        t.enabled && (
                        <div className="mt-3 rounded-lg bg-white/5 px-3 py-2.5">
                          <div className="flex items-center gap-2 mb-2">
                            <Terminal size={13} className="text-app-text-tertiary" />
                            <span className="text-app-text-secondary text-xs font-medium">权限模式</span>
                          </div>
                          <CustomSelect
                            value={shell_permission_mode}
                            onChange={(v) => setShellPermissionMode(v)}
                            options={SHELL_MODE_OPTIONS}
                            searchable={false}
                          />
                          <p className="text-app-text-disabled text-xs mt-2 leading-relaxed">
                            需要确认时以系统原生弹窗形式弹出（在应用窗口之外），内容可见，
                            每次确认或拒绝都会写入本地审计记录。可编辑模式自动放行文件读取
                            （read_file），命令仍需确认；无打扰模式再放宽到只读命令
                            （dir、ipconfig、git status、npm list 等）。敏感文件（私钥、
                            凭证、浏览器数据等）在自动模式下直接拒绝，仅默认模式可确认放行；
                            灾难命令（格式化、删库、关机等）任何模式都直接拒绝。
                          </p>
                        </div>
                      )}

                      {/* Web 搜索附加：环境依赖提示 */}
                      {t.name === 'web_search' && t.enabled && (
                        <div className="mt-3 rounded-lg bg-white/5 px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <Globe size={13} className="text-app-text-tertiary flex-shrink-0" />
                            <span className="text-app-text-tertiary text-xs leading-relaxed">
                              经本机 Node.js 运行 open-webSearch（免 API
                              key）。首次搜索自动下载启动，需等几十秒；支持
                              bing/baidu/duckduckgo 等引擎。
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
