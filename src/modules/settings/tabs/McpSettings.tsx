import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Plug, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { confirmDialog } from '@/stores/confirmStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';

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

interface ExternalServerInfo {
  name: string;
  display_name: string;
  url: string;
  enabled: boolean;
  connected: boolean;
  last_error: string;
  has_token: boolean;
  tools: { name: string; description: string }[];
}

/** slug 预览校验（权威校验在后端）：ASCII 字母数字_-，不含连续双下划线 */
function slugError(name: string): string | null {
  if (!name) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '仅限字母、数字、下划线、连字符';
  if (name.includes('__')) return '不能包含连续双下划线（它是工具前缀分隔符）';
  return null;
}

/** 第三方 server 卡片：状态/工具数/总开关/刷新/删除 */
function ExternalServerCard({
  server,
  onToggle,
  onRefresh,
  onDelete,
  refreshing,
}: {
  server: ExternalServerInfo;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
  onDelete: () => void;
  refreshing: boolean;
}) {
  const shownName = server.display_name || server.name;
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-app-text-primary text-sm font-medium">{shownName}</span>
        {server.display_name && (
          <code className="text-app-text-disabled text-xs">{server.name}</code>
        )}
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
            onClick={onRefresh}
            disabled={refreshing}
            title="重新连接并刷新工具清单"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-status-error hover:bg-app-status-error/10 transition-colors cursor-pointer"
          >
            <Trash2 size={13} />
          </button>
          <Toggle enabled={server.enabled} onToggle={onToggle} />
        </span>
      </div>
      <p className="text-app-text-disabled text-xs mt-1 truncate">{server.url}</p>
      {!server.connected && server.last_error && (
        <p className="text-app-status-warning-text text-xs mt-1 leading-relaxed">
          {server.last_error}
        </p>
      )}
      {server.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {server.tools.map((t) => (
            <code
              key={t.name}
              title={t.description}
              className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-app-text-tertiary"
            >
              {t.name}
            </code>
          ))}
        </div>
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
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      console.error('[mcp-settings] 加载失败:', err);
    }
  }, []);

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

  const resetImport = () => {
    setImporting(false);
    setSlug('');
    setDisplayName('');
    setUrl('');
    setToken('');
  };

  /** 导入：先强制验证（force=false）；验证失败弹确认「仍然保存」后以 force=true 重调 */
  const doImport = async (force: boolean): Promise<boolean> => {
    try {
      const created = await invoke<ExternalServerInfo>('import_external_mcp_server', {
        name: slug.trim(),
        displayName: displayName.trim(),
        url: url.trim(),
        token: token.trim(),
        force,
      });
      addToast({
        type: 'success',
        title: `已导入「${created.display_name || created.name}」`,
        message: created.connected
          ? `${created.tools.length} 个工具已就绪，下一轮聊天即可调用`
          : '已保存为未连接状态，修复后可点刷新重连',
        duration: 4000,
      });
      resetImport();
      await load();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!force && msg.includes('连接验证失败')) {
        const ok = await confirmDialog({
          title: '连接验证失败',
          message: msg,
          detail: '可以仍然保存（标记为未连接），稍后网络/token 修复后点刷新重连。',
          confirmLabel: '仍然保存',
        });
        if (ok) return doImport(true);
      } else {
        addToast({ type: 'error', title: '导入失败', message: msg, duration: 5000 });
      }
      return false;
    }
  };

  const handleImport = async () => {
    setSubmitting(true);
    try {
      await doImport(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleServer = async (server: ExternalServerInfo, enabled: boolean) => {
    setServers((prev) => prev.map((s) => (s.name === server.name ? { ...s, enabled } : s)));
    try {
      await invoke('set_external_mcp_server_enabled', { name: server.name, enabled });
    } catch (err) {
      setServers((prev) => prev.map((s) => (s.name === server.name ? { ...s, enabled: !enabled } : s)));
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const handleRefresh = async (server: ExternalServerInfo) => {
    setRefreshing((prev) => ({ ...prev, [server.name]: true }));
    try {
      const updated = await invoke<ExternalServerInfo>('refresh_external_mcp_server', {
        name: server.name,
      });
      setServers((prev) => prev.map((s) => (s.name === server.name ? updated : s)));
      addToast({
        type: updated.connected ? 'success' : 'error',
        title: updated.connected
          ? `「${updated.display_name || updated.name}」已刷新`
          : `「${updated.display_name || updated.name}」连接失败`,
        message: updated.connected ? `${updated.tools.length} 个工具` : updated.last_error,
        duration: 4000,
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: '刷新失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    } finally {
      setRefreshing((prev) => ({ ...prev, [server.name]: false }));
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

  const slugHint = slugError(slug.trim());
  const canSubmit = !submitting && slug.trim() && !slugHint && url.trim();

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
          !importing ? (
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
            >
              导入 server
            </button>
          ) : undefined
        }
      >
        {servers.length === 0 && !importing && (
          <div className="px-3 py-3 text-app-text-disabled text-xs leading-relaxed">
            还没有导入的 server。从 MCP 市场（如 modelscope.cn/mcp）挑选托管 server，
            复制其 streamable HTTP 地址（/mcp 结尾）与 token 即可导入，贾维斯聊天中直接调用其工具。
          </div>
        )}
        {servers.map((s) => (
          <ExternalServerCard
            key={s.name}
            server={s}
            refreshing={refreshing[s.name] ?? false}
            onToggle={(v) => void handleToggleServer(s, v)}
            onRefresh={() => void handleRefresh(s)}
            onDelete={() => void handleDelete(s)}
          />
        ))}

        {/* 导入面板（内联展开） */}
        {importing && (
          <div className="px-3 py-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="标识名（如 fetch）*"
                  className="w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors font-mono"
                />
                {slugHint && (
                  <p className="text-app-status-warning-text text-[10px] mt-1">{slugHint}</p>
                )}
              </div>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="显示名（可中文，选填）"
                className="w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors"
              />
            </div>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="server 地址（https://…/mcp）*"
              className="w-full mt-2 bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors font-mono"
            />
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token（选填，自动组 Authorization: Bearer；仅本地保存）"
              className="w-full mt-2 bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors font-mono"
            />
            <p className="text-app-text-disabled text-xs mt-2.5 leading-relaxed">
              导入时会实际连接验证并抓取工具清单；server 返回的工具数据在聊天中按不可信外部数据处理。
              标识名会成为工具名前缀（{slug.trim() || 'fetch'}__工具名），导入后不可改；token 仅本地明文保存，更换请删除后重新导入。
            </p>
            <div className="flex justify-end gap-2 mt-2.5">
              <button
                type="button"
                onClick={resetImport}
                className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleImport()}
                className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? '验证中…' : '验证并导入'}
              </button>
            </div>
          </div>
        )}
      </SettingGroup>
    </>
  );
}
