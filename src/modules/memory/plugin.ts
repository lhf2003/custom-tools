import { BrainCircuit } from 'lucide-react';
import type { ViewPlugin } from '@/plugins/types';

/**
 * 知识索引插件（2026-09-02 裁决：记忆检索从启动器内嵌列表抽离为独立插件）。
 * `s ` 前缀 trigger：s + 空格 + 查询词直达本页并预填（旧 `s ` 内嵌列表已退役）。
 */
const memoryPlugin: ViewPlugin = {
  kind: 'view',
  id: 'memory',
  name: '记忆检索',
  icon: BrainCircuit,
  aliases: ['memory', 'jiyi', 'sousuo', 'zhishi', 'recall', 'search'],
  description:
    '语义检索你的个人记忆：浏览过的网页、视频字幕、笔记与剪贴板。支持来源聚合卡片与时间段直达。',
  order: 7,
  triggers: [{ keyword: 's ', argHint: '记忆检索关键词' }],
  load: () => import('./MemoryView').then((m) => ({ default: m.MemoryView })),
  nav: {
    title: '记忆检索',
  },
};

export default memoryPlugin;
