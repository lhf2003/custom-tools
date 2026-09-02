import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ImageOff } from 'lucide-react';
import type { MemoryHit } from './types';
import type { AggregatedSource } from './aggregation';
import { segmentSeconds } from './aggregation';
import { SOURCE_META, sourceIcon, sourceTitle, modalityBadge } from './sourceMeta';
import { Favicon } from './Favicon';

/**
 * 来源卡片分发器（P2 富媒体皮肤）：
 * - VideoCard：时间段 chips（前 4 个，超出内联展开），chips 点击 ?t= 直达分段
 * - ImageCard：剪贴板图本地预览（convertFileSrc）/ 网页图 favicon 锚点
 * - TextCard：网页/笔记/剪贴板文本/memory_fact（网页源带 favicon）
 */
export function SourceCard({
  source,
  onOpenHit,
}: {
  source: AggregatedSource;
  onOpenHit: (hit: MemoryHit) => void;
}) {
  if (source.modality === 'video') return <VideoCard source={source} onOpenHit={onOpenHit} />;
  if (source.modality === 'image') return <ImageCard source={source} onOpenHit={onOpenHit} />;
  return <TextCard source={source} onOpenHit={onOpenHit} />;
}

/** 卡片共享壳：头部（图标+来源标签+模态徽标+域名）+ 中部 + 底部（命中角标+日期） */
function CardShell({
  source,
  onOpen,
  children,
  faviconLead = false,
}: {
  source: AggregatedSource;
  onOpen: () => void;
  children: React.ReactNode;
  /** 头部用 Favicon 领头（网页类来源）；否则用来源图标 */
  faviconLead?: boolean;
}) {
  const meta = SOURCE_META[source.source] ?? SOURCE_META.clipboard;
  return (
    <button
      onClick={onOpen}
      className="flex flex-col gap-1.5 p-3 rounded-xl text-left bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-colors cursor-pointer group w-full"
    >
      <div className="flex items-center gap-1.5 text-app-text-tertiary">
        {faviconLead ? (
          <Favicon domain={source.domain} />
        ) : (
          sourceIcon(source, 'w-3.5 h-3.5 flex-shrink-0')
        )}
        <span className="text-xs">{meta.label}</span>
        {modalityBadge(source)}
        {source.domain && (
          <span className="text-xs text-app-text-tertiary/60 truncate ml-auto">
            {source.domain}
          </span>
        )}
      </div>
      {children}
      <div className="flex items-center gap-2 mt-auto pt-1 text-xs text-app-text-tertiary/70">
        {source.hits.length > 1 && (
          <span className="px-1.5 py-0.5 rounded bg-white/5 text-app-text-tertiary">
            {source.hits.length} 处命中
          </span>
        )}
        <span className="ml-auto">{source.lastIndexedAt.slice(0, 10)}</span>
      </div>
    </button>
  );
}

/** 文本卡：网页（favicon 领头）/ 笔记 / 剪贴板文本 / 记忆事实 */
function TextCard({
  source,
  onOpenHit,
}: {
  source: AggregatedSource;
  onOpenHit: (hit: MemoryHit) => void;
}) {
  const topHit = source.hits[0];
  const isWeb = source.source === 'browser' || source.source === 'subtitle';
  return (
    <CardShell
      source={source}
      onOpen={() => onOpenHit(topHit)}
      faviconLead={isWeb}
    >
      <h4 className="text-sm font-medium text-app-text-primary line-clamp-2 leading-snug break-all">
        {sourceTitle(source)}
      </h4>
      {topHit && (
        <p className="text-xs text-app-text-tertiary line-clamp-3 leading-relaxed break-all">
          {topHit.snippet.replace(/\s+/g, ' ')}
        </p>
      )}
    </CardShell>
  );
}

/** 秒 → m:ss / h:mm:ss */
function fmtSec(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** 视频卡：时间段 chips 按时间线排列（区分度的核心），点击直达分段；超出 4 个内联展开 */
function VideoCard({
  source,
  onOpenHit,
}: {
  source: AggregatedSource;
  onOpenHit: (hit: MemoryHit) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // 分段 chips：url ?t= 秒数解析（不受 snippet 120 字符截断影响），按时间线排序
  const segments = source.hits
    .map((hit) => ({ hit, sec: segmentSeconds(hit.url) }))
    .filter((s): s is { hit: MemoryHit; sec: number } => s.sec !== null)
    .sort((a, b) => a.sec - b.sec);
  const visible = expanded ? segments : segments.slice(0, 4);

  return (
    <CardShell source={source} onOpen={() => onOpenHit(source.hits[0])} faviconLead>
      <h4 className="text-sm font-medium text-app-text-primary line-clamp-2 leading-snug break-all">
        {sourceTitle(source)}
      </h4>
      {segments.length > 0 && (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {visible.map(({ hit, sec }) => (
            <span
              key={hit.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenHit(hit)}
              onKeyDown={(e) => e.key === 'Enter' && onOpenHit(hit)}
              title={`跳转到 ${fmtSec(sec)}`}
              className="px-1.5 py-0.5 rounded bg-white/5 text-xs text-app-text-tertiary hover:bg-app-brand-primary/20 hover:text-app-brand-primary-light transition-colors cursor-pointer"
            >
              {/* 画面段采集固定 10s 窗（memory-host fmt_secs 同款），显示完整区间 */}
              {fmtSec(sec)}-{fmtSec(sec + 10)}
            </span>
          ))}
          {segments.length > 4 && (
            <span
              role="button"
              tabIndex={0}
              onClick={() => setExpanded((v) => !v)}
              onKeyDown={(e) => e.key === 'Enter' && setExpanded((v) => !v)}
              className="px-1.5 py-0.5 rounded text-xs text-app-text-tertiary/70 hover:text-app-text-primary transition-colors cursor-pointer"
            >
              {expanded ? '收起' : `+${segments.length - 4} 段`}
            </span>
          )}
        </div>
      )}
    </CardShell>
  );
}

/** 图片卡：剪贴板图本地路径真预览；网页图 favicon 锚点（原图回源，看真图点卡片回原页） */
function ImageCard({
  source,
  onOpenHit,
}: {
  source: AggregatedSource;
  onOpenHit: (hit: MemoryHit) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const topHit = source.hits[0];
  const imagePath = topHit?.image_path ?? null;
  // 剪贴板图片有本地路径才渲染预览；网页主图（browser）与路径失效走锚点形态
  const showPreview = source.source === 'clipboard' && imagePath && !imgFailed;

  return (
    <CardShell source={source} onOpen={() => onOpenHit(topHit)} faviconLead={!showPreview}>
      {showPreview ? (
        <img
          src={convertFileSrc(imagePath)}
          alt={sourceTitle(source)}
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="w-full h-28 object-cover rounded-lg bg-white/5"
        />
      ) : (
        <div className="w-full h-28 rounded-lg bg-white/5 flex items-center justify-center">
          {source.source === 'clipboard' ? (
            <ImageOff className="w-6 h-6 text-app-text-tertiary/40" />
          ) : (
            <Favicon domain={source.domain} className="w-8 h-8 text-base" />
          )}
        </div>
      )}
      <h4 className="text-sm font-medium text-app-text-primary line-clamp-2 leading-snug break-all">
        {sourceTitle(source)}
      </h4>
    </CardShell>
  );
}
