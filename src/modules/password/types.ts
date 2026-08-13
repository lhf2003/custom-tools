export interface PasswordCategory {
  id: number;
  name: string;
  icon: string;
  color: string;
  /** 分类下的条目数（删除确认弹窗展示用） */
  entry_count: number;
}

export interface PasswordEntry {
  id: number;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  category_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface EntryFormData {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  category_id?: number;
}

export const EMPTY_FORM: EntryFormData = {
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
};
