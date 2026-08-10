/**
 * 剪贴板模块共享类型
 */

export interface ClipboardItemData {
  id: number;
  content: string;
  content_type: string;
  source_app: string | null;
  source_exe: string | null;
  is_favorite: boolean;
  created_at: string;
}

export interface ClipboardQuery {
  content_type?: string;
  is_favorite?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export type TabType = 'all' | 'text' | 'image' | 'audio' | 'video' | 'file' | 'favorite';
