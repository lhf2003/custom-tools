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
  // 事件监听闭包经 ref 读最新状态：effect 不随 status 重订阅（重订阅会累积监听器）
  const statusRef = useRef<ToastStatus>('idle');
  const updateStatus = useCallback((s: ToastStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);
  const [source, setSource] = useState('');
  const [targetLang, setTargetLang] = useState('');
  const [translation, setTranslation] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [sourceClamped, setSourceClamped] = useState(false);
  const sourceTextRef = useRef<HTMLParagraphElement>(null);
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

  // 事件通道：只接受最新 id（start 视为最高优先级新请求；chunk/done/error 按 id 过滤）。
  // 只挂一次：状态经 statusRef 读取，deps 均为稳定引用——随 status 重订阅会累积
  // 监听器（旧闭包不注销，chunk 被多份 append），cleanup 也必须无条件退订
  useEffect(() => {
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
        updateStatus('translating');
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:chunk', (event) => {
        if (event.payload.id !== latestIdRef.current) return;
        setTranslation((prev) => prev + (event.payload.text ?? ''));
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:done', (event) => {
        if (event.payload.id !== latestIdRef.current) return;
        updateStatus('done');
        resetStaleTimer();
      }),
      listen<TranslateEventPayload>('translate:error', (event) => {
        const p = event.payload;
        // 无 start 直接到 error = 空选区等提示类错误（后端为其分配新 id，必大于已知最新）：短显后自动隐藏
        if (p.id > latestIdRef.current || statusRef.current === 'idle') {
          setErrorMsg(p.message ?? '翻译失败');
          updateStatus('error');
          latestIdRef.current = p.id;
          window.setTimeout(hideWindow, 2000);
          return;
        }
        if (p.id !== latestIdRef.current) return;
        setErrorMsg(p.message ?? '翻译失败');
        updateStatus('error');
        resetStaleTimer();
      }),
    );

    return () => {
      // 无条件注销：promise 晚于 cleanup 才 resolve 时同样要退订（CompanionToast 同款）
      unlistens.forEach((u) =>
        u.then((fn) => fn()).catch((err: unknown) => {
          console.error('Failed to cleanup translate listener:', err);
        }),
      );
    };
  }, [hideWindow, resetStaleTimer, updateStatus]);

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

  // 展开入口只在原文真被 3 行截断时出现（短文本点展开无视觉变化，像坏了）。
  // start 事件里 setSource/setSourceExpanded(false) 同批提交，此处量到的必是截断态
  useEffect(() => {
    const el = sourceTextRef.current;
    if (!el) return;
    setSourceClamped(el.scrollHeight > el.clientHeight + 1);
  }, [source]);

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

  // 结构对齐主窗口契约：body 承担主题背景（橘子海海面渐变），根容器即唯一
  // 内容层（panel-glass 玻璃面板，透明度跟随全局滑杆）——不再套第二层卡片
  return (
    <div className="w-full h-full panel-glass-toast rounded-xl border border-app-border-subtle shadow-2xl overflow-hidden flex flex-col">
      {/* 标题栏（可拖动） */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 cursor-default"
      >
        <div className="w-6 h-6 rounded-lg bg-app-bg-elevated flex items-center justify-center shrink-0">
          <Languages size={14} className="text-app-brand-primary-light" />
        </div>
        <div data-tauri-drag-region className="flex-1 text-app-text-primary text-sm font-medium truncate">
          划词翻译
        </div>
        {targetLang && status !== 'idle' && (
          <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-app-text-tertiary bg-app-bg-elevated">
            译成{targetLang}
          </span>
        )}
        <button
          onClick={hideWindow}
          className="text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer shrink-0"
          title="关闭（Esc）"
        >
          <X size={14} />
        </button>
      </div>

      {isIdle ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center">
          <p className="text-xs text-app-text-tertiary">选中文本后按 Ctrl+Shift+T</p>
          <p className="text-[10px] text-app-text-placeholder">或打开「划词翻译」视图粘贴长文本</p>
        </div>
      ) : (
        <>
          {/* 原文（超 3 行截断，可出现展开按钮） */}
          {source && (
            <div className="flex-shrink-0 px-3 pb-1.5">
              <p
                ref={sourceTextRef}
                className={`text-xs leading-relaxed text-app-text-tertiary whitespace-pre-wrap break-words ${
                  sourceExpanded ? '' : 'line-clamp-3'
                }`}
              >
                {source}
              </p>
              {(sourceClamped || sourceExpanded) && (
                <button
                  onClick={() => setSourceExpanded((v) => !v)}
                  className="mt-0.5 flex items-center gap-0.5 text-[10px] text-app-text-placeholder hover:text-app-text-secondary transition-colors cursor-pointer"
                >
                  {sourceExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  {sourceExpanded ? '收起' : '展开原文'}
                </button>
              )}
            </div>
          )}

          {/* 译文 / 错误 */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-1">
            {status === 'error' ? (
              <p className="text-xs text-app-status-error leading-relaxed">{errorMsg}</p>
            ) : (
              <p className="text-sm leading-relaxed text-app-text-primary whitespace-pre-wrap break-words">
                {translation}
                {status === 'translating' && (
                  <span className="inline-block w-0.5 h-4 ml-0.5 align-middle bg-app-status-info animate-pulse" />
                )}
              </p>
            )}
          </div>

          {/* 操作行 */}
          <div className="flex-shrink-0 flex items-center justify-end gap-2 px-3 pb-2.5 pt-1">
              <span className="mr-auto text-[10px] text-app-text-placeholder select-none">
                {status === 'translating' ? '翻译中…' : 'Esc 关闭'}
              </span>
              {status === 'done' && (
                <button
                  onClick={handleCopy}
                  disabled={!translation}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-pressed transition-colors cursor-pointer disabled:opacity-40"
                >
                  {copied ? <Check size={12} className="text-app-status-success" /> : <Copy size={12} />}
                  {copied ? '已复制' : '复制译文'}
                </button>
              )}
            </div>
        </>
      )}
    </div>
  );
}
