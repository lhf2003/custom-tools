import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceInputOptions {
  /** 转写成功:文本交由调用方填入输入框(追加草稿) */
  onTranscribed: (text: string) => void;
  onError: (message: string) => void;
}

/** 单段录音上限:防忘关一直录;聊天口述远小于此 */
const MAX_RECORD_MS = 120_000;

/**
 * 聊天语音输入:点击开始录音、再点停止 → Moss moss-transcribe 转写。
 * MediaRecorder 产出 webm/opus(Moss 支持容器列表内),经 Rust 中转上传。
 */
export function useVoiceInput({ onTranscribed, onError }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  // onstop 为异步闭包,回调经 ref 取最新,避免过期渲染捕获
  const callbacksRef = useRef({ onTranscribed, onError });
  callbacksRef.current = { onTranscribed, onError };

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const toggle = useCallback(async () => {
    // 录音中 → 停止(onstop 里接力转写);转写中不响应
    if (recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    if (state !== 'idle') return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      callbacksRef.current.onError('无法访问麦克风,请检查系统麦克风权限');
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      clearTimer();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = await invoke<string>('moss_transcribe', {
          audio: Array.from(bytes),
          fileName: 'voice-input.webm',
        });
        callbacksRef.current.onTranscribed(text);
      } catch (err) {
        callbacksRef.current.onError(typeof err === 'string' ? err : '语音转写失败,请重试');
      } finally {
        setState('idle');
      }
    };

    recorderRef.current = recorder;
    recorder.start();
    setState('recording');
    timerRef.current = window.setTimeout(() => {
      recorderRef.current?.stop();
    }, MAX_RECORD_MS);
  }, [state, clearTimer]);

  // 卸载清理:录音流与定时器都不能泄漏
  useEffect(
    () => () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      clearTimer();
    },
    [clearTimer],
  );

  return { state, toggle };
}
