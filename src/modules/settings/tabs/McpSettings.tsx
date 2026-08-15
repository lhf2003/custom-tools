import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Plug, RefreshCw, ScrollText, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { confirmDialog } from '@/stores/confirmStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { AddServerModal, CallLogModal, EditServerModal } from './McpServerModals';
import type { ExternalServerInfo } from './McpServerModals';

interface McpServerInfo {
  name: string;
  version: string;
  protocol_version: string;
  external_tools: string[];
}

interface McpRegistrationStatus {
  registered: boolean;
  correct: boolean;
  detail: string;
}

/** 第三方 server 卡片：名称/状态/日志/配置/删除/迷你开关（工具与配置详情进配置弹窗） */
function ExternalServerCard({
  server,
  onToggle,
  onDelete,
  onSaved,
}: {
  server: ExternalServerInfo;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const [editing, setEditing] = useState(false);
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
            onClick={() => setEditing(true)}
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
      {editing && (
        <EditServerModal
          server={server}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

/** MCP 页：内置 companion server 卡片 + 外部客户端注册自愈 + 第三方 server 管理 */
export function McpSettings() {
  const { addToast } = useToastStore();
  const [info, setInfo] = useState<McpServerInfo | null>(null);
  const [status, setStatus] = useState<McpRegistrationStatus | null>(null);
  const [fixing, setFixing] = useState(false);

  // 第三方 server
  const [servers, setServers] = useState<ExternalServerInfo[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [serverInfo, regStatus, external] = await Promise.all([
        invoke<McpServerInfo>('get_mcp_server_info'),
        invoke<McpRegistrationStatus>('check_mcp_registration'),
        invoke<ExternalServerInfo[]>('list_external_mcp_servers'),
      ]);
      setInfo(serverInfo);
      setStatus(regStatus);
      setServers(external);
    } catch (err) {
      // 加载失败要有用户可见反馈，不能停在「检测中…」假状态（CASE-001 M5）
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

  const handleFix = async () => {
    setFixing(true);
    try {
      const msg = await invoke<string>('fix_mcp_registration');
      addToast({ type: 'success', title: '注册已修复', message: msg, duration: 4000 });
      await load();
    } catch (err) {
      addToast({
        type: 'error',
        title: '修复失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    } finally {
      setFixing(false);
    }
  };

  const handleToggleServer = async (server: ExternalServerInfo, enabled: boolean) => {
    setServers((prev) => prev.map((s) => (s.name === server.name ? { ...s, enabled } : s)));
    try {
      await invoke('set_external_mcp_server_enabled', { name: server.name, enabled });
    } catch (err) {
      // 回滚前校验列表仍是本次乐观值：双击竞态下乱序完成的后失败者
      // 不能覆盖先成功者的状态（CASE-001 L7）
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

  const statusTone = !status
    ? 'text-app-text-tertiary'
    : status.correct
      ? 'text-app-status-success'
      : 'text-app-status-warning-text';

  return (
    <>
      {/* 内置 server 卡片 */}
      <SettingGroup title="内置 MCP server">
        <div className="px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
              <Plug size={15} className="text-app-text-secondary" />
            </div>
            <span className="text-app-text-primary text-sm font-medium">{info?.name ?? 'companion'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-app-text-secondary">内置</span>
            <span className="text-app-text-disabled text-xs">v{info?.version ?? '—'}</span>
          </div>
          <p className="text-app-text-tertiary text-xs mt-2 leading-relaxed">
            将本系统的数据能力暴露给外部 MCP 客户端（如 Claude Code），内在状态与执行类工具仅应用内可用。
          </p>
          {info && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {info.external_tools.map((t) => (
                <code
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-app-text-tertiary"
                >
                  {t}
                </code>
              ))}
            </div>
          )}
        </div>
      </SettingGroup>

      {/* 外部客户端注册自愈 */}
      <SettingGroup
        title="外部客户端注册"
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw size={12} />
            刷新
          </button>
        }
      >
        <SettingRow
          title="Claude Code"
          description={
            <>
              <span className={statusTone}>{status?.detail ?? '检测中…'}</span>
              <br />
              注册到 ~/.claude.json 后，在 Claude Code 里可直接调用上方的对外工具。
              应用升级或迁移后注册信息可能漂移，一键修复会重新指向当前安装（修复前自动备份原配置）。
            </>
          }
        >
          {status?.correct ? (
            <span className="flex items-center gap-1 text-app-status-success text-xs">
              <CheckCircle2 size={13} />
              正常
            </span>
          ) : (
            <button
              type="button"
              disabled={fixing}
              onClick={() => void handleFix()}
              className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <ShieldAlert size={12} />
              {fixing ? '修复中…' : status?.registered ? '立即修复' : '立即注册'}
            </button>
          )}
        </SettingRow>
      </SettingGroup>

      {/* 第三方 server 管理 */}
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
            onSaved={() => void load()}
          />
        ))}
      </SettingGroup>

      {adding && (
        <AddServerModal onClose={() => setAdding(false)} onImported={() => void load()} />
      )}
    </>
  );
}
