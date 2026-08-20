import { ListTodo } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';
import { useMemoMenuItems } from './useMemoMenuItems';

const memoPlugin: ViewPlugin = {
  kind: 'view',
  id: 'memo',
  name: '备忘',
  icon: ListTodo,
  aliases: ['memo', 'memos', 'beiwang', 'bw', 'todo', '备忘'],
  description:
    '随手记与待办打理：启动器输入「记 + 内容」快速记录，按日期分组查看，勾选完成或忽略，随陪伴日报沉淀。',
  order: 4,
  essential: true,
  shortcutModuleId: 'memo',
  triggers: [{ keyword: '@memo', argHint: '备忘内容' }],
  load: () => import('./MemoView').then((m) => ({ default: m.MemoView })),
  nav: {
    title: '备忘',
    useMenuItems: useMemoMenuItems,
  },
};

export default memoPlugin;
