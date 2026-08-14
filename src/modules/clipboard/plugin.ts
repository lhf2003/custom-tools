import { Command } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';
import { useClipboardItemMenuItems, useClipboardMenuItems } from './useClipboardMenuItems';

const clipboardPlugin: ViewPlugin = {
  kind: 'view',
  id: 'clipboard',
  name: '剪贴板',
  icon: Command,
  aliases: ['clipboard', 'clip', 'paste', 'copy'],
  description:
    '记录并管理您的剪贴板历史，支持文本、图片、文件等多种格式。可收藏常用内容，快速粘贴历史记录。',
  order: 3,
  shortcutModuleId: 'clipboard',
  triggers: [{ keyword: '@clipboard' }],
  load: () => import('./ClipboardView').then((m) => ({ default: m.ClipboardView })),
  nav: {
    title: '剪贴板历史',
    menuLabel: '操作',
    useMenuItems: useClipboardMenuItems,
    contextMenu: true,
    // 右键只给条目级动作；列表级（清空/导出）只留在顶部「操作」下拉
    useContextMenuItems: useClipboardItemMenuItems,
  },
};

export default clipboardPlugin;
