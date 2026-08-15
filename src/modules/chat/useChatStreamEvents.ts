import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { mergeA2uiRow, type ChatMessage } from './sessionUtils';

export interface StreamEventHandlers {
  isCancelledRef: React.MutableRefObject<boolean>;
  streamTextRef: React.MutableRefObject<string>;
  sessionIdRef: React.MutableRefObject<number | null>;
  setStreamText: (v: string) => void;
  setIsLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  setCancelled: (v: boolean) => void;
  setAgentStatus: (v: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPlayingIdx: (v: number | null) => void;
  /** 一轮回复收尾（llm/jarvis 双通道共用）：追加气泡、落库、播报、记忆 poke */
  onReplyDone: (finalText: string) => void | Promise<void>;
  /** 流式出错：error 条已由 hook 置好，这里补「未取消时」的失败占位气泡 */
  onReplyError: (message: string, wasCancelled: boolean) => void;
}

/**
 * 聊天流式事件监听（llm:chunk/done/error + jarvis:start/status/chunk/done/error/surface +
 * moss:tts:done）。集中管理取消状态机（isCancelledRef 先读后复位）与 chunk 渲染：
 * ref 同步累加为真值源，setStreamText 走 rAF 节流——长回复高 chunk 频率下
 * 每帧最多渲染一次，done 时取消 pending 帧直接收尾。
 */
export function useChatStreamEvents(handlers: StreamEventHandlers): void {
  const {
    isCancelledRef,
    streamTextRef,
    sessionIdRef,
    setStreamText,
    setIsLoading,
    setError,
    setCancelled,
    setAgentStatus,
    setMessages,
    setPlayingIdx,
    onReplyDone,
    onReplyError,
  } = handlers;

  // 流式渲染节流：chunk 只累加 ref，rAF 每帧 flush 一次到 state
  // （顶层声明：effect 清理与 done/error 收尾都要取消 pending 帧）
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let unlistenFns: Array<() => void> = [];

    const flushStream = () => {
      rafRef.current = null;
      setStreamText(streamTextRef.current);
    };
    const scheduleStreamFlush = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(flushStream);
    };
    const cancelStreamFlush = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const handleChunk = (payload: string) => {
      if (isCancelledRef.current) return;
      // ref 同步累加（真值源）：state updater 是异步的，chunk 与 done
      // 背靠背到达时 done 会读到旧 ref，把回复弄丢（空消息+不落库）
      streamTextRef.current += payload;
      scheduleStreamFlush();
    };

    const handleDone = async () => {
      if (isCancelledRef.current) {
        isCancelledRef.current = false;
        setIsLoading(false);
        return;
      }
      cancelStreamFlush();
      const finalText = streamTextRef.current;
      setStreamText('');
      streamTextRef.current = '';
      setCancelled(false);
      setIsLoading(false);
      setAgentStatus(null);
      await onReplyDone(finalText);
    };

    const handleError = (payload: string) => {
      // 先读后复位：用户主动取消后姗姗来迟的 error 不该出兜底占位
      const wasCancelled = isCancelledRef.current;
      isCancelledRef.current = false;
      setAgentStatus(null);
      setError(payload);
      setCancelled(false);
      setIsLoading(false);
      cancelStreamFlush();
      setStreamText('');
      streamTextRef.current = '';
      onReplyError(payload, wasCancelled);
    };

    // fns 提到 setupListeners 外：注册中途异常时 catch 里能清理已注册的监听
    const fns: Array<() => void> = [];
    const setupListeners = async () => {
      const reg = (fn: () => void) => fns.push(fn);
      reg(await listen<string>('llm:chunk', (event) => handleChunk(event.payload)));
      reg(await listen<void>('llm:done', () => handleDone()));
      reg(await listen<string>('llm:error', (event) => handleError(event.payload)));

      // 贾维斯场景通道（流式事件契约 jarvis:start/status/chunk/done/error）
      reg(await listen<string>('jarvis:chunk', (event) => handleChunk(event.payload)));
      reg(await listen<number>('jarvis:done', () => handleDone()));
      reg(await listen<string>('jarvis:error', (event) => handleError(event.payload)));
      reg(await listen<string>('jarvis:status', (event) => {
        if (!isCancelledRef.current) setAgentStatus(event.payload);
      }));
      // 新一轮回复开始（首条与队列续发统一信号）：复位流式状态
      reg(await listen<void>('jarvis:start', () => {
        setIsLoading(true);
        setError(null);
        setStreamText('');
        streamTextRef.current = '';
      }));
      // A2UI 界面卡片（render_ui 工具，tool 循环中途到达）：同 surface 合并为一个气泡。
      // 落库由后端在 emit 时完成（前端 done 落库的只是文字回复）
      reg(await listen<{ sessionId: number; surfaceId: string; messages: unknown[] }>(
        'jarvis:surface',
        (event) => {
          if (isCancelledRef.current) return;
          if (event.payload.sessionId !== sessionIdRef.current) return;
          setMessages((prev) =>
            mergeA2uiRow(prev, JSON.stringify(event.payload)),
          );
        },
      ));
      // TTS 播完/被打断（interrupt 或收流自然结束都会广播）：清掉消息重播的播放态
      reg(await listen<void>('moss:tts:done', () => {
        setPlayingIdx(null);
      }));
      if (!active) {
        fns.forEach((fn) => fn());
        return;
      }
      unlistenFns = fns;
    };
    setupListeners().catch((e) => {
      // 注册中途异常：清理已注册的监听，避免泄漏
      console.error('Failed to setup chat listeners:', e);
      fns.forEach((fn) => fn());
    });
    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
      cancelStreamFlush();
    };
  }, [
    isCancelledRef,
    streamTextRef,
    sessionIdRef,
    setStreamText,
    setIsLoading,
    setError,
    setCancelled,
    setAgentStatus,
    setMessages,
    setPlayingIdx,
    onReplyDone,
    onReplyError,
  ]);
}
