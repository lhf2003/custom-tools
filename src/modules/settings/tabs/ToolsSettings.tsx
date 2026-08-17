import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Search, ChevronRight, Lock, Terminal, Globe, Copy, Plug, ScrollText, Settings2, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { confirmDialog } from '@/stores/confirmStore';
import { SettingGroup, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect } from '../components/CustomSelect';
import { AddServerModal, CallLogModal } from './McpServerModals';
import type { ExternalServerInfo } from './McpServerModals';

interface CompanionToolInfo {
  name: string;
  display_name: string;
  description: string;
  group: string;
  group_label: string;
  group_description: string;
  core: boolean;
  /** 对外数据面工具：经 MCP 通道暴露给外部客户端（见本页下方 MCP 区块） */
  external: boolean;
  enabled: boolean;
}

/** 分组展示顺序（与后端 ToolGroup::all 一致） */
const GROUP_ORDER = ['perception', 'growth', 'interface', 'system', 'network'];

const SHELL_MODE_OPTIONS = [
  { value: 'confirm_all', label: '默认模式 — 每条命令都需系统弹窗确认' },
  { value: 'accept_edits', label: '可编辑模式 — 文件读取自动放行，Bash 需系统弹窗确认' },
  { value: 'unattended', label: '无打扰模式 — 黑名单之外的命令自动放行' },
];

interface McpServerInfo {
  name: string;
  version: string;
  protocol_version: string;
  external_tools: string[];
}

