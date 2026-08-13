import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Check, Languages, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar';
import { TargetLangMenu } from './TargetLangMenu';
import { TARGET_LANG_KEY } from '../constants';
import { useSpeechPlayback } from '../useSpeechPlayback';
import { SpeakButton } from '../SpeakButton';

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

/** translate:hint 事件的提示壳（与 Rust 端 TranslateHintPayload 对应）：
 *  空选区等提示走独立通道——error 可能被视图链路触发，hint 永远只面向浮窗 */
interface TranslateHintPayload {
  message: string;
}

/** 挂载补拉的待展示内容（与 Rust 端 PendingTranslate 的 serde tag/content 对应） */
type PendingTranslate =
  | { kind: 'Start'; data: TranslateStartPayload }
  | { kind: 'Hint'; data: TranslateHintPayload };

type ToastStatus = 'idle' | 'translating' | 'done' | 'error';

/** 窗口从未获得焦点（后台触发被焦点锁拦截）时的兜底：60s 无事件自动隐藏 */
const STALE_HIDE_MS = 60_000;

export default function TranslateToast() {
  // 独立窗口共享 index.css：滚动条自动隐藏需在本窗口单独挂载
  useAutoHideScrollbar();

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
  // 就绪握手信号：start/hint 处理后递增，触发渲染完成回执（chunk/done/error 不触发——
  // 进行中的后续帧若发回执，窗口会被重新定位拽回鼠标处）
  const [showNonce, setShowNonce] = useState(0);
  // 停播入口的 ref 中转：hideWindow（声明在前）依赖它，useSpeechPlayback（声明在后）填充它，
  // 解开「hideWindow → stop → hook → onPlaybackChange → resetStaleTimer → hideWindow」声明环
  const stopSpeechRef = useRef<() => void>(() => {});

  const hideWindow = useCallback(() => {
    // 消失即停播（Esc/X/stale 全走这里）
    stopSpeechRef.current();
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

  // 播报期间禁用 stale 兜底：播报中的浮窗是活跃状态，不能被 60s 无事件规则隐藏；
  // 播报结束重新武装（窗口若已隐藏，60s 后重复 hide 无害）
  const handlePlaybackChange = useCallback(
    (isPlaying: boolean) => {
      if (isPlaying) {
        if (staleTimerRef.current !== null) {
          window.clearTimeout(staleTimerRef.current);
          staleTimerRef.current = null;
        }
      } else {
        resetStaleTimer();
      }
    },
    [resetStaleTimer],
  );

  const {
    playing: speechPlaying,
    toggle: toggleSpeech,
    stop: stopSpeechPlayback,
  } = useSpeechPlayback({ onPlaybackChange: handlePlaybackChange });
  // 同步给 ref：hideWindow/applyStart 等声明在前的回调经此调停播
  stopSpeechRef.current = stopSpeechPlayback;

  // start/hint 应用逻辑提取为稳定回调：事件监听与挂载补拉共用
  const applyStart = useCallback(
    (p: TranslateStartPayload) => {
      latestIdRef.current = Math.max(latestIdRef.current, p.id);
      stopSpeechRef.current(); // 新划词到达：旧内容播报停止（对齐发新消息停播语义）
      setSource(p.source);
      setTargetLang(p.target_lang);
      setTranslation('');
      setErrorMsg('');
      setSourceExpanded(false);
      setCopied(false);
      updateStatus('translating');
      resetStaleTimer();
      setShowNonce((n) => n + 1);
    },
    [resetStaleTimer, updateStatus],
  );

  const applyHint = useCallback(
    (p: TranslateHintPayload) => {
      // 流式进行中不打扰（连按快捷键空选区时，提示让位当前翻译）
      if (statusRef.current === 'translating') return;
      setErrorMsg(p.message);
      updateStatus('error');
      window.setTimeout(hideWindow, 2000);
      setShowNonce((n) => n + 1);
    },
    [hideWindow, updateStatus],
  );

  // 事件通道：只接受最新 id（start 视为最高优先级新请求；chunk/done/error 按 id 过滤）。
  // 只挂一次：状态经 statusRef 读取，deps 均为稳定引用——随 status 重订阅会累积
  // 监听器（旧闭包不注销，chunk 被多份 append），cleanup 也必须无条件退订
  useEffect(() => {
    const unlistens: Promise<() => void>[] = [];

    unlistens.push(
      listen<TranslateStartPayload>('translate:start', (event) => applyStart(event.payload)),
      listen<TranslateHintPayload>('translate:hint', (event) => applyHint(event.payload)),
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
        // 只受理当前请求的流式错误；提示走独立的 translate:hint，
        // 视图链路（translate_text，无 start）的错误与浮窗无关
        if (p.id !== latestIdRef.current) return;
        setErrorMsg(p.message ?? '翻译失败');
        updateStatus('error');
        resetStaleTimer();
      }),
    );

    // 本窗口是启动时预创建的隐藏窗口，页面异步加载可能晚于首次 emit
    //（Tauri 事件即发即丢）：挂载后补拉待展示内容兜底
    invoke<PendingTranslate | null>('get_pending_translate_toast')
      .then((pending) => {
        if (!pending) return;
        if (pending.kind === 'Start') applyStart(pending.data);
        else applyHint(pending.data);
      })
      .catch((err: unknown) => console.error('Failed to fetch pending translate toast:', err));

    return () => {
      // 无条件注销：promise 晚于 cleanup 才 resolve 时同样要退订（CompanionToast 同款）
      unlistens.forEach((u) =>
        u.then((fn) => fn()).catch((err: unknown) => {
          console.error('Failed to cleanup translate listener:', err);
        }),
      );
    };
  }, [applyStart, applyHint, hideWindow, resetStaleTimer, updateStatus]);

  // 渲染完成回执（就绪握手）：双 rAF 确保内容已实际绘制，
  // Rust 收到回执后才把窗口定位到鼠标附近并 show——先 show 会呈现透明空帧
  useEffect(() => {
    if (showNonce === 0) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          invoke('translate_toast_ready').catch((err: unknown) =>
            console.error('Failed to signal translate toast ready:', err),
          );
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [showNonce]);

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

  // 切换目标语言：保存为默认（后续划词翻译生效）+ 当前原文立即重译。
  // 先换新 id 再清空译文——此后旧流 chunk 全被 id 过滤，清空后的译文区不会被旧块污染
  const handleTargetLangChange = useCallback(
    (lang: string) => {
      if (lang === targetLang) return;
      setTargetLang(lang);
      invoke('set_setting', { key: TARGET_LANG_KEY, value: lang }).catch(() => {});

      const text = source.trim();
      if (!text) return; // 提示态无原文可译，仅更新默认语言

      stopSpeechPlayback(); // 重译即内容变更，进行中的播报停止
      invoke<number>('translate_text', { text, targetLang: lang })
        .then((id) => {
          latestIdRef.current = id;
          setTranslation('');
          setErrorMsg('');
          setCopied(false);
          updateStatus('translating');
          resetStaleTimer();
        })
        .catch((err: unknown) => {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          updateStatus('error');
          resetStaleTimer();
        });
    },
    [targetLang, source, updateStatus, resetStaleTimer, stopSpeechPlayback],
  );

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
          <TargetLangMenu value={targetLang} onChange={handleTargetLangChange} />
        )}
        <Tooltip content="关闭（Esc）" wrapperClassName="shrink-0">
          <button
            onClick={hideWindow}
            className="text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer shrink-0"
          >
            <X size={14} />
          </button>
        </Tooltip>
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
              <div className="relative">
                <p
                  ref={sourceTextRef}
                  className={`text-xs leading-relaxed text-app-text-tertiary whitespace-pre-wrap break-words pr-6 ${
                    sourceExpanded ? '' : 'line-clamp-3'
                  }`}
                >
                  {source}
                </p>
                <SpeakButton
                  playing={speechPlaying === 'source'}
                  onToggle={() => toggleSpeech('source', source)}
                  label="听原文"
                  wrapperClassName="absolute right-0 top-0"
                />
              </div>
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
              {status === 'done' && translation && (
                <SpeakButton
                  playing={speechPlaying === 'translation'}
                  onToggle={() => toggleSpeech('translation', translation)}
                  label="播报译文"
                  wrapperClassName="shrink-0"
                />
              )}
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
