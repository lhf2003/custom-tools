import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Check, Languages, X, ChevronDown, ChevronUp } from 'lucide-react';

/** translate:chunk / done / error 事件的统一壳（与 Rust 端 TranslateEventPayload 对应） */
interface TranslateEventPayload {
  id: number;
  text?: string;
  message?: string;
}

interface TranslateStartPayload {
  id: number;
  source: string;
  target_lang: string;
}

type ToastStatus = 'idle' | 'translating' | 'done' | 'error';

/** 窗口从未获得焦点（后台触发被焦点锁拦截）时的兜底：60s 无事件自动隐藏 */
const STALE_HIDE_MS = 60_000;

export default function TranslateToast() {
  const [status, setStatus] = useState<ToastStatus>('idle');
  const [source, setSource] = useState('');
  const [targetLang, setTargetLang] = useState('');
  const [translation, setTranslation] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const latestIdRef = useRef(0);
  const staleTimerRef = useRef<number | null>(null);

  const hideWindow = useCallback(() => {
    getCurrentWindow()
      .hide()
      .catch((err: unknown) => console.error('Failed to hide translate toast:', err));
  }, []);

  // 事件全空闲兜底：60s 无任何 translate 事件自动隐藏（防滞留）
  const resetStaleTimer = useCallback(() => {
    if (staleTimerRef.current !== null) {
      window.clearTimeout(staleTimerRef.current);
    }
    staleTimerRef.current = window.setTimeout(hideWindow, STALE_HIDE_MS);
  }, [hideWindow]);

  // 事件通道：只接受最新 id（start 视为最高优先级新请求；chunk/done/error 按 id 过滤）
  useEffect(() => {
    let disposed = false;
    const unlistens: Promise<() => void>[] = [];

    unlistens.push(
      listen<TranslateStartPayload>('translate:start', (event) => {
        const p = event.payload;
        latestIdRef.current = Math.max(latestIdRef.current, p.id);
        setSource(p.source);
        setTargetLang(p.target_lang);
        setTranslation('');
        setErrorMsg('');
        setSourceExpanded(false);
        setCopied(false);
        setStatus('translating');
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:chunk', (event) => {
        if (event.payload.id !== latestIdRef.current) return;
        setTranslation((prev) => prev + (event.payload.text ?? ''));
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:done', (event) => {
        if (event.payload.id !== latestIdRef.current) return;
        setStatus('done');
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:error', (event) => {
        const p = event.payload;
        // 无 start 直接到 error = 空选区等提示类错误：短显后自动隐藏
        if (p.id > latestIdRef.current || status === 'idle') {
          setErrorMsg(p.message ?? '翻译失败');
          setStatus('error');
          latestIdRef.current = p.id;
          window.setTimeout(hideWindow, 2000);
          return;
        }
        if (p.id !== latestIdRef.current) return;
        setErrorMsg(p.message ?? '翻译失败');
        setStatus('error');
        resetStaleTimer();
      }),
    );

    return () => {
      disposed = true;
      unlistens.forEach((u) =>
        u.then((fn) => {
          if (!disposed) fn();
        }).catch((err: unknown) => {
          console.error('Failed to cleanup translate listener:', err);
        }),
      );
    };
  }, [status, hideWindow, resetStaleTimer]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideWindow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hideWindow]);

  // 组件卸载时清理兜底定时器
  useEffect(() => {
    return () => {
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy translation:', err);
    }
  }, [translation]);

  const isIdle = status === 'idle';

  return (
    <div className="w-full h-full flex items-stretch justify-stretch bg-transparent">
      <div className="relative flex-1 m-1 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-md shadow-2xl overflow-hidden flex flex-col">
        {/* 标题栏（可拖动） */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 cursor-default"
        >
          <div className="w-6 h-6 rounded-lg bg-app-brand-primary/15 flex items-center justify-center shrink-0">
            <Languages size={14} className="text-app-brand-primary-light" />
          </div>
          <div data-tauri-drag-region className="flex-1 text-white text-sm font-medium truncate">
            划词翻译
          </div>
          {targetLang && status !== 'idle' && (
            <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-white/50 bg-white/10">
              译成{targetLang}
            </span>
          )}
          <button
            onClick={hideWindow}
            className="text-white/40 hover:text-white/80 transition-colors cursor-pointer shrink-0"
            title="关闭（Esc）"
          >
            <X size={14} />
          </button>
        </div>

        {isIdle ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center">
            <p className="text-xs text-white/40">选中文本后按 Ctrl+Shift+T</p>
            <p className="text-[10px] text-white/25">或打开「划词翻译」视图粘贴长文本</p>
          </div>
        ) : (
          <>
            {/* 原文（超长截断，可点击展开） */}
            {source && (
              <div className="flex-shrink-0 px-3 pb-1.5">
                <p
                  className={`text-xs leading-relaxed text-white/45 whitespace-pre-wrap break-words cursor-pointer ${
                    sourceExpanded ? '' : 'line-clamp-3'
                  }`}
                  onClick={() => setSourceExpanded((v) => !v)}
                  title={sourceExpanded ? '收起原文' : '展开原文'}
                >
                  {source}
                </p>
                <button
                  onClick={() => setSourceExpanded((v) => !v)}
                  className="mt-0.5 flex items-center gap-0.5 text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                >
                  {sourceExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {sourceExpanded ? '收起' : '展开原文'}
                </button>
              </div>
            )}

            {/* 译文 / 错误 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-1">
              {status === 'error' ? (
                <p className="text-xs text-red-400 leading-relaxed">{errorMsg}</p>
              ) : (
                <p className="text-sm leading-relaxed text-white/90 whitespace-pre-wrap break-words">
                  {translation}
                  {status === 'translating' && (
                    <span className="inline-block w-0.5 h-4 ml-0.5 align-middle bg-app-status-info animate-pulse" />
                  )}
                </p>
              )}
            </div>

            {/* 操作行 */}
            <div className="flex-shrink-0 flex items-center justify-end gap-2 px-3 pb-2.5 pt-1">
                <span className="mr-auto text-[10px] text-white/30 select-none">
                  {status === 'translating' ? '翻译中…' : 'Esc 关闭'}
                </span>
                {status === 'done' && (
                  <button
                    onClick={handleCopy}
                    disabled={!translation}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    {copied ? '已复制' : '复制译文'}
                  </button>
                )}
              </div>
          </>
        )}
      </div>
    </div>
  );
}
