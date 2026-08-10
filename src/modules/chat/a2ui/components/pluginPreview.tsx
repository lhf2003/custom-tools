// PluginPreview：插件制作卡片（聊天页 AI 生成插件的产物展示与操作）。
// payload 从 A2UI 数据模型读：{ pluginId, manifestJson, bundleCode, mode, reviewStatus }。
// 运行按钮手动触发 bundle 执行（渲染不执行）；卸载时清理定时器与残留 DOM。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, Loader2, Play, Rocket } from 'lucide-react';
import { useA2ui } from '../render';
import { useToastStore } from '@/stores/toastStore';

interface PluginPreviewPayload {
  pluginId?: unknown;
  manifestJson?: unknown;
  bundleCode?: unknown;
  mode?: unknown;
  reviewStatus?: unknown;
}

export function PluginPreview() {
  const { data, dispatchInvoke } = useA2ui();
  const { addToast } = useToastStore();
  const payload = (data ?? {}) as PluginPreviewPayload;
  const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : '';
  const manifestJson = typeof payload.manifestJson === 'string' ? payload.manifestJson : '';
  const bundleCode = typeof payload.bundleCode === 'string' ? payload.bundleCode : '';
  const mode = payload.mode === 'update' ? 'update' : 'create';
  const reviewStatus =
    payload.reviewStatus === 'review_not_fully_passed' ? 'review_not_fully_passed' : 'passed';

  const [tab, setTab] = useState<'json' | 'js'>('json');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const mountRef = useRef<HTMLDivElement>(null);
  // 卸载清理：bundle 的 view.unmount 多数不实现，定时器/残留 DOM 由本组件兜底清
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  // manifest 摘要（后端已校验 JSON 合法性，这里宽松解析）
  let manifest: Record<string, unknown> | null = null;
  try {
    manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch {
    /* 解析失败由后端校验兜底 */
  }
  const name = typeof manifest?.name === 'string' ? manifest.name : pluginId || '未命名插件';
  const version = typeof manifest?.version === 'string' ? manifest.version : '';

  /** 手动触发 bundle 执行：new Function + 挂载进卡片容器（与外部插件视图同链路） */
  const handleRun = useCallback(() => {
    setRunError(null);
    if (!bundleCode) {
      setRunError('缺少 bundle 代码');
      return;
    }
    const mountEl = mountRef.current;
    if (!mountEl) return;

    setRunning(true);
    cleanupRef.current?.();
    window.flowhubPlugin = undefined;
    mountEl.innerHTML = '';

    // monkey-patch 定时器：收集句柄，卸载/失败时统一清理（bundle 可能不保存句柄）
    const timers: number[] = [];
    const origSetInterval = window.setInterval.bind(window);
    const origSetTimeout = window.setTimeout.bind(window);
    const origClearInterval = window.clearInterval.bind(window);
    const origClearTimeout = window.clearTimeout.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = origSetInterval(handler, timeout, ...args);
      timers.push(id);
      return id;
    }) as typeof window.setInterval;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = origSetTimeout(handler, timeout, ...args);
      timers.push(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearInterval = ((id: number) => {
      origClearInterval(id);
    }) as typeof window.clearInterval;
    window.clearTimeout = ((id: number) => {
      origClearTimeout(id);
    }) as typeof window.clearTimeout;

    const cleanup = () => {
      for (const t of timers) {
        origClearInterval(t);
        origClearTimeout(t);
      }
      window.setInterval = origSetInterval;
      window.setTimeout = origSetTimeout;
      window.clearInterval = origClearInterval;
      window.clearTimeout = origClearTimeout;
      window.flowhubPlugin = undefined;
      mountEl.innerHTML = '';
    };
    cleanupRef.current = cleanup;

    try {
      // eslint-disable-next-line no-new-func
      new Function(bundleCode)();
      const mod = window.flowhubPlugin as
        | { view?: { mount?: (el: HTMLElement, ctx: unknown) => void } }
        | undefined;
      if (!mod?.view || typeof mod.view.mount !== 'function') {
        throw new Error('bundle 未注册有效视图（缺少 window.flowhubPlugin.view.mount）');
      }
      mod.view.mount(mountEl, { invoke, getPayload: () => undefined });
    } catch (err) {
      cleanupRef.current?.();
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [bundleCode]);

  /** 安装/更新：invoke 型直调（绕过 LLM 语义代理），命令名由后端白名单校验 */
  const handleInstall = useCallback(() => {
    if (!pluginId) return;
    setInstalling(true);
    dispatchInvoke(
      mode === 'update' ? 'update_plugin_from_preview' : 'install_preview_plugin',
      { pluginId },
    )
      .then(() => {
        setInstalled(true);
        addToast({
          type: 'success',
          title: mode === 'update' ? `已更新「${name}」v${version}` : `已安装「${name}」，请在插件市场启用`,
        });
      })
      .catch(() => {
        /* dispatchInvoke 内部已 toast 错误 */
      })
      .finally(() => setInstalling(false));
  }, [dispatchInvoke, mode, pluginId, name, version, addToast]);

  return (
    <div className="rounded-xl border border-app-border bg-app-bg-primary overflow-hidden">
      {/* 元信息 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border-subtle">
        <span className="text-sm font-medium text-app-text-primary truncate">
          {name}
          {version ? ` v${version}` : ''}
        </span>
        <span className="text-xs text-app-text-tertiary shrink-0">AI 生成 · 试运行</span>
        {reviewStatus === 'passed' ? (
          <span className="ml-auto shrink-0 flex items-center gap-1 text-xs text-app-status-success">
            <Check size={12} /> 已通过自审
          </span>
        ) : (
          <span className="ml-auto shrink-0 flex items-center gap-1 text-xs text-app-status-warning">
            <AlertTriangle size={12} /> 审查未完全通过
          </span>
        )}
      </div>

      {/* 代码预览 tab */}
      <div className="flex items-center gap-1 px-3 pt-2">
        {(['json', 'js'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2 py-0.5 rounded-md text-xs transition-colors cursor-pointer ${
              tab === t
                ? 'bg-app-bg-elevated text-app-text-primary'
                : 'text-app-text-tertiary hover:text-app-text-primary'
            }`}
          >
            {t === 'json' ? 'plugin.json' : 'plugin.js'}
          </button>
        ))}
      </div>
      <pre className="max-h-40 overflow-auto m-3 mt-2 p-2.5 rounded-lg bg-app-bg-tertiary text-xs font-mono leading-relaxed text-app-text-secondary whitespace-pre">
        {tab === 'json'
          ? (manifestJson || '// 无 manifest 数据')
          : (bundleCode || '// 无 bundle 数据')}
      </pre>

      {/* bundle 运行挂载区 */}
      <div ref={mountRef} className="mx-3 mb-2" />
      {runError && (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-lg text-xs text-app-status-error bg-app-status-error/10 border border-app-status-error/30">
          运行异常：{runError}
        </div>
      )}

      {/* 操作区 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-app-border-subtle">
        <button
          onClick={handleRun}
          disabled={running || !bundleCode}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-app-text-secondary border border-app-border hover:bg-app-bg-elevated/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {running ? '运行中…' : '运行'}
        </button>
        <button
          onClick={handleInstall}
          disabled={installing || installed || !pluginId}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white bg-app-status-info hover:bg-app-status-info-deep transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {installing ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
          {installing ? '处理中…' : installed ? '已安装' : mode === 'update' ? '更新插件' : '安装插件'}
        </button>
      </div>
    </div>
  );
}
