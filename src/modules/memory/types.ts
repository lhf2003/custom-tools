/**
 * 知识索引插件共享类型。
 * MemoryHit 与后端 commands/memory.rs 的 MemoryHitDto 一一对应。
 */
export interface MemoryHit {
  id: number;
  source: string;
  /** 来源关联键（剪贴板 id / 笔记路径等），无 url 来源的聚合分组键 */
  source_ref: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  snippet: string;
  score: number;
  modality: string;
  /** 剪贴板图片的本地文件路径（仅 source=clipboard + modality=image 且文件存在时有值） */
  image_path: string | null;
  created_at: string | null;
  indexed_at: string;
}
