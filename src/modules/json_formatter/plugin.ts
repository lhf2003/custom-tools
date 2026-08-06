import { Braces } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';

const jsonFormatterPlugin: ViewPlugin = {
  kind: 'view',
  id: 'json_formatter',
  name: 'JSON格式化',
  icon: Braces,
  aliases: ['json', 'format', 'jq'],
  description:
    '本地格式化与校验 JSON 数据，树形视图折叠/展开，语法错误定位到行与列，支持复制结果或导出为图片。',
  order: 1,
  triggers: [{ keyword: '@json', argHint: 'JSON 文本' }],
  load: () => import('./JsonFormatterView').then((m) => ({ default: m.JsonFormatterView })),
  nav: {
    title: 'JSON 格式化',
  },
};

export default jsonFormatterPlugin;
