import { Clipboard, FileText, Lock, Settings } from 'lucide-react';
import type { Tool } from '@/types';

export const tools: Tool[] = [
  { id: 'clipboard', icon: Clipboard, label: '剪贴板', color: 'from-blue-500 to-cyan-500' },
  { id: 'markdown', icon: FileText, label: '笔记', color: 'from-purple-500 to-pink-500' },
  { id: 'password', icon: Lock, label: '密码', color: 'from-green-500 to-emerald-500' },
  { id: 'settings', icon: Settings, label: '设置', color: 'from-gray-500 to-slate-500' },
];

export { Clipboard, FileText, Lock, Settings };
