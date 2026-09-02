import type { MemoryHit } from './types';

/**
 * 来源聚合模型（2026-09-02 裁决 3）：一来源一卡。
 * 分组键优先级：基础 url（剥离 ?t=/&t= 段级后缀）> source:source_ref > 单条 id。
 * 组内按 score 降序，组间按 topScore 降序。
 */
export interface AggregatedSource {
  key: string;
  source: string;
  modality: string;
  title: string | null;
  domain: string | null;
  /** 基础 URL（段级后缀已剥离）；无 url 来源为 null */
  url: string | null;
  /** 命中记录，score 降序 */
  hits: MemoryHit[];
  /** 组内最高相似度（组间排序键） */
  topScore: number;
  /** 组内最新 indexed_at */
  lastIndexedAt: string;
}

/** 剥离段级定位后缀（与 store.rs recent_videos 的聚合语义一致） */
export function baseUrl(url: string): string {
  return url.replace(/[?&]t=\d+.*$/, '').replace(/\/$/, '');
}

function groupKey(hit: MemoryHit): string {
  if (hit.url) return `url:${baseUrl(hit.url)}`;
  if (hit.source_ref) return `${hit.source}:${hit.source_ref}`;
  return `${hit.source}#${hit.id}`;
}

function pickTitle(hits: MemoryHit[]): string | null {
  return hits.find((h) => h.title)?.title ?? null;
}

export function aggregateBySource(hits: MemoryHit[]): AggregatedSource[] {
  const groups = new Map<string, MemoryHit[]>();
  for (const hit of hits) {
    const key = groupKey(hit);
    const group = groups.get(key);
    if (group) group.push(hit);
    else groups.set(key, [hit]);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      return {
        key,
        source: top.source,
        modality: top.modality,
        title: pickTitle(sorted),
        domain: top.domain,
        url: top.url ? baseUrl(top.url) : null,
        hits: sorted,
        topScore: top.score,
        lastIndexedAt: sorted.reduce(
          (latest, h) => (h.indexed_at > latest ? h.indexed_at : latest),
          sorted[0].indexed_at,
        ),
      };
    })
    .sort((a, b) => b.topScore - a.topScore);
}

/** 命中探测计数（启动器条目用）：聚合后来源数，与知识页口径一致 */
export function countSources(hits: MemoryHit[]): number {
  return aggregateBySource(hits).length;
}

/** 从 url 的 ?t= 参数解析秒数（视频分段 chips 用；无则 null） */
export function segmentSeconds(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/[?&]t=(\d+)/);
  return m ? Number(m[1]) : null;
}
