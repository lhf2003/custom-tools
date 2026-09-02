import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useToastStore } from '@/stores/toastStore';
import { useAppStore } from '@/stores/appStore';
import type { MemoryHit } from './types';

/**
 * 记忆条目打开（复用自启动器 handleMemoryOpen）：
 * 浏览/字幕跳 URL（带 ?t= 秒级锚点），笔记跳笔记视图，剪贴板复制内容。
 * opened_url/opened_file/copy_content 后隐藏窗口；open_note 主窗内跳视图。
 */
export function useMemoryOpen(): (hit: MemoryHit) => Promise<void> {
  const addToast = useToastStore((s) => s.addToast);
  const setActiveView = useAppStore((s) => s.setActiveView);

  return useCallback(
    async (hit: MemoryHit) => {
      try {
        const res = await invoke<{ action: string; content?: string }>('memory_open', {
          id: hit.id,
        });
        if (res.action === 'opened_url' || res.action === 'opened_file') {
          await invoke('hide_window');
        } else if (res.action === 'copy_content' && res.content) {
          await navigator.clipboard.writeText(res.content);
          addToast({
            type: 'success',
            title: '已复制',
            message: res.content.length > 50 ? `${res.content.slice(0, 50)}…` : res.content,
          });
          await invoke('hide_window');
        } else if (res.action === 'open_note') {
          setActiveView('markdown');
        }
      } catch (err) {
        addToast({ type: 'error', title: '打开记忆失败', message: String(err) });
      }
    },
    [addToast, setActiveView],
  );
}
