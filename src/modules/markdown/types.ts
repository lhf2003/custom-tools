// Types for markdown notes module

export interface NoteItemData {
  id: string;
  name: string;
  path: string;
  is_folder: boolean;
  children?: NoteItemData[];
}

export interface NoteContentData {
  path: string;
  name: string;
  content: string;
  last_modified: number;
}

export interface CreateNoteRequest {
  path: string;
  is_folder: boolean;
}

export interface DragItem {
  item: NoteItemData;
  parentPath: string;
}

export interface HighlightColor {
  name: string;
  color: string;
  text: string;
}