/** 第三方 server 卡片：名称/状态/日志/配置/删除/迷你开关（配置详情进二级页面） */
function ExternalServerCard({
  server,
  onToggle,
  onDelete,
  onEdit,
}: {
  server: ExternalServerInfo;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const shownName = server.display_name || server.name;
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-app-text-primary text-sm font-medium">{shownName}</span>
        {server.display_name && (
          <code className="text-app-text-disabled text-xs">{server.name}</code>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-app-text-tertiary">
          {server.transport}
        </span>
        {server.connected ? (
          <span className="flex items-center gap-1 text-app-status-success text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-app-status-success" />
            已连接
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-app-status-warning-text text-xs"
            title={server.last_error || '尚未通过连接验证'}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-app-status-warning" />
            未连接
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowLog(true)}
            title="调用日志"
            aria-label="调用日志"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <ScrollText size={13} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            title="配置与工具"
            aria-label="配置与工具"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除"
            aria-label="删除"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-status-error hover:bg-app-status-error/10 transition-colors cursor-pointer"
          >
            <Trash2 size={13} />
          </button>
          <Toggle size="mini" enabled={server.enabled} onToggle={onToggle} />
        </span>
      </div>
      {showLog && <CallLogModal serverName={shownName} slug={server.name} onClose={() => setShowLog(false)} />}
    </div>
  );
}

/** MCP 区块（原独立 MCP 页签，现并入「工具」页）：本地 MCP 服务 + 第三方 server 管理 */
function McpSection() {
  const { addToast } = useToastStore();
  const [info, setInfo] = useState<McpServerInfo | null>(null);

  // 第三方 server
  const [servers, setServers] = useState<ExternalServerInfo[]>([]);
  const [adding, setAdding] = useState(false);
  // 进入第三方 server 的独立编辑二级页面（设置页内容区整体切换）
  const setMcpEditServer = useSettingsStore((s) => s.setMcpEditServer);

  const load = useCallback(async () => {
    try {
      const [serverInfo, external] = await Promise.all([
        invoke<McpServerInfo>('get_mcp_server_info'),
        invoke<ExternalServerInfo[]>('list_external_mcp_servers'),
      ]);
      setInfo(serverInfo);
      setServers(external);
    } catch (err) {
      addToast({
        type: 'error',
        title: 'MCP 设置加载失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 5000,
      });
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCopyConfig = async () => {
    try {
      const config = await invoke<string>('get_mcp_config');
      await navigator.clipboard.writeText(config);
      addToast({ type: 'success', title: '已复制本地 MCP 配置', duration: 3000 });
    } catch (err) {
      addToast({
        type: 'error',
        title: '复制失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const handleToggleServer = async (server: ExternalServerInfo, enabled: boolean) => {
    setServers((prev) => prev.map((s) => (s.name === server.name ? { ...s, enabled } : s)));
    try {
      await invoke('set_external_mcp_server_enabled', { name: server.name, enabled });
    } catch (err) {
      setServers((prev) =>
        prev.map((s) =>
          s.name === server.name && s.enabled === enabled ? { ...s, enabled: !enabled } : s
        )
      );
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const handleDelete = async (server: ExternalServerInfo) => {
    const shown = server.display_name || server.name;
    const ok = await confirmDialog({
      title: '删除 server',
      message: `确定删除「${shown}」吗？`,
      detail: '删除后其全部工具立即退出聊天能力，工具级开关设置一并清除。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('delete_external_mcp_server', { name: server.name });
      setServers((prev) => prev.filter((s) => s.name !== server.name));
      addToast({ type: 'success', title: `已删除「${shown}」`, duration: 3000 });
    } catch (err) {
      addToast({
        type: 'error',
        title: '删除失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  return (
    <>
      {/* 第三方 server 管理（放在 MCP 标题下，最先） */}
      <SettingGroup
        title="第三方 MCP server"
        actions={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            添加
          </button>
        }
      >
        {servers.length === 0 && (
          <div className="px-3 py-3 text-app-text-disabled text-xs leading-relaxed">
            还没有添加的 server。从 MCP 市场复制配置（stdio 或 HTTP 均可），或手动填写——
            添加后贾维斯在聊天中可直接调用其工具。
          </div>
        )}
        {servers.map((s) => (
          <ExternalServerCard
            key={s.name}
            server={s}
            onToggle={(v) => void handleToggleServer(s, v)}
            onDelete={() => void handleDelete(s)}
            onEdit={() => setMcpEditServer(s)}
          />
        ))}
      </SettingGroup>

      {/* 本地 MCP 服务卡片 */}
      <SettingGroup title="本地 MCP 服务">
        <div className="px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
              <Plug size={15} className="text-app-text-secondary" />
            </div>
            <span className="text-app-text-primary text-sm font-medium">{info?.name ?? 'companion'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-app-text-secondary">本地</span>
            <span className="text-app-text-disabled text-xs">v{info?.version ?? '—'}</span>
            <button
              type="button"
              onClick={() => void handleCopyConfig()}
              title="复制本地 MCP 配置（JSON）"
              aria-label="复制本地 MCP 配置"
              className="ml-auto p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Copy size={13} />
            </button>
          </div>
          <p className="text-app-text-tertiary text-xs mt-2 leading-relaxed">
            将本系统的数据能力暴露给外部 MCP 客户端（如 Claude Code），需要本应用保持运行状态。
          </p>
        </div>
      </SettingGroup>

      {adding && (
        <AddServerModal onClose={() => setAdding(false)} onImported={() => void load()} />
      )}
    </>
  );
}

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
    const toGroup = (g: string) => {
      const items = byGroup.get(g)!;
      return {
        id: g,
        label: items[0].group_label,
        description: items[0].group_description,
        tools: items,
        allCore: items.every((t) => t.core),
        enabledCount: items.filter((t) => t.enabled).length,
      };
    };
    // 内置组按固定顺序；外部服务组（external:{server}）按 server 追加在后
    const builtin = GROUP_ORDER.filter((g) => byGroup.has(g)).map(toGroup);
    const external = [...byGroup.keys()]
      .filter((g) => g.startsWith('external:'))
      .map(toGroup);
    return [...builtin, ...external];
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
          const isCollapsed = collapsed[g.id] ?? true;
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
                                title="经 MCP 通道暴露给外部客户端（见本页下方 MCP 区块）"
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
                            （read_file），命令仍需确认；无打扰模式为黑名单制——仅以下命令弹窗：
                            删除/覆盖文件（del、copy、move 等）、写文件重定向（&gt;）、装包
                            （npm install 等）、git 写操作（commit、push 等）、reg add、
                            taskkill、解释器内联代码（python -c、PowerShell）、下载写文件；
                            只读查询、组合探测（&amp; 串联、2&gt;nul）、运行脚本/构建、
                            start 启动程序均自动放行。敏感文件（私钥、凭证、浏览器数据等）
                            在自动模式下直接拒绝，仅默认模式可确认放行；
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

      {/* MCP：原独立「MCP」页签的展示页，现并入工具页 */}
      <div className="mt-8 pt-6 border-t border-app-border-subtle">
        <h3 className="px-3 mb-2 text-sm font-semibold text-app-text-primary">MCP</h3>
        <McpSection />
      </div>
    </>
  );
}
