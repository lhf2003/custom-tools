import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Wrench, Search, ChevronRight, Lock, Terminal, Globe } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { Toggle } from '../components/SettingCard';
import { CustomSelect } from '../components/CustomSelect';

interface CompanionToolInfo {
  name: string;
  display_name: string;
  description: string;
  group: string;
  group_label: string;
  group_description: string;
  core: boolean;
  enabled: boolean;
}

/** 分组展示顺序（与后端 ToolGroup::all 一致） */
const GROUP_ORDER = ['perception', 'growth', 'interface', 'system', 'network'];

const SHELL_MODE_OPTIONS = [
  { value: 'confirm_all', label: '默认模式 — 每条命令都需确认' },
  { value: 'accept_edits', label: '可编辑模式 — 文件读写自动接受，Bash 需确认' },
  { value: 'unattended', label: '无打扰模式 — 只读安全命令自动放行' },
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
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-app-brand-primary/30 to-app-brand-primary/20 flex items-center justify-center">
          <Wrench size={20} className="text-app-brand-primary-light" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">工具</h2>
          <p className="text-white/40 text-xs">
            管理贾维斯可使用的工具。锁定工具为核心能力，不允许关闭。
          </p>
        </div>
      </div>

      {/* 搜索过滤 */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工具名称或描述…"
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/25 transition-colors"
        />
      </div>

      <div className="space-y-2">
        {groups.length === 0 && (
          <p className="text-white/30 text-sm text-center py-8">没有匹配「{query}」的工具</p>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed[g.id] ?? false;
          return (
            <div key={g.id} className="rounded-xl border border-white/10 overflow-hidden">
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
                className="w-full flex items-center gap-2 px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <ChevronRight
                  size={14}
                  className={`text-white/40 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                />
                <span className="text-white text-sm font-medium">{g.label}</span>
                <span className="text-white/30 text-xs">{g.description}</span>
                <span className="ml-auto flex items-center gap-2">
                  {g.allCore ? (
                    <span className="text-white/30 text-xs">全部锁定</span>
                  ) : (
                    <>
                      <span className="text-white/40 text-xs">
                        {g.enabledCount}/{g.tools.length} 开启
                      </span>
                      <span
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Toggle
                          enabled={g.tools.filter((t) => !t.core).every((t) => t.enabled)}
                          onToggle={(v) => handleGroupToggle(g.tools, v)}
                        />
                      </span>
                    </>
                  )}
                </span>
              </div>

              {/* 工具行 */}
              {!isCollapsed && (
                <div className="divide-y divide-white/5">
                  {g.tools.map((t) => (
                    <div key={t.name} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-white/90 text-sm font-medium">
                              {t.display_name}
                            </span>
                            <code className="text-white/30 text-xs">{t.name}</code>
                          </div>
                          <p className="text-white/40 text-xs mt-0.5 leading-relaxed">
                            {t.description}
                          </p>
                        </div>
                        <div className="flex-shrink-0">
                          {t.core ? (
                            <span className="flex items-center gap-1 text-white/25 text-xs">
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

                      {/* Shell 工具附加：权限模式 */}
                      {t.name === 'run_shell_command' && t.enabled && (
                        <div className="mt-3 rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2.5">
                          <div className="flex items-center gap-2 mb-2">
                            <Terminal size={13} className="text-white/40" />
                            <span className="text-white/60 text-xs font-medium">权限模式</span>
                          </div>
                          <CustomSelect
                            value={shell_permission_mode}
                            onChange={(v) => setShellPermissionMode(v)}
                            options={SHELL_MODE_OPTIONS}
                            searchable={false}
                          />
                          <p className="text-white/30 text-xs mt-2 leading-relaxed">
                            确认在聊天窗口弹出，命令内容可见，120 秒未操作视为拒绝。
                            无打扰模式自动放行只读命令（dir、ipconfig、git status、npm
                            list 等）；灾难命令（格式化、删库、关机等）任何模式都直接拒绝。
                          </p>
                        </div>
                      )}

                      {/* Web 搜索附加：环境依赖提示 */}
                      {t.name === 'web_search' && t.enabled && (
                        <div className="mt-3 rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <Globe size={13} className="text-white/40" />
                            <span className="text-white/40 text-xs leading-relaxed">
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
