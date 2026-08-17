import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CheckCheck, Eraser, StickyNote } from 'lucide-react';
import type { MenuItem } from '@/types';
import { confirmDialog } from '@/stores/confirmStore';
import { useToastStore } from '@/stores/toastStore';

/**
 * 备忘插件的 nav 菜单项（列表级批量操作 + 桌面便签开关）。
 * 菜单与视图不共享状态：批量改库后由后端 memo:changed 事件驱动视图刷新。
 * 便签开关状态跨窗口同步：便签自己的关闭按钮也走同一命令，经 memo-sticky:toggled 回流。
 */
export function useMemoMenuItems(): MenuItem[] {
  const { addToast } = useToastStore();
  const [stickyEnabled, setStickyEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<string | null>('get_setting', { key: 'memo_sticky.enabled' })
      .then((v) => setStickyEnabled(v === '1'))
      .catch(() => setStickyEnabled(false));
    const unlisten = listen<boolean>('memo-sticky:toggled', (e) => {
      setStickyEnabled(e.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleToggleSticky = useCallback(() => {
    const next = !(stickyEnabled ?? false);
    setStickyEnabled(next); // 立即反馈，事件回流对齐
    invoke('set_memo_sticky_enabled', { enabled: next }).catch((e: unknown) => {
      setStickyEnabled(!next);
      addToast({ type: 'error', title: '便签开关失败', message: String(e) });
    });
  }, [stickyEnabled, addToast]);

  const handleCompleteAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: '全部标为完成',
      message: '确定把所有待处理备忘标记为完成吗？',
      detail: '只能在列表中逐条勾回。',
      confirmLabel: '全部完成',
    });
    if (!ok) return;
    try {
      const n = await invoke<number>('bulk_set_memo_status', {
        fromStatus: 'pending',
        toStatus: 'done',
      });
      addToast(
        n > 0
          ? { type: 'success', title: '已全部标为完成', message: `${n} 条备忘已标记完成` }
          : { type: 'info', title: '没有待处理的备忘' },
      );
    } catch (e) {
      addToast({ type: 'error', title: '操作失败', message: String(e) });
    }
  }, [addToast]);

  const handleClearDone = useCallback(async () => {
    const ok = await confirmDialog({
      title: '清空已完成',
      message: '确定清空所有已完成的备忘吗？',
      detail: '清空后从列表移除（标记为忽略），不可恢复。',
      danger: true,
      confirmLabel: '清空',
    });
    if (!ok) return;
    try {
      const n = await invoke<number>('bulk_set_memo_status', {
        fromStatus: 'done',
        toStatus: 'dismissed',
      });
      addToast(
        n > 0
          ? { type: 'success', title: '已清空', message: `${n} 条已完成备忘已移除` }
          : { type: 'info', title: '没有已完成的备忘' },
      );
    } catch (e) {
      addToast({ type: 'error', title: '清空失败', message: String(e) });
    }
  }, [addToast]);

  return [
    {
      id: 'toggle-sticky',
      label: stickyEnabled ? '隐藏桌面便签' : '显示桌面便签',
      icon: StickyNote,
      onClick: handleToggleSticky,
    },
    { id: 'complete-all', label: '全部标为完成', icon: CheckCheck, separator: true, onClick: handleCompleteAll },
    {
      id: 'clear-done',
      label: '清空已完成',
      icon: Eraser,
      danger: true,
      separator: true,
      onClick: handleClearDone,
    },
  ];
}
