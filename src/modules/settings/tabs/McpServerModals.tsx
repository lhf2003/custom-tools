import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { confirmDialog } from '@/stores/confirmStore';

/** 第三方 server 的前端视图（凭据值不下发，只带 key 名——与后端 to_info 对齐） */
export interface ExternalServerInfo {
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
  /** 已配置 http headers 凭据的 key 名（值不回显） */
  header_entries: string[];
  /** 已配置 stdio env 凭据的 key 名（值不回显） */
  env_entries: string[];
  has_secret: boolean;
  tools: { name: string; description: string }[];
}

/** 后端连接验证失败的稳定错误前缀（与 mcp_servers.rs VALIDATION_ERROR_PREFIX 对齐），
 * 前端据以弹「仍然保存」降级确认——不靠文案子串匹配（CASE-001 M7） */
const VALIDATION_ERROR_PREFIX = 'MCP_VALIDATION:';
const isValidationError = (msg: string): boolean => msg.startsWith(VALIDATION_ERROR_PREFIX);
const stripValidationPrefix = (msg: string): string =>
  msg.startsWith(VALIDATION_ERROR_PREFIX) ? msg.slice(VALIDATION_ERROR_PREFIX.length) : msg;

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
  'w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * 弹窗基础交互：打开聚焦首控件、ESC 关闭、Tab 焦点圈定（不落到遮罩后页面）、
 * 关闭后焦点还原到触发元素。挂载生命周期只绑定一次——onClose 经 ref 取最新值，
 * 父组件内联箭头函数重渲染不再触发 effect 重跑（CASE-001 L4/M8）
 */
function useModalDialog(
  contentRef: { current: HTMLDivElement | null },
  onClose: () => void
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = contentRef.current?.querySelector<HTMLElement>(
      'input, textarea, button:not(:disabled)'
    );
    focusable?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = contentRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'input, textarea, button, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [contentRef]);
}

interface CallLogRow {
  tool_name: string;
  status: string;
  duration_ms: number;
  result_len: number;
  created_at: number;
}

