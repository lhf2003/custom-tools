import { Modal } from './Modal';
import { THEME } from '@/constants/theme';
import type { NoteItemData } from '../types';

interface DeleteConfirmDialogProps {
  item: NoteItemData;
  noteCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({ item, noteCount, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const displayName = item.name.replace(/\.md$/, '');

  return (
    <Modal onClose={onCancel}>
      <h3 className="font-medium mb-4" style={{ color: THEME.TEXT_PRIMARY }}>
        删除{item.is_folder ? '文件夹' : '笔记'}
      </h3>
      <p className="text-sm mb-1" style={{ color: THEME.TEXT_SECONDARY }}>
        {item.is_folder
          ? `「${displayName}」及其中的 ${noteCount} 篇笔记将被删除。`
          : `「${displayName}」将被删除。`}
      </p>
      <p className="text-xs mb-4" style={{ color: THEME.TEXT_TERTIARY }}>
        此操作无法撤销。
      </p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg transition-colors cursor-pointer hover:bg-white/10"
          style={{ color: THEME.TEXT_TERTIARY }}
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          className="px-4 py-2 rounded-lg transition-all cursor-pointer hover:brightness-110"
          style={{ backgroundColor: THEME.ERROR, color: '#ffffff' }}
        >
          删除
        </button>
      </div>
    </Modal>
  );
}
