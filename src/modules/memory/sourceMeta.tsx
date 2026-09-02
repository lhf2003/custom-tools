import { Globe, Subtitles, FileText, ClipboardList, Brain, Image as ImageIcon, Play } from 'lucide-react';
import type { MemoryHit } from './types';
import type { AggregatedSource } from './aggregation';

/** 来源元信息（图标 + 中文标签），知识页卡片与启动器条目共用 */
export const SOURCE_META: Record<string, { label: string; Icon: typeof Globe }> = {
  browser: { label: '浏览', Icon: Globe },
  subtitle: { label: '字幕', Icon: Subtitles },
  note: { label: '笔记', Icon: FileText },
  clipboard: { label: '剪贴板', Icon: ClipboardList },
  memory_fact: { label: '记忆', Icon: Brain },
};

/** B 站小电视（stroke 风格对齐 lucide；品牌蓝 #00A1D6 提升来源识别度） */
export function BiliIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#00A1D6"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-label="哔哩哔哩"
    >
      <path d="M7.5 3.5 10 6.5M16.5 3.5 14 6.5" />
      <rect x="3" y="6.5" width="18" height="13.5" rx="3.5" />
      <path d="M9.5 11.5v4M14.5 11.5v4" />
    </svg>
  );
}

export function isBiliDomain(domain: string | null): boolean {
  return domain === 'bilibili.com' || !!domain?.endsWith('.bilibili.com');
}

export function sourceIcon(source: AggregatedSource, className: string) {
  if (isBiliDomain(source.domain)) return <BiliIcon className={className} />;
  const meta = SOURCE_META[source.source] ?? SOURCE_META.clipboard;
  return <meta.Icon className={className} />;
}

/** 卡片标题：标题 > 域名 > 摘要截断（与旧 memoryHitTitle 同语义） */
export function sourceTitle(source: AggregatedSource): string {
  if (source.title) return source.title;
  if (source.domain) return source.domain;
  return source.hits[0]?.snippet.slice(0, 30) ?? '';
}

export function modalityBadge(source: AggregatedSource) {
  if (source.modality === 'image') return <ImageIcon className="w-3 h-3" />;
  if (source.modality === 'video') return <Play className="w-3 h-3" />;
  return null;
}
