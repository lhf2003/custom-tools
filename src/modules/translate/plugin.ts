import { Languages } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';

const translatePlugin: ViewPlugin = {
  kind: 'view',
  id: 'translate',
  name: '划词翻译',
  icon: Languages,
  aliases: ['translate', '翻译', 'fanyi', '划词', 'yiwen'],
  description:
    '任意应用中选中文本按 Ctrl+Shift+T 即译，或粘贴长文本翻译；自动检测源语言，支持中英日韩等目标语言，流式输出。',
  order: 2,
  load: () => import('./TranslateView').then((m) => ({ default: m.TranslateView })),
  nav: {
    title: '划词翻译',
  },
};

export default translatePlugin;
