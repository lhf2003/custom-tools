import { HardDrive } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';

const everythingPlugin: ViewPlugin = {
  kind: 'view',
  id: 'everything',
  name: '文件搜索',
  icon: HardDrive,
  aliases: ['everything', 'file', 'search', 'find'],
  description:
    '集成Everything搜索引擎，毫秒级查找本地文件。支持模糊匹配、快速打开文件所在位置。',
  order: 2,
  shortcutModuleId: 'everything',
  triggers: [{ keyword: '@everything' }],
  load: () => import('./EverythingView').then((m) => ({ default: m.EverythingView })),
  nav: {
    title: '文件搜索',
  },
};

export default everythingPlugin;
