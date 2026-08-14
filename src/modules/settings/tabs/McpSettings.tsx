import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Plug, RefreshCw, ShieldAlert } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { SettingGroup, SettingRow } from '../components/SettingsPrimitives';

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

/** MCP 页：内置 companion server 卡片 + 外部客户端注册自愈 + 第三方导入入口（二期） */
export function McpSettings() {
  const { addToast } = useToastStore();
  const [info, setInfo] = useState<McpServerInfo | null>(null);
  const [status, setStatus] = useState<McpRegistrationStatus | null>(null);
  const [fixing, setFixing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [serverInfo, regStatus] = await Promise.all([
        invoke<McpServerInfo>('get_mcp_server_info'),
        invoke<McpRegistrationStatus>('check_mcp_registration'),
      ]);
      setInfo(serverInfo);
      setStatus(regStatus);
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

      {/* 第三方导入（二期占位） */}
      <SettingGroup title="第三方 MCP server">
        <div className="px-3 py-3">
          <p className="text-app-text-tertiary text-xs leading-relaxed">
            即将开放：从 MCP 市场（如 modelscope.cn/mcp）挑选好用的 server 导入到这里，
            与内置 companion 并列管理，供贾维斯在聊天中调用。
          </p>
        </div>
      </SettingGroup>
    </>
  );
}
