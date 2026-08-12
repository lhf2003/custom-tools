import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BookPlus, Check, Copy, Loader2, Send, X } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';

/**
 * 全局语音输入浮窗：录音条(实时电平/计时,hover 展开取消/完成) →
 * 转写(Moss) → 完成卡片(可编辑 + 发送AI/存笔记/复制 三选一)。
 * 状态机在此,窗口显隐/定位/尺寸在 Rust(voice 模块);背景 panel-glass-toast
 * 主题玻璃(颜色与透明度随全局主题),同划词翻译/陪伴浮窗标准。
 */

type Phase = 'idle' | 'recording' | 'transcribing' | 'result';

/** 单段录音上限:防忘关;到点自动停止并转写(等价按 ✓) */
const MAX_RECORD_MS = 120_000;
/** 电平点阵列数 */
const LEVEL_BARS = 24;

const BAR_BASE = [...Array(LEVEL_BARS)].map(() => 3);

function formatTime(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export default function VoiceToast() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(BAR_BASE);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const phaseRef = useRef<Phase>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelFlagRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const lastLevelPushRef = useRef(0);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  /** 停止一切采集资源(麦克风/分析器/定时器) */
  const teardownCapture = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  /** 收窗复位:隐藏 + 回到 idle(下次快捷键重新从录音条开始) */
  const dismiss = useCallback(() => {
    teardownCapture();
    setPhaseBoth('idle');
    setText('');
    setError(null);
    setSeconds(0);
    setLevels(BAR_BASE);
    setActing(false);
    getCurrentWindow().hide().catch(() => {});
  }, [teardownCapture, setPhaseBoth]);

  /** 转写完成(成功或失败都进卡片;失败带错误条,文本区可手动打字) */
  const finishTranscribe = useCallback(
    async (blob: Blob) => {
      setPhaseBoth('transcribing');
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = await invoke<string>('moss_transcribe', {
          audio: Array.from(bytes),
          fileName: 'voice-input.webm',
        });
        setText(result);
      } catch (err) {
        setError(typeof err === 'string' ? err : '语音转写失败,请重试');
      }
      setPhaseBoth('result');
      invoke('voice_set_phase', { phase: 'card' }).catch(() => {});
    },
    [setPhaseBoth],
  );

  /** finish=true 结束并转写;false 取消丢弃 */
  const stopRecording = useCallback(
    (finish: boolean) => {
      cancelFlagRef.current = !finish;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        dismiss();
      }
    },
    [dismiss],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    setText('');
    setSeconds(0);
    setLevels(BAR_BASE);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // 麦克风不可用:照样弹卡片(空文本可打字),错误条说明——链路不废
      setError('无法访问麦克风,请检查系统麦克风权限');
      setPhaseBoth('result');
      invoke('voice_set_phase', { phase: 'card' }).catch(() => {});
      return;
    }
    streamRef.current = stream;

    // 实时电平:AnalyserNode 频域聚合 24 段,~10fps 推 state(够看且不重渲染风暴)
    const audioCtx = new AudioContext();
    // 快捷键唤醒不算用户手势,AudioContext 可能被 autoplay 策略挂起——显式 resume
    audioCtx.resume().catch(() => {});
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      const node = analyserRef.current;
      if (!node) return;
      node.getByteFrequencyData(freq);
      const now = performance.now();
      if (now - lastLevelPushRef.current > 100) {
        lastLevelPushRef.current = now;
        const step = Math.floor(freq.length / LEVEL_BARS);
        const next = BAR_BASE.map((base, i) => {
          let sum = 0;
          for (let j = i * step; j < (i + 1) * step; j++) sum += freq[j];
          const v = sum / step / 255; // 0..1
          return base + Math.round(v * 14); // 3..17px 高度
        });
        setLevels(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    cancelFlagRef.current = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      chunksRef.current = [];
      const cancelled = cancelFlagRef.current;
      teardownCapture();
      if (cancelled || blob.size === 0) {
        dismiss();
      } else {
        void finishTranscribe(blob);
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhaseBoth('recording');

    timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    maxTimerRef.current = window.setTimeout(() => stopRecording(true), MAX_RECORD_MS);

    // 隐藏态先把窗口收为条形,渲染回执后 Rust 再定位 + show(透明窗握手)
    invoke('voice_set_phase', { phase: 'bar' }).catch(() => {});
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        invoke('voice_bar_ready').catch(() => {});
      });
    });
  }, [dismiss, finishTranscribe, setPhaseBoth, stopRecording]);

  /** 快捷键 toggle 裁决:idle→开始;recording→结束转写;transcribing→忽略;result→新一轮 */
  const handleToggle = useCallback(() => {
    switch (phaseRef.current) {
      case 'idle':
      case 'result':
        void startRecording();
        break;
      case 'recording':
        stopRecording(true);
        break;
      case 'transcribing':
        break;
    }
  }, [startRecording, stopRecording]);

  // 挂载:listen toggle + pending 兜底(预创建页面晚于首次快捷键时 emit 已丢)
  useEffect(() => {
    const unlisten = listen('voice:toggle', handleToggle);
    invoke<boolean>('voice_take_pending_toggle')
      .then((pending) => {
        if (pending) handleToggle();
      })
      .catch(() => {});
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [handleToggle]);

  // Esc:录音中=取消;卡片=关闭(textarea 聚焦时同样生效)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (phaseRef.current === 'recording') stopRecording(false);
      else if (phaseRef.current === 'result') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, stopRecording]);

  // 卸载兜底:释放麦克风/定时器
  useEffect(() => teardownCapture, [teardownCapture]);

  // ── 三操作(单选,执行完即关) ────────────────────────────────
  const handleSendToChat = useCallback(async () => {
    if (!text.trim() || acting) return;
    setActing(true);
    try {
      await invoke('voice_send_to_chat', { text: text.trim() });
      dismiss();
    } catch (err) {
      setError(typeof err === 'string' ? err : '发送失败');
      setActing(false);
    }
  }, [text, acting, dismiss]);

  const handleSaveNote = useCallback(async () => {
    if (!text.trim() || acting) return;
    setActing(true);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      // Windows 文件名禁冒号,时间用连字符
      const name = `语音笔记 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}.md`;
      await invoke('create_note', { request: { path: name, is_folder: false } });
      await invoke('save_note', { request: { path: name, content: text } });
      dismiss();
    } catch (err) {
      setError(typeof err === 'string' ? err : '存笔记失败');
      setActing(false);
    }
  }, [text, acting, dismiss]);

  const handleCopy = useCallback(async () => {
    if (!text.trim() || acting) return;
    setActing(true);
    try {
      await invoke('copy_text_to_clipboard', { text });
      dismiss();
    } catch (err) {
      setError(typeof err === 'string' ? err : '复制失败');
      setActing(false);
    }
  }, [text, acting, dismiss]);

  if (phase === 'idle') return null;

  return (
    <div className="w-full h-full flex items-stretch justify-stretch bg-transparent">
      <div className="relative flex-1 m-1 rounded-xl border border-app-border-subtle panel-glass-toast shadow-2xl overflow-hidden flex flex-col">
        {phase === 'result' ? (
          <>
            {/* 完成卡片:操作行 + 可编辑文本(图3) */}
            <div
              data-tauri-drag-region
              className="flex items-center gap-1 px-2.5 pt-2 pb-1 cursor-default"
            >
              <Tooltip content="发送给 AI 聊天" wrapperClassName="shrink-0">
                <button
                  onClick={handleSendToChat}
                  disabled={!text.trim() || acting}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="发送给 AI 聊天"
                >
                  <Send size={13} />
                </button>
              </Tooltip>
              <Tooltip content="存到笔记" wrapperClassName="shrink-0">
                <button
                  onClick={handleSaveNote}
                  disabled={!text.trim() || acting}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="存到笔记"
                >
                  <BookPlus size={13} />
                </button>
              </Tooltip>
              <Tooltip content="复制到剪贴板" wrapperClassName="shrink-0">
                <button
                  onClick={handleCopy}
                  disabled={!text.trim() || acting}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="复制到剪贴板"
                >
                  <Copy size={13} />
                </button>
              </Tooltip>
              <div data-tauri-drag-region className="flex-1" />
              <button
                onClick={dismiss}
                className="w-6 h-6 rounded-md flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer shrink-0"
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
            {error && (
              <div className="mx-2.5 mb-1 px-2 py-1 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 leading-snug">
                {error}
              </div>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="转写文本(可直接编辑)"
              className="flex-1 min-h-0 mx-2.5 mb-2.5 px-2 py-1.5 rounded-lg bg-transparent border-none text-xs text-app-text-primary placeholder-app-text-placeholder outline-none resize-none leading-relaxed"
            />
          </>
        ) : (
          /* 录音条:点阵电平 + 计时;hover 浮现 取消/完成(图1→图2)。
             按钮 opacity 切换而非 display——槽位恒定,布局不跳动、位置不偏移 */
          <div data-tauri-drag-region className="group flex-1 flex items-center px-2 gap-1.5 cursor-default">
            {phase === 'transcribing' ? (
              <>
                <Loader2 size={13} className="text-app-text-tertiary animate-spin shrink-0" />
                <span className="text-xs text-app-text-tertiary">转写中…</span>
              </>
            ) : (
              <>
                <button
                  onClick={() => stopRecording(false)}
                  tabIndex={-1}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-all opacity-0 group-hover:opacity-100 cursor-pointer shrink-0"
                  aria-label="取消录音"
                >
                  <X size={13} />
                </button>
                <div className="flex-1 flex items-center justify-center gap-[3px] h-5">
                  {levels.map((h, i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-full bg-[var(--app-alpha-white-50)] transition-[height] duration-100"
                      style={{ height: `${h}px` }}
                    />
                  ))}
                </div>
                <span className="text-xs text-app-text-secondary tabular-nums shrink-0">
                  {formatTime(seconds)}
                </span>
                <button
                  onClick={() => stopRecording(true)}
                  tabIndex={-1}
                  className="w-6 h-6 rounded-md flex items-center justify-center text-app-status-success hover:bg-app-bg-hover transition-all opacity-0 group-hover:opacity-100 cursor-pointer shrink-0"
                  aria-label="完成并转写"
                >
                  <Check size={13} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