/** 调用日志弹窗：per-server 最近 50 条（新在前）。加载失败显式报错，不伪装空状态 */
export function CallLogModal({
  serverName,
  slug,
  onClose,
}: {
  serverName: string;
  slug: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CallLogRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useModalDialog(contentRef, onClose);

  const loadLogs = useCallback(async () => {
    setRows(null);
    setLoadError(null);
    try {
      setRows(await invoke<CallLogRow[]>('list_mcp_tool_calls', { serverName: slug }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [slug]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

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
      aria-labelledby="mcp-calllog-title"
    >
      <div
        ref={contentRef}
        className="bg-app-bg-elevated rounded-xl p-5 w-[440px] max-h-[70vh] flex flex-col border border-white/10 shadow-2xl"
      >
        <h3
          id="mcp-calllog-title"
          className="text-app-text-primary text-sm font-semibold flex-shrink-0"
        >
          调用日志 · {serverName}
        </h3>
        <div className="mt-3 flex-1 overflow-y-auto min-h-0">
          {loadError ? (
            <div className="py-4 text-center">
              <p className="text-app-status-error text-xs leading-relaxed">
                日志加载失败：{loadError}
              </p>
              <button
                type="button"
                onClick={() => void loadLogs()}
                className="mt-2 px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer"
              >
                重试
              </button>
            </div>
          ) : rows === null ? (
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

/** 配置编辑二级页面：表单预填（凭据只列 key、值留空=保持不变）+ 工具描述只读区 */
export function EditServerView({
  server,
  onBack,
  onSaved,
}: {
  server: ExternalServerInfo;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToastStore();
  const [description, setDescription] = useState(server.description);
  const [transport, setTransport] = useState<'stdio' | 'http'>(
    server.transport === 'stdio' ? 'stdio' : 'http'
  );
  const [command, setCommand] = useState(server.command);
  const [argsText, setArgsText] = useState(server.args.join('\n'));
  // 凭据只列出 key、值为空：留空=保持原值，删行=清除该凭据。
  // 按归属分别预填（http→header_entries，stdio→env_entries），删行清除的是本侧凭据
  const [envText, setEnvText] = useState(server.env_entries.map((k) => `${k}: `).join('\n'));
  const [url, setUrl] = useState(server.url);
  const [headersText, setHeadersText] = useState(
    server.header_entries.map((k) => `${k}: `).join('\n')
  );
  const [submitting, setSubmitting] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [refreshingTools, setRefreshingTools] = useState(false);
  // 页面内数据镜像：刷新工具清单就地更新，不动父列表
  const [current, setCurrent] = useState(server);

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
      if (!force && isValidationError(msg)) {
        const ok = await confirmDialog({
          title: '连接验证失败',
          message: stripValidationPrefix(msg),
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
  const secretCount = server.header_entries.length + server.env_entries.length;

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
        >
          <ChevronLeft size={14} />
          返回
        </button>
        <h3 className="text-app-text-primary text-sm font-semibold">
          配置 · {server.name}
        </h3>
      </div>

      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void handleSave();
        }}
      >
        <div className="space-y-2">
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
                  disabled={submitting}
                  onClick={() => setTransport(t)}
                  className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
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
                  disabled={submitting}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="命令（npx / node / python…）*"
                  className={`${inputCls} font-mono`}
                />
                <div>
                  <p className="text-app-text-tertiary text-[10px] mb-1">参数（每行一个，选填）</p>
                  <textarea
                    value={argsText}
                    disabled={submitting}
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
                    disabled={submitting}
                    onChange={(e) => setEnvText(e.target.value)}
                    placeholder={'API_KEY=sk-…'}
                    rows={2}
                    className={`${inputCls} font-mono resize-y`}
                  />
                </div>
                <input
                  type="text"
                  value={description}
                  disabled={submitting}
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
                  disabled={submitting}
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
                    disabled={submitting}
                    onChange={(e) => setHeadersText(e.target.value)}
                    placeholder={'Authorization: Bearer sk-…'}
                    rows={2}
                    className={`${inputCls} font-mono resize-y`}
                  />
                </div>
                <input
                  type="text"
                  value={description}
                  disabled={submitting}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述（能力说明，选填）"
                  className={inputCls}
                />
              </>
            )}

            {secretCount > 0 && (
              <p className="text-app-text-disabled text-xs leading-relaxed">
                已配置的凭据键以「key: 」形式列出（HTTP 的请求头与 stdio 的环境变量
                分别预填）：留空保存 = 保持原值；删除整行 = 清除该凭据；
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
                  disabled={refreshingTools || submitting}
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
                        {/* 描述占满剩余宽度：折叠态单行 ellipsis 截断（临界点即右侧按钮），
                            展开态全文换行；按钮始终 flex-shrink-0 固定行右 */}
                        <p
                          className={`min-w-0 flex-1 text-app-text-tertiary text-xs leading-relaxed break-words ${
                            expanded ? '' : 'truncate'
                          }`}
                        >
                          {desc}
                        </p>
                        {long && (
                          <button
                            type="button"
                            onClick={toggle}
                            className="flex-shrink-0 mt-px text-app-brand-primary-light text-[10px] hover:underline cursor-pointer"
                          >
                            {expanded ? '收起' : '展开'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            disabled={submitting}
            onClick={onBack}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!ready}
            className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '验证中…' : '保存并验证'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 添加 server 弹窗：手动配置（类型切换双表单）与 JSON 导入双方式 */
export function AddServerModal({
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
  useModalDialog(contentRef, onClose);

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
      if (!force && isValidationError(msg)) {
        const ok = await confirmDialog({
          title: '连接验证失败',
          message: stripValidationPrefix(msg),
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
      aria-labelledby="mcp-add-title"
    >
      <div
        ref={contentRef}
        className="bg-app-bg-elevated rounded-xl p-5 w-[420px] max-h-[75vh] flex flex-col border border-white/10 shadow-2xl"
      >
        <form
          className="flex flex-col min-h-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const ready = mode === 'manual' ? manualReady : !!jsonText.trim() && !submitting;
            if (ready) void handleSubmit();
          }}
        >
          <h3 id="mcp-add-title" className="text-app-text-primary text-sm font-semibold flex-shrink-0">
            添加 MCP server
          </h3>

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
                disabled={submitting}
                onClick={() => setMode(m)}
                className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
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
                  disabled={submitting}
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
                    disabled={submitting}
                    onClick={() => setTransport(t)}
                    className={`flex-1 py-1 rounded-md text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
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
                    disabled={submitting}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="命令（npx / node / python…）*"
                    className={`${inputCls} font-mono`}
                  />
                  <div>
                    <p className="text-app-text-tertiary text-[10px] mb-1">参数（每行一个，选填）</p>
                    <textarea
                      value={argsText}
                      disabled={submitting}
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
                      disabled={submitting}
                      onChange={(e) => setEnvText(e.target.value)}
                      placeholder={'API_KEY=sk-…'}
                      rows={2}
                      className={`${inputCls} font-mono resize-y`}
                    />
                  </div>
                  <input
                    type="text"
                    value={description}
                    disabled={submitting}
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
                    disabled={submitting}
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
                      disabled={submitting}
                      onChange={(e) => setHeadersText(e.target.value)}
                      placeholder={'Authorization: Bearer sk-…'}
                      rows={2}
                      className={`${inputCls} font-mono resize-y`}
                    />
                  </div>
                  <input
                    type="text"
                    value={description}
                    disabled={submitting}
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
                disabled={submitting}
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
              disabled={submitting}
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={mode === 'manual' ? !manualReady : !jsonText.trim() || submitting}
              className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? '验证中…' : '验证并添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** slug 预览校验（权威校验在后端）：ASCII 字母数字_-，不含连续双下划线 */
function slugError(name: string): string | null {
  if (!name) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '仅限字母、数字、下划线、连字符';
  if (name.includes('__')) return '不能包含连续双下划线（它是工具前缀分隔符）';
  return null;
}
