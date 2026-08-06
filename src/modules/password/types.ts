export interface PasswordCategory {
  id: number;
  name: string;
  icon: string;
  color: string;
}

export interface PasswordEntry {
  id: number;
  title: string;
  username: string | null;
  password: string;
  url: string | null;
  notes: string | null;
  category_id: number | null;
  favorite: boolean;
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
