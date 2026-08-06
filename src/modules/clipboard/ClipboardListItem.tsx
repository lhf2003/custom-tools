/**
 * 左栏紧凑条目：类型图标 + 单行预览 + 时间/收藏子行
 * 选中铺 Scrim White 10（DESIGN.md 列表选中规则）
 */
import { forwardRef } from 'react';
import { Star } from 'lucide-react';
import type { ClipboardItemData } from './types';
import { getTypeConfig, formatTime, displayName } from './utils';

interface ClipboardListItemProps {
  item: ClipboardItemData;
  isSelected: boolean;
  onSelect: () => void;
  onPaste: () => void;
  /** 右键时先选中该条目（右键菜单的动作作用于它），事件继续冒泡给视图级菜单 */
  onContextMenu: () => void;
}

export const ClipboardListItem = forwardRef<HTMLDivElement, ClipboardListItemProps>(
  function ClipboardListItem({ item, isSelected, onSelect, onPaste, onContextMenu }, ref) {
    const config = getTypeConfig(item.content_type, item.content);
    const Icon = config.icon;
    const preview = displayName(item.content, item.content_type);

    return (
      <div
        ref={ref}
        onClick={onSelect}
        onDoubleClick={onPaste}
        onContextMenu={onContextMenu}
        className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors duration-150 scroll-mt-10 ${
          isSelected ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
      >
        <Icon size={15} className={`${config.iconClass} shrink-0`} />
        <div className="flex-1 min-w-0">
          <div
            className={`text-sm truncate ${
              isSelected ? 'text-app-text-primary' : 'text-app-text-secondary'
            }`}
          >
            {preview}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-app-text-disabled">
            <span>{formatTime(item.created_at)}</span>
            {item.is_favorite === true && <Star size={10} className="text-yellow-400" fill="currentColor" />}
          </div>
        </div>
      </div>
    );
  }
);
