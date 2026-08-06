import { FileText, Folder } from 'lucide-react';
import type { MenuItem } from '@/types';
import type { ViewPlugin } from '@/plugins/types';

function useMarkdownMenuItems(): MenuItem[] {
  return [
    {
      id: 'new-note',
      label: '新建笔记',
      icon: FileText,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('markdown:new-note'));
      },
    },
    {
      id: 'new-folder',
      label: '新建文件夹',
      icon: Folder,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('markdown:new-folder'));
      },
    },
  ];
}

const markdownPlugin: ViewPlugin = {
  kind: 'view',
  id: 'markdown',
  name: 'Markdown笔记',
  icon: FileText,
  aliases: ['markdown', 'md', 'note'],
  description:
    '轻量级Markdown编辑器，支持实时预览。适合快速记录想法、待办事项或撰写文档。',
  order: 4,
  shortcutModuleId: 'notes',
  load: () => import('./MarkdownView').then((m) => ({ default: m.MarkdownView })),
  nav: {
    title: 'Markdown 笔记',
    useMenuItems: useMarkdownMenuItems,
  },
};

export default markdownPlugin;
