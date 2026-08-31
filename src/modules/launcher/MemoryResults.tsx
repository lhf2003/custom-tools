/**
 * MemoryResults — 记忆检索结果呈现（D5: C 分组 + `s ` 前缀全量模式）
 *
 * MemoryStrip: 查询态下方 2-3 条「你可能在找」分组，异步流入，不抢应用结果。
 * MemoryList:  `s ` 前缀独占全量语义检索视图。
 */
import { Globe, Subtitles, FileText, ClipboardList, Brain, Image as ImageIcon, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';

export interface MemoryHit {
  id: number;
  source: string;
  title: string | null;
  url: string | null;
  domain: string | null;
  snippet: string;
  score: number;
  modality: string;
  created_at: string | null;
  indexed_at: string;
}

const SOURCE_META: Record<string, { label: string; Icon: typeof Globe }> = {
  browser: { label: '浏览', Icon: Globe },
  subtitle: { label: '字幕', Icon: Subtitles },
  note: { label: '笔记', Icon: FileText },
  clipboard: { label: '剪贴板', Icon: ClipboardList },
  memory_fact: { label: '记忆', Icon: Brain },
};

export function memoryHitTitle(hit: MemoryHit): string {
  if (hit.title) return hit.title;
  if (hit.domain) return hit.domain;
  return hit.snippet.slice(0, 30);
}

function MemoryRow({
  hit,
  isSelected,
  onClick,
  onHover,
  id,
}: {
  hit: MemoryHit;
  isSelected: boolean;
  onClick: () => void;
  onHover?: () => void;
  id?: string;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const meta = SOURCE_META[hit.source] ?? SOURCE_META.clipboard;

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected]);

  return (
    <button
      ref={rowRef}
      id={id}
      onClick={onClick}
      onMouseEnter={onHover}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      className={`flex items-center gap-2 px-3 py-1 rounded-lg transition-colors group text-left w-full ${isSelected ? 'bg-white/10' : ''}`}
    >
      <span className="flex items-center gap-1 flex-shrink-0 text-app-text-tertiary">
        <meta.Icon className="w-3.5 h-3.5" />
        <span className="text-xs">{meta.label}</span>
        {hit.modality === 'image' && <ImageIcon className="w-3 h-3 text-app-text-tertiary/60" />}
        {hit.modality === 'video' && <Play className="w-3 h-3 text-app-text-tertiary/60" />}
      </span>
      <span
        className={`truncate text-sm transition-colors ${isSelected ? 'text-app-text-primary font-medium' : 'text-app-text-secondary group-hover:text-app-text-primary'}`}
        style={{ maxWidth: '38%' }}
      >
        {memoryHitTitle(hit)}
      </span>
      <span className="flex-1 min-w-0 truncate text-xs text-app-text-tertiary">
        {hit.snippet.replace(/\s+/g, ' ')}
      </span>
      {isSelected && (
        <span className="text-xs text-app-text-tertiary flex-shrink-0">↵ 打开</span>
      )}
    </button>
  );
}

/** C 分组：查询态应用结果下方的记忆条（≤3 条），独立选中态（↓ 溢出进入） */
export function MemoryStrip({
  hits,
  selectedIndex,
  onOpen,
  onHover,
}: {
  hits: MemoryHit[];
  selectedIndex: number;
  onOpen: (hit: MemoryHit) => void;
  onHover: (index: number) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <section className="mt-2 pt-2 border-t border-white/5" aria-label="记忆检索">
      <h3 className="text-xs text-app-text-tertiary mb-1 px-1">记忆 · 你可能在找</h3>
      <div className="flex flex-col gap-0.5" role="listbox" aria-label="记忆检索结果">
        {hits.slice(0, 3).map((hit, i) => (
          <MemoryRow
            key={hit.id}
            hit={hit}
            isSelected={i === selectedIndex}
            onClick={() => onOpen(hit)}
            onHover={() => onHover(i)}
          />
        ))}
      </div>
    </section>
  );
}

/** `s ` 前缀全量语义检索视图 */
export function MemoryList({
  hits,
  selectedIndex,
  onOpen,
  onHover,
}: {
  hits: MemoryHit[];
  selectedIndex: number;
  onOpen: (hit: MemoryHit) => void;
  onHover: (index: number) => void;
}) {
  if (hits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-app-text-tertiary">
        没有在记忆里找到相关内容（浏览 10 秒以上的页面才会被索引）
      </div>
    );
  }
  return (
    <section className="h-full flex flex-col" aria-label="记忆检索">
      <h3 className="text-sm font-semibold text-app-text-tertiary mb-2">记忆检索</h3>
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-0.5" role="listbox">
        {hits.map((hit, i) => (
          <MemoryRow
            key={hit.id}
            id={`launcher-option-${i}`}
            hit={hit}
            isSelected={i === selectedIndex}
            onClick={() => onOpen(hit)}
            onHover={() => onHover(i)}
          />
        ))}
      </div>
    </section>
  );
}
