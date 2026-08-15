import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Plug, RefreshCw, ScrollText, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
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
  description: string;
  transport: string;
  url: string;
  command: string;
  args: string[];
  enabled: boolean;
  connected: boolean;
  last_error: string;
  secret_entries: string[];
  has_secret: boolean;
  tools: { name: string; description: string }[];
}

/** slug 预览校验（权威校验在后端）：ASCII 字母数字_-，不含连续双下划线 */
function slugError(name: string): string | null {
  if (!name) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '仅限字母、数字、下划线、连字符';
  if (name.includes('__')) return '不能包含连续双下划线（它是工具前缀分隔符）';
  return null;
}

/** KV 文本解析：每行 `key=value` 或 `key: value`（取第一个分隔符），空行跳过 */
function parseKv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.search(/[:=]/);
    if (sep <= 0) continue;
    out.push({
      key: trimmed.slice(0, sep).trim(),
      value: trimmed.slice(sep + 1).trim(),
    });
  }
  return out;
}

/** 参数文本：每行一个（含空格的参数保真） */
function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const JSON_TEMPLATE = `{
  "标识名": {
    "command": "npx",
    "args": ["-y", "包名"],
    "env": {}
  }
}`;

const inputCls =
  'w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors';

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
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <ScrollText size={13} />
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="配置与工具"
            className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除"
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

