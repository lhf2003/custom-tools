import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, CircleDot, Loader2, Play, Rocket, Sparkles, X } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import {
  generatePlugin,
  GEN_STEP_LABELS,
  type GenStepName,
  type GeneratedPluginFiles,
} from '@/plugins/pluginGenerator';
import type { FlowhubPluginModule } from '@/plugins/external';

/**
 * AI 生成插件弹窗（二期设计第 8 节落地）：
 * 描述 → 流式生成（4 步回显，避免长等待焦虑）→ 校验（失败自动重试 1 次）
 * → 预览（文件清单 + 代码）→ 试运行（.preview/ 落盘走真实加载链路）→ 安装（触发扫描）。
 */

const STEP_ORDER: GenStepName[] = ['manifest', 'view', 'style', 'verify'];

/** 试运行容器：preview 目录落盘 → 真实 bundle 加载链路 mount 进预览区 */
function PreviewRunner({ pluginId, manifest, bundle }: { pluginId: string; manifest: string; bundle: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await invoke('write_plugin_preview', { pluginId, manifest, bundle });
      if (cancelled) return;
      const code = await invoke<string>('read_plugin_bundle', { pluginId, preview: true });
      if (cancelled || !containerRef.current) return;
      window.flowhubPlugin = undefined;
      // eslint-disable-next-line no-new-func
      new Function(code)();
      const mod = window.flowhubPlugin as FlowhubPluginModule | undefined;
      if (mod?.view && typeof mod.view.mount === 'function') {
        // 试运行无载荷：getPayload 固定返回 undefined
        mod.view.mount(containerRef.current, { invoke, getPayload: () => undefined });
      }
    })().catch((err: unknown) => {
      console.error('[plugins] 试运行失败:', err);
    });
    return () => {
      cancelled = true;
      window.flowhubPlugin = undefined;
    };
  }, [pluginId, manifest, bundle]);

  return (
    <div className="h-64 rounded-lg border border-app-border bg-app-bg-primary overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

export function GeneratePluginModal({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { addToast } = useToastStore();
  const [phase, setPhase] = useState<'input' | 'generating' | 'result' | 'error'>('input');
  const [description, setDescription] = useState('');
  const [currentStep, setCurrentStep] = useState<GenStepName | null>(null);
  const [stepsDone, setStepsDone] = useState<GenStepName[]>([]);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedPluginFiles | null>(null);
  const [previewFile, setPreviewFile] = useState<'plugin.json' | 'plugin.js'>('plugin.json');
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manifest = result ? (JSON.parse(result.manifestJson) as Record<string, unknown>) : null;
  const manifestId = manifest ? String(manifest.id ?? '') : '';

  // 关闭时清理试运行残留（.preview/ 下的文件；失败静默——下次写入会覆盖）
  const cleanupPreview = useCallback(() => {
    if (!manifestId || !result) return;
    invoke('clear_plugin_preview', { pluginId: manifestId }).catch(() => {
      /* 静默 */
    });
  }, [manifestId, result]);

  const handleClose = useCallback(() => {
    cleanupPreview();
    onClose();
  }, [cleanupPreview, onClose]);

  const handleGenerate = useCallback(async () => {
    if (!description.trim()) return;
    setPhase('generating');
    setCurrentStep(null);
    setStepsDone([]);
    setRetryMsg(null);
    setError(null);
    try {
      const files = await generatePlugin(
        description.trim(),
        (step) => {
          setCurrentStep(step);
          setStepsDone((prev) => (prev.includes(step) ? prev : [...prev, step]));
        },
        (reason) => {
          setRetryMsg(reason);
          setStepsDone([]);
          setCurrentStep(null);
        }
      );
      setResult(files);
      setPhase('result');
      setPreviewFile('plugin.json');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [description]);

  const handleInstall = useCallback(async () => {
    if (!result || !manifestId) return;
    try {
      await invoke('install_preview_plugin', { pluginId: manifestId });
      cleanupPreview();
      addToast({ type: 'success', title: `已安装「${String(manifest?.name ?? manifestId)}」，请在插件市场启用` });
      onInstalled();
      onClose();
    } catch (err) {
      addToast({ type: 'error', title: '安装失败', message: String(err) });
    }
  }, [result, manifestId, manifest, cleanupPreview, onInstalled, onClose, addToast]);

  const summaryLine =
    manifest && Array.isArray(manifest.triggers)
      ? `触发器 ${(manifest.triggers as { keyword: string }[]).map((t) => t.keyword).join('、') || '无'} · 设置 ${(Array.isArray(manifest.settings) ? manifest.settings : []).length} 项 · 快捷键 ${(Array.isArray(manifest.shortcuts) ? manifest.shortcuts : []).length} 项`
      : '';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'generating') handleClose();
      }}
    >
      <div className="w-[600px] max-h-[85vh] flex flex-col bg-app-bg-tertiary border border-app-border rounded-xl shadow-2xl animate-in fade-in duration-100">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-app-status-info" />
            <h3 className="text-sm font-semibold text-app-text-primary">AI 生成插件</h3>
          </div>
          {phase !== 'generating' && (
            <button
              onClick={handleClose}
              aria-label="关闭"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {phase === 'input' && (
            <>
              <p className="text-xs text-app-text-tertiary leading-relaxed">
                用一句话描述你想要的插件，AI 会按插件协议生成框架、视图与设置项，并遵循本系统设计规范。
              </p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：一个 base64 编码/解码工具，支持编码与解码切换、复制结果"
                rows={4}
                autoFocus
                className="w-full px-3 py-2.5 rounded-lg text-sm bg-app-bg-tertiary border border-app-border text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-app-status-info focus:ring-2 focus:ring-app-status-info/20 transition-all duration-200 resize-none"
              />
            </>
          )}

          {phase === 'generating' && (
            <>
              {retryMsg && (
                <p className="text-xs text-app-status-warning bg-app-status-warning/10 border border-app-status-warning/30 rounded-lg px-3 py-2">
                  {retryMsg}
                </p>
              )}
              <div className="space-y-1.5">
                {STEP_ORDER.map((name) => {
                  const done = stepsDone.includes(name);
                  const active = currentStep === name;
                  return (
                    <div
                      key={name}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                        done
                          ? 'text-app-text-secondary'
                          : active
                            ? 'bg-app-bg-elevated/40 text-app-text-primary'
                            : 'text-app-text-disabled'
                      }`}
                    >
                      {done ? (
                        <Check size={14} className="text-app-status-success flex-shrink-0" />
                      ) : active ? (
                        <Loader2 size={14} className="text-app-status-info animate-spin flex-shrink-0" />
                      ) : (
                        <CircleDot size={14} className="flex-shrink-0" />
                      )}
                      <span>{GEN_STEP_LABELS[name]}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-app-text-disabled">生成中请稍候，长描述可能需要一两分钟…</p>
            </>
          )}

          {phase === 'error' && (
            <div>
              <p className="text-sm text-app-status-error mb-3">生成失败：{error}</p>
              <button
                onClick={() => setPhase('input')}
                className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
              >
                返回重试
              </button>
            </div>
          )}

          {phase === 'result' && result && manifest && (
            <>
              {/* 摘要：文件清单 + manifest 概要 */}
              <div className="flex items-center gap-2 flex-wrap">
                {['plugin.json', 'plugin.js'].map((f) => (
                  <button
                    key={f}
                    onClick={() => setPreviewFile(f as 'plugin.json' | 'plugin.js')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                      previewFile === f
                        ? 'bg-app-status-info/15 text-app-status-info'
                        : 'text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-elevated/50'
                    }`}
                  >
                    {f}
                  </button>
                ))}
                <span className="text-xs text-app-text-tertiary ml-auto">
                  {String(manifest.name ?? '')} v{String(manifest.version ?? '')}
                </span>
              </div>
              {summaryLine && <p className="text-xs text-app-text-tertiary">{summaryLine}</p>}

              {/* 代码预览 */}
              <div className="rounded-lg border border-app-border bg-app-bg-primary overflow-hidden">
                <pre className="max-h-52 overflow-auto p-3 text-xs font-mono leading-relaxed text-app-text-secondary whitespace-pre">
                  {previewFile === 'plugin.json'
                    ? JSON.stringify(manifest, null, 2)
                    : result.bundleCode}
                </pre>
              </div>

              {/* 试运行 */}
              {previewing ? (
                <PreviewRunner pluginId={manifestId} manifest={result.manifestJson} bundle={result.bundleCode} />
              ) : (
                <button
                  onClick={() => setPreviewing(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-app-text-secondary border border-app-border hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
                >
                  <Play size={13} />
                  试运行
                </button>
              )}
            </>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-white/5">
          {phase === 'input' && (
            <>
              <button
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleGenerate}
                disabled={!description.trim()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-app-status-info hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <Sparkles size={14} />
                开始生成
              </button>
            </>
          )}
          {phase === 'generating' && (
            <span className="text-xs text-app-text-disabled">生成完成后自动进入预览…</span>
          )}
          {phase === 'result' && (
            <>
              <button
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
              >
                关闭
              </button>
              <button
                onClick={handleInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer"
              >
                <Rocket size={14} />
                安装插件
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
