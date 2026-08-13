import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { speakText, stopSpeech } from '@/utils/speech';

/** 播报目标：原文 / 译文 */
export type SpeechTarget = 'source' | 'translation';

interface UseSpeechPlaybackOptions {
  /** 播报开始/结束回调（浮窗据此禁用/恢复 stale 兜底定时器） */
  onPlaybackChange?: (playing: boolean) => void;
}

/**
 * 翻译播报状态机：记录哪个目标在播（source/translation/null）。
 * 同目标再点 = 停止；切目标直接播新的——Rust 端单句柄，新播报自动打断旧播报，
 * 打断广播的 moss:tts:done 会顺带清旧播放态；别处（聊天视图等）发起播报
 * 打断本处时，同一个 done 事件也会把本处播放态清掉，无需额外同步。
 */
export function useSpeechPlayback({ onPlaybackChange }: UseSpeechPlaybackOptions = {}) {
  const [playing, setPlaying] = useState<SpeechTarget | null>(null);
  // ref 真值源：toggle/stop 内同步读写，不冒闭包旧值的险（渲染间隙快速连点）
  const playingRef = useRef<SpeechTarget | null>(null);
  const onChangeRef = useRef(onPlaybackChange);
  onChangeRef.current = onPlaybackChange;

  const updatePlaying = useCallback((target: SpeechTarget | null) => {
    if (playingRef.current === target) return;
    playingRef.current = target;
    setPlaying(target);
    onChangeRef.current?.(target !== null);
  }, []);

  // Rust 播完/被打断广播 done 清态（幂等：未在播时收到是 no-op）
  useEffect(() => {
    const unlisten = listen<void>('moss:tts:done', () => updatePlaying(null));
    return () => {
      unlisten
        .then((fn) => fn())
        .catch((err: unknown) => console.error('Failed to cleanup tts done listener:', err));
    };
  }, [updatePlaying]);

  const toggle = useCallback(
    (target: SpeechTarget, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (playingRef.current === target) {
        stopSpeech();
        updatePlaying(null);
        return;
      }
      updatePlaying(target);
      // invoke 直接失败（未配 Key 等 Rust 端前置 Err）回本——只清自己这次，
      // 期间若已切到别的播报不抢清
      speakText(trimmed).catch(() => {
        if (playingRef.current === target) updatePlaying(null);
      });
    },
    [updatePlaying],
  );

  /** 主动停播（浮窗关闭/新翻译开始/切换目标语言重译时调用）；未在播时 no-op */
  const stop = useCallback(() => {
    if (playingRef.current === null) return;
    stopSpeech();
    updatePlaying(null);
  }, [updatePlaying]);

  return { playing, toggle, stop };
}