/** 配置编辑弹窗：表单预填（凭据只列 key、值留空=保持不变）+ 工具描述只读区 */
function EditServerModal({
  server,
  onClose,
  onSaved,
}: {
  server: ExternalServerInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToastStore();
  const [description, setDescription] = useState(server.description);
  const [transport, setTransport] = useState<'stdio' | 'http'>(
    server.transport === 'stdio' ? 'stdio' : 'http'
  );
  const [command, setCommand] = useState(server.command);
  const [argsText, setArgsText] = useState(server.args.join('\n'));
  // 凭据只列出 key、值为空：留空=保持原值，删行=清除该凭据
  const [envText, setEnvText] = useState(server.secret_entries.map((k) => `${k}: `).join('\n'));
  const [url, setUrl] = useState(server.url);
  const [headersText, setHeadersText] = useState(
    server.secret_entries.map((k) => `${k}: `).join('\n')
  );
  const [submitting, setSubmitting] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [refreshingTools, setRefreshingTools] = useState(false);
  // 弹窗内数据镜像：刷新工具清单就地更新，不动父列表
  const [current, setCurrent] = useState(server);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusable = contentRef.current?.querySelector<HTMLElement>('input, textarea, button');
    focusable?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleRefreshTools = async () => {
    setRefreshingTools(true);
    try {
      const updated = await invoke<ExternalServerInfo>('refresh_external_mcp_server', {
        name: server.name,
      });
      setCurrent(updated);
      setExpandedTools({});
      addToast({
        type: updated.connected ? 'success' : 'error',
        title: updated.connected ? '工具清单已刷新' : '刷新失败',
        message: updated.connected
          ? `${updated.tools.length} 个工具`
          : updated.last_error,
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
      setRefreshingTools(false);
    }
  };

  const doUpdate = async (force: boolean): Promise<boolean> => {
    const config = {
      name: server.name,
      description: description.trim(),
      transport,
      url: url.trim(),
      headers: parseKv(headersText),
      command: command.trim(),
      args: parseArgs(argsText),
      env: parseKv(envText),
    };
    try {
      const updated = await invoke<ExternalServerInfo>('update_external_mcp_server', {
        name: server.name,
        config: JSON.stringify(config),
        force,
      });
      addToast({
        type: 'success',
        title: `「${updated.display_name || updated.name}」已保存`,
        message: updated.connected
          ? `${updated.tools.length} 个工具已刷新`
          : '保存为未连接状态，修复后可再保存重试',
        duration: 4000,
      });
      onSaved();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!force && msg.includes('连接验证失败')) {
        const ok = await confirmDialog({
          title: '连接验证失败',
          message: msg,
          detail: '可以仍然保存（标记为未连接），稍后网络/token 修复后重试。',
          confirmLabel: '仍然保存',
        });
        if (ok) return doUpdate(true);
      } else {
        addToast({ type: 'error', title: '保存失败', message: msg, duration: 5000 });
      }
      return false;
    }
  };

  const handleSave = async () => {
    setSubmitting(true);
    try {
      await doUpdate(false);
    } finally {
      setSubmitting(false);
    }
  };

  const ready = !submitting && (transport === 'stdio' ? command.trim() : url.trim());

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- 遮罩点击关闭是 ESC 的鼠标等价路径
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={contentRef}
        className="bg-app-bg-elevated rounded-xl p-5 w-[440px] max-h-[75vh] flex flex-col border border-white/10 shadow-2xl"
      >
        <div className="flex items-center gap-2 flex-shrink-0">
          <h3 className="text-app-text-primary text-sm font-semibold">配置 · {server.name}</h3>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto min-h-0 space-y-2">
          {/* 类型切换 */}
          <div className="flex gap-1 p-1 rounded-lg bg-white/5">
            {(
              [
                ['stdio', '标准输入/输出（stdio）'],
                ['http', '可流式传输的 HTTP'],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTransport(t)}
                className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                  transport === t
                    ? 'bg-white/10 text-app-text-primary font-medium'
                    : 'text-app-text-tertiary hover:text-app-text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {transport === 'stdio' ? (
            <>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="命令（npx / node / python…）*"
                className={`${inputCls} font-mono`}
              />
              <div>
                <p className="text-app-text-tertiary text-[10px] mb-1">参数（每行一个，选填）</p>
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={'-y\n@upstash/context7-mcp'}
                  rows={3}
                  className={`${inputCls} font-mono resize-y`}
                />
              </div>
              <div>
                <p className="text-app-text-tertiary text-[10px] mb-1">
                  环境变量（每行 key=value，选填）
                </p>
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={'API_KEY=sk-…'}
                  rows={2}
                  className={`${inputCls} font-mono resize-y`}
                />
              </div>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述（能力说明，选填）"
                className={inputCls}
              />
            </>
          ) : (
            <>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="server 地址（https://…/mcp）*"
                className={`${inputCls} font-mono`}
              />
              <div>
                <p className="text-app-text-tertiary text-[10px] mb-1">
                  请求头（每行 key: value，选填）
                </p>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={'Authorization: Bearer sk-…'}
                  rows={2}
                  className={`${inputCls} font-mono resize-y`}
                />
              </div>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述（能力说明，选填）"
                className={inputCls}
              />
            </>
          )}

          {server.secret_entries.length > 0 && (
            <p className="text-app-text-disabled text-xs leading-relaxed">
              已配置的凭据键以「key: 」形式列出：留空保存 = 保持原值；删除整行 = 清除该凭据；
              填入新值 = 覆盖。凭据值本身不回显。
            </p>
          )}

          {/* 工具清单（只读，可刷新） */}
          <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-app-text-secondary text-xs">
                工具清单（{current.tools.length}）
              </p>
              <button
                type="button"
                onClick={() => void handleRefreshTools()}
                disabled={refreshingTools}
                className="flex items-center gap-1 text-app-text-tertiary text-[10px] hover:text-app-text-primary transition-colors cursor-pointer disabled:opacity-40"
              >
                <RefreshCw size={11} className={refreshingTools ? 'animate-spin' : ''} />
                {refreshingTools ? '刷新中…' : '刷新工具清单'}
              </button>
            </div>
            {current.tools.length === 0 ? (
              <p className="text-app-text-disabled text-xs">
                暂无工具快照——刷新或保存后重新连接即可抓取
              </p>
            ) : (
              <div className="space-y-1">
                {current.tools.map((t) => {
                  const desc = t.description || '（无描述）';
                  const long = desc.length > 80;
                  const expanded = expandedTools[t.name] ?? false;
                  const toggle = () =>
                    setExpandedTools((prev) => ({ ...prev, [t.name]: !expanded }));
                  return (
                    <div key={t.name} className="flex items-start gap-2">
                      <code className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-app-text-tertiary flex-shrink-0 mt-px">
                        {t.name}
                      </code>
                      {/* 截断态：JS 裁剪 + 常规 inline 按钮（line-clamp 的 -webkit-box
                          布局里 inline 按钮不混排，会被裁掉——弃用）；描述与按钮整体
                          最多两行；展开态：全文 + 行内「收起」 */}
                      <p className="min-w-0 flex-1 text-app-text-tertiary text-xs leading-relaxed break-words">
                        {long && !expanded ? (
                          <span>
                            {desc.slice(0, 60)}
                            <button
                              type="button"
                              onClick={toggle}
                              className="text-app-brand-primary-light text-[10px] hover:underline cursor-pointer"
                            >
                              …展开
                            </button>
                          </span>
                        ) : (
                          <>
                            {desc}
                            {long && (
                              <button
                                type="button"
                                onClick={toggle}
                                className="text-app-brand-primary-light text-[10px] ml-1 hover:underline cursor-pointer"
                              >
                                收起
                              </button>
                            )}
                          </>
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-3 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void handleSave()}
            className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '验证中…' : '保存并验证'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CallLogRow {
  tool_name: string;
  status: string;
  duration_ms: number;
  result_len: number;
  created_at: number;
}

/** 调用日志弹窗：per-server 最近 50 条（新在前） */
function CallLogModal({
  serverName,
  slug,
  onClose,
}: {
  serverName: string;
  slug: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CallLogRow[] | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<CallLogRow[]>('list_mcp_tool_calls', { serverName: slug })
      .then(setRows)
      .catch((err: unknown) => {
        console.error('[mcp-log] 加载失败:', err);
        setRows([]);
      });
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [slug, onClose]);

  const fmtTime = (ts: number): string => {
    const d = new Date(ts * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- 遮罩点击关闭是 ESC 的鼠标等价路径
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={contentRef}
        className="bg-app-bg-elevated rounded-xl p-5 w-[440px] max-h-[70vh] flex flex-col border border-white/10 shadow-2xl"
      >
        <h3 className="text-app-text-primary text-sm font-semibold flex-shrink-0">
          调用日志 · {serverName}
        </h3>
        <div className="mt-3 flex-1 overflow-y-auto min-h-0">
          {rows === null ? (
            <p className="text-app-text-disabled text-xs py-4 text-center">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="text-app-text-disabled text-xs py-4 text-center">
              还没有调用记录——聊天里用到该 server 的工具后会出现在这里
            </p>
          ) : (
            <div className="space-y-1">
              {rows.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-white/5"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      r.status === 'ok' ? 'bg-app-status-success' : 'bg-app-status-error'
                    }`}
                    title={r.status === 'ok' ? '成功' : '失败'}
                  />
                  <code className="text-app-text-secondary text-xs flex-1 min-w-0 truncate">
                    {r.tool_name}
                  </code>
                  <span className="text-app-text-disabled text-[10px] flex-shrink-0">
                    {r.duration_ms}ms
                  </span>
                  <span className="text-app-text-disabled text-[10px] flex-shrink-0">
                    {r.result_len >= 1024
                      ? `${(r.result_len / 1024).toFixed(1)}KB`
                      : `${r.result_len}B`}
                  </span>
                  <span className="text-app-text-disabled text-[10px] font-mono flex-shrink-0">
                    {fmtTime(r.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end mt-3 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 添加 server 弹窗：手动配置（类型切换双表单）与 JSON 导入双方式 */
function AddServerModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { addToast } = useToastStore();
  const [mode, setMode] = useState<'manual' | 'json'>('manual');

  // 手动表单
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');

  // JSON 导入
  const [jsonText, setJsonText] = useState(JSON_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusable = contentRef.current?.querySelector<HTMLElement>('input, textarea, button');
    focusable?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /** 统一导入通道：验证失败 → 确认「仍然保存」→ force 重调 */
  const doImport = async (
    invokeArgs: Record<string, unknown>,
    isJson: boolean,
    force: boolean
  ): Promise<boolean> => {
    try {
      const command = isJson ? 'import_external_mcp_server_json' : 'import_external_mcp_server';
      const created = await invoke<ExternalServerInfo>(command, { ...invokeArgs, force });
      addToast({
        type: 'success',
        title: `已添加「${created.display_name || created.name}」`,
        message: created.connected
          ? `${created.tools.length} 个工具已就绪，下一轮聊天即可调用`
          : '已保存为未连接状态，修复后可点刷新重连',
        duration: 4000,
      });
      onImported();
      onClose();
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
        if (ok) return doImport(invokeArgs, isJson, true);
      } else {
        addToast({ type: 'error', title: '添加失败', message: msg, duration: 5000 });
      }
      return false;
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      if (mode === 'json') {
        await doImport({ raw: jsonText }, true, false);
      } else {
        const config = {
          name: name.trim(),
          description: description.trim(),
          transport,
          url: url.trim(),
          headers: parseKv(headersText),
          command: command.trim(),
          args: parseArgs(argsText),
          env: parseKv(envText),
        };
        await doImport({ config: JSON.stringify(config) }, false, false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const slugHint = slugError(name.trim());
  const manualReady =
    name.trim() &&
    !slugHint &&
    (transport === 'stdio' ? command.trim() : url.trim()) &&
    !submitting;

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- 遮罩点击关闭是 ESC 与取消按钮的鼠标等价路径
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={contentRef}
        className="bg-app-bg-elevated rounded-xl p-5 w-[420px] max-h-[75vh] flex flex-col border border-white/10 shadow-2xl"
      >
        <h3 className="text-app-text-primary text-sm font-semibold flex-shrink-0">添加 MCP server</h3>

        {/* 方式切换 */}
        <div className="flex gap-1 mt-3 p-1 rounded-lg bg-white/5 flex-shrink-0">
          {(
            [
              ['manual', '手动配置'],
              ['json', 'JSON 导入'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                mode === m
                  ? 'bg-white/10 text-app-text-primary font-medium'
                  : 'text-app-text-tertiary hover:text-app-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'manual' ? (
          <div className="mt-3 space-y-2 flex-1 overflow-y-auto min-h-0">
            <div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="标识名（如 fetch）*"
                className={`${inputCls} font-mono`}
              />
              {slugHint && (
                <p className="text-app-status-warning-text text-[10px] mt-1">{slugHint}</p>
              )}
            </div>
            {/* 类型切换 */}
            <div className="flex gap-1 p-1 rounded-lg bg-white/5">
              {(
                [
                  ['stdio', '标准输入/输出（stdio）'],
                  ['http', '可流式传输的 HTTP'],
                ] as const
              ).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                    transport === t
                      ? 'bg-white/10 text-app-text-primary font-medium'
                      : 'text-app-text-tertiary hover:text-app-text-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {transport === 'stdio' ? (
              <>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="命令（npx / node / python…）*"
                  className={`${inputCls} font-mono`}
                />
                <div>
                  <p className="text-app-text-tertiary text-[10px] mb-1">参数（每行一个，选填）</p>
                  <textarea
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder={'-y\n@upstash/context7-mcp'}
                    rows={3}
                    className={`${inputCls} font-mono resize-y`}
                  />
                </div>
                <div>
                  <p className="text-app-text-tertiary text-[10px] mb-1">
                    环境变量（每行 key=value，选填）
                  </p>
                  <textarea
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    placeholder={'API_KEY=sk-…'}
                    rows={2}
                    className={`${inputCls} font-mono resize-y`}
                  />
                </div>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述（能力说明，选填）"
                  className={inputCls}
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="server 地址（https://…/mcp）*"
                  className={`${inputCls} font-mono`}
                />
                <div>
                  <p className="text-app-text-tertiary text-[10px] mb-1">
                    请求头（每行 key: value，选填）
                  </p>
                  <textarea
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    placeholder={'Authorization: Bearer sk-…'}
                    rows={2}
                    className={`${inputCls} font-mono resize-y`}
                  />
                </div>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述（能力说明，选填）"
                  className={inputCls}
                />
              </>
            )}

            <p className="text-app-text-disabled text-xs leading-relaxed">
              添加时会实际连接验证并抓取工具清单；stdio 会在本机启动并运行该命令（长驻进程），
              请只添加可信来源的 server。标识名会成为工具名前缀（
              {name.trim() || 'fetch'}__工具名），添加后不可改。
            </p>
          </div>
        ) : (
          <div className="mt-3 flex-1 overflow-y-auto min-h-0">
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              spellCheck={false}
              className={`${inputCls} font-mono resize-y`}
            />
            <p className="text-app-text-disabled text-xs mt-2 leading-relaxed">
              粘贴 Claude Desktop 格式的 mcpServers 条目（单条）。有 url 按 HTTP 导入，
              有 command 按 stdio 导入，headers/env 一并收编。
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={mode === 'manual' ? !manualReady : !jsonText.trim() || submitting}
            onClick={() => void handleSubmit()}
            className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '验证中…' : '验证并添加'}
          </button>
        </div>
      </div>
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
