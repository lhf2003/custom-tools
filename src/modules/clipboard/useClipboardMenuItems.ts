import { useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { ClipboardPaste, Copy, Download, FolderOpen, Sparkles, Star, Trash2 } from 'lucide-react';
import { useClipboardSelectionStore } from '@/stores/clipboardSelectionStore';
import { useToastStore } from '@/stores/toastStore';
import type { MenuItem } from '@/types';

type ClipboardEntryAction = 'paste' | 'copy' | 'favorite' | 'delete' | 'reveal' | 'send-to-ai';

/**
 * 剪贴板条目级动作（粘贴/复制/发送给AI/收藏/删除/打开位置）：
 * 选中态联动禁用与文案，图片条目追加「在资源管理器中打开」。
 * 条目级动作通过 custom event 下发给 ClipboardView 执行，
 * 事件名是插件内部实现细节，壳不再感知。
 */
export function useClipboardItemMenuItems(): MenuItem[] {
  const clipboardSelection = useClipboardSelectionStore();

  const dispatchClipboardAction = useCallback((action: ClipboardEntryAction) => {
    window.dispatchEvent(new CustomEvent(`clipboard:${action}-selected`));
  }, []);

  return useMemo<MenuItem[]>(() => [
    {
      id: 'paste',
      label: '粘贴',
      icon: ClipboardPaste,
      shortcut: '⏎',
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('paste'),
    },
    {
      id: 'copy',
      label: '复制',
      icon: Copy,
      shortcut: 'Ctrl+⏎',
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('copy'),
    },
    {
      id: 'send-to-ai',
      label: '发送给AI',
      icon: Sparkles,
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('send-to-ai'),
    },
    {
      id: 'favorite',
      label: clipboardSelection.isFavorite ? '取消收藏' : '收藏',
      icon: Star,
      shortcut: 'F',
      disabled: !clipboardSelection.hasSelection,
      separator: true,
      onClick: () => dispatchClipboardAction('favorite'),
    },
    {
      id: 'delete',
      label: '删除',
      icon: Trash2,
      shortcut: 'Del',
      danger: true,
      disabled: !clipboardSelection.hasSelection,
      onClick: () => dispatchClipboardAction('delete'),
    },
    ...(clipboardSelection.isImage
      ? [{
          id: 'reveal',
          label: '在资源管理器中打开',
          icon: FolderOpen,
          separator: true,
          onClick: () => dispatchClipboardAction('reveal'),
        }]
      : []),
  ], [clipboardSelection, dispatchClipboardAction]);
}

/**
 * 剪贴板顶部「操作」下拉的完整菜单：条目级动作 + 列表级动作（清空/导出）。
 * 从 App.tsx viewConfigs.clipboard 收编。右键浮层只用条目级子集
 * （useClipboardItemMenuItems），列表级操作不进右键。
 */
export function useClipboardMenuItems(): MenuItem[] {
  const { addToast } = useToastStore();
  const itemMenuItems = useClipboardItemMenuItems();

  // 清空剪贴板历史（keepFavorites=true 时仅删除非收藏记录）
  const handleClearClipboard = useCallback(async (keepFavorites: boolean) => {
    const confirmed = confirm(
      keepFavorites
        ? '确定要删除所有非收藏的剪贴板记录吗？'
        : '确定要清空所有剪贴板历史吗？（含收藏）'
    );
    if (!confirmed) return;
    try {
      const count = await invoke<number>('clear_clipboard_history', { keepFavorites });
      addToast({
        type: 'success',
        title: keepFavorites ? '已删除非收藏记录' : '已清空历史',
        message: `已删除 ${count} 条记录`,
      });
    } catch (err) {
      addToast({
        type: 'error',
        title: '清空失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToast]);

  // 导出剪贴板历史为 JSON 文件
  const handleExportClipboard = useCallback(async () => {
    try {
      const path = await save({
        defaultPath: 'clipboard-history.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      const count = await invoke<number>('export_clipboard_history', { path });
      addToast({ type: 'success', title: '导出完成', message: `已导出 ${count} 条记录` });
    } catch (err) {
      addToast({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToast]);

  return useMemo((): MenuItem[] => [
    ...itemMenuItems,
    {
      id: 'clear-all',
      label: '清空历史',
      icon: Trash2,
      danger: true,
      separator: true,
      onClick: () => handleClearClipboard(false),
    },
    {
      id: 'keep-favorites',
      label: '仅保留收藏',
      icon: Star,
      onClick: () => handleClearClipboard(true),
    },
    {
      id: 'export',
      label: '导出数据',
      icon: Download,
      separator: true,
      onClick: handleExportClipboard,
    },
  ], [itemMenuItems, handleClearClipboard, handleExportClipboard]);
}
