import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Copy, Check, Eraser, Languages, Loader2 } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { CustomSelect } from '@/modules/settings/components/CustomSelect';
import { TARGET_LANG_OPTIONS, TARGET_LANG_KEY, DEFAULT_TARGET_LANG } from './constants';

/** translate:chunk / done / error 事件的统一壳（与 Rust 端 TranslateEventPayload 对应） */
interface TranslateEventPayload {
  id: number;
  text?: string;
  message?: string;
}

type TranslateStatus = 'idle' | 'translating' | 'done' | 'error';

export function TranslateView() {
  const [source, setSource] = useState('');
  const [translation, setTranslation] = useState('');
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG);
  const [status, setStatus] = useState<TranslateStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const ownIdRef = useRef<number | null>(null);
  const { addToast } = useToastStore();

  // 初始目标语言：读设置值（缺省中文）
  useEffect(() => {
    invoke<string | null>('get_setting', { key: TARGET_LANG_KEY })
      .then((v) => {
        if (v) setTargetLang(v);
      })
      .catch(() => {});
  }, []);

  // 流式事件：只处理自己这次请求的 id（浮窗翻译并发时互不污染）
  useEffect(() => {
    const unlistens: Promise<() => void>[] = [];

    unlistens.push(
      listen<TranslateEventPayload>('translate:chunk', (event) => {
        if (event.payload.id !== ownIdRef.current) return;
        setTranslation((prev) => prev + (event.payload.text ?? ''));
      }),
      listen<TranslateEventPayload>('translate:done', (event) => {
        if (event.payload.id !== ownIdRef.current) return;
        setStatus('done');
      }),
      listen<TranslateEventPayload>('translate:error', (event) => {
        if (event.payload.id !== ownIdRef.current) return;
        setStatus('error');
        setErrorMsg(event.payload.message ?? '翻译失败');
      }),
    );

    return () => {
      // 无条件注销：promise 晚于 cleanup 才 resolve 时同样要退订
      unlistens.forEach((u) =>
        u.then((fn) => fn()).catch((err: unknown) => {
          console.error('Failed to cleanup translate listener:', err);
        }),
      );
    };
  }, []);

  const handleTranslate = useCallback(async () => {
    const text = source.trim();
    if (!text) return;
    if (status === 'translating') return;

    setTranslation('');
    setErrorMsg('');
    setStatus('translating');
    try {
      const id = await invoke<number>('translate_text', { text, targetLang });
      ownIdRef.current = id;
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [source, targetLang, status]);

  const handleCopy = useCallback(async () => {
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      addToast({ type: 'error', title: '复制失败', message: String(err) });
    }
  }, [translation, addToast]);

  const handleTargetChange = useCallback((lang: string) => {
    setTargetLang(lang);
    // 持久化到设置（后续划词翻译的默认目标语言）
    invoke('set_setting', { key: TARGET_LANG_KEY, value: lang }).catch(() => {});
  }, []);

  const handleClear = useCallback(() => {
    setSource('');
    setTranslation('');
    setErrorMsg('');
    setStatus('idle');
    ownIdRef.current = null;
  }, []);

  return (
    <div className="w-full h-full flex flex-col min-h-0">
      {/* 输入区 */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 mb-2">
          <Languages size={14} className="text-app-text-tertiary" />
          <span className="text-sm font-medium text-app-text-primary">划词翻译</span>
          <span className="text-xs text-app-text-tertiary ml-1">
            任意应用选中文本按 Ctrl+Shift+T 即译
          </span>
          <div className="ml-auto flex items-center gap-2">
            <CustomSelect
              value={targetLang}
              options={TARGET_LANG_OPTIONS.map((lang) => ({ value: lang, label: lang }))}
              onChange={handleTargetChange}
              placeholder="目标语言"
              className="w-24"
              menuClassName="w-28"
            />
            <button
              onClick={handleClear}
              disabled={status === 'translating'}
              title="清空"
              className="flex items-center gap-1 px-2 h-7 rounded-md text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
            >
              <Eraser size={13} />
              清空
            </button>
          </div>
        </div>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="在此粘贴或输入要翻译的文本…（加密 PDF、图片等无法选中的文本可贴到这里）"
          spellCheck={false}
          className="w-full h-28 resize-none rounded-lg bg-app-bg-elevated border border-app-border-subtle px-3 py-2.5 text-sm text-app-text-secondary placeholder:text-app-text-placeholder outline-none focus:border-app-status-info/50 leading-relaxed"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleTranslate();
            }
          }}
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-app-text-placeholder">Ctrl+Enter 翻译</span>
          <button
            onClick={handleTranslate}
            disabled={!source.trim() || status === 'translating'}
            className="flex items-center gap-1.5 px-3.5 h-7 rounded-md text-xs font-medium text-white bg-app-status-info hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-40"
          >
            {status === 'translating' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                翻译中…
              </>
            ) : (
              '翻译'
            )}
          </button>
        </div>
      </div>

      {/* 结果区 */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        {status === 'idle' ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
            <Languages size={28} className="text-app-text-disabled" />
            <p className="text-sm text-app-text-tertiary">翻译结果将在这里流式显示</p>
          </div>
        ) : (
          <div className="h-full flex flex-col min-h-0 rounded-lg border border-app-border-subtle bg-app-bg-elevated overflow-hidden">
            {/* 原文 */}
            {source.trim() && (
              <div className="flex-shrink-0 px-3 py-2 border-b border-app-border-subtle">
                <p className="text-xs text-app-text-tertiary leading-relaxed line-clamp-3 whitespace-pre-wrap break-all">
                  {source.trim()}
                </p>
              </div>
            )}
            {/* 译文 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
              {status === 'error' ? (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-app-status-error">{errorMsg}</span>
                </div>
              ) : (
                <p className="text-sm text-app-text-primary leading-relaxed whitespace-pre-wrap break-words">
                  {translation}
                  {status === 'translating' && (
                    <span className="inline-block w-0.5 h-4 ml-0.5 align-middle bg-app-status-info animate-pulse" />
                  )}
                </p>
              )}
            </div>
            {/* 操作行 */}
            <div className="flex-shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-t border-app-border-subtle">
              <button
                onClick={handleCopy}
                disabled={!translation}
                className="flex items-center gap-1 px-2.5 h-6 rounded-md text-xs text-app-text-secondary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40"
              >
                {copied ? <Check size={12} className="text-app-status-success" /> : <Copy size={12} />}
                {copied ? '已复制' : '复制译文'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
