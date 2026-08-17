import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCheck, Eraser } from 'lucide-react';
import type { MenuItem } from '@/types';
import { confirmDialog } from '@/stores/confirmStore';
import { useToastStore } from '@/stores/toastStore';

/**
 * 备忘插件的 nav 菜单项（列表级批量操作）。
 * 菜单与视图不共享状态：批量改库后由后端 memo:changed 事件驱动视图刷新。
 */
export function useMemoMenuItems(): MenuItem[] {
  const { addToast } = useToastStore();

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
    { id: 'complete-all', label: '全部标为完成', icon: CheckCheck, onClick: handleCompleteAll },
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
