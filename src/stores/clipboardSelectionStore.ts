import { create } from 'zustand';

/**
 * 剪贴板选中项对 TopNavigationBar 动作菜单的可见状态。
 * ClipboardView 写入（选中项变化时同步），App.tsx 菜单配置消费
 * （决定 复制/收藏/删除 的 disabled 与 收藏/取消收藏 文案）。
 */
interface ClipboardSelectionState {
  hasSelection: boolean;
  isFavorite: boolean;
  /** 选中项是图片（image 类型，或路径指向图片的文件类型），控制「在资源管理器中打开」菜单项 */
  isImage: boolean;
  /** 选中项是纯文本（text 类型），控制「转为备忘」菜单项（图片/文件路径列表转备忘无意义） */
  isText: boolean;
  setSelection: (selection: { hasSelection: boolean; isFavorite: boolean; isImage: boolean; isText: boolean }) => void;
}

export const useClipboardSelectionStore = create<ClipboardSelectionState>((set) => ({
  hasSelection: false,
  isFavorite: false,
  isImage: false,
  isText: false,
  setSelection: (selection) => set(selection),
}));
