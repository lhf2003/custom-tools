// Constants for markdown notes module

import type { HighlightColor } from './types';

// Highlight colors for text background
export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: '黄色', color: '#fef3c7', text: '#92400e' },
  { name: '绿色', color: '#d1fae5', text: '#065f46' },
  { name: '蓝色', color: '#dbeafe', text: '#1e40af' },
  { name: '粉色', color: '#fce7f3', text: '#9d174d' },
  { name: '紫色', color: '#e9d5ff', text: '#6b21a8' },
  { name: '橙色', color: '#ffedd5', text: '#9a3412' },
  { name: '灰色', color: '#f3f4f6', text: '#374151' },
];

// Auto-save delay in milliseconds
export const AUTO_SAVE_DELAY = 1000;

// Window height for markdown view
export const MARKDOWN_WINDOW_HEIGHT = 600;
