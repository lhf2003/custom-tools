/**
 * 左栏紧凑条目：类型图标 + 单行预览 + 时间/收藏子行
 * 选中铺 Scrim White 10（DESIGN.md 列表选中规则）
 */
import { forwardRef } from 'react';
import { Link2, Star } from 'lucide-react';
import type { ClipboardItemData } from './types';
import { detectTextKind, getTypeConfig, formatTime, displayName } from './utils';
import { useFavicon } from './useFavicon';

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
    // 整链文本：类型图标换成站点 favicon，加载中/抓取失败回退通用链接图标
    const isLink = item.content_type === 'text' && detectTextKind(item.content) === 'link';
    const favicon = useFavicon(isLink ? item.content.trim() : null);

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
        {isLink ? (
          favicon ? (
            <img src={favicon} alt="" className="w-[15px] h-[15px] rounded-sm shrink-0" />
          ) : (
            <Link2 size={15} className="text-[#60a5fa] shrink-0" />
          )
        ) : (
          <Icon size={15} className={`${config.iconClass} shrink-0`} />
        )}
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
