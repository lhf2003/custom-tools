import { useEffect, useRef } from 'react';
import { FolderPlus, FilePlus, Edit3, Trash2, FolderOpen } from 'lucide-react';
import { THEME } from '@/constants/theme';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  items: MenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay to avoid immediate close on right-click
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('contextmenu', handleClickOutside);
    }, 100);

    document.addEventListener('keydown', handleEscape);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('contextmenu', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Calculate menu position to stay within viewport
  const getMenuStyle = (): React.CSSProperties => {
    if (!menuRef.current) {
      return {
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 1000,
      };
    }

    const menuRect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = position.x;
    let y = position.y;

    // Adjust if menu goes beyond right edge
    if (x + menuRect.width > viewportWidth) {
      x = viewportWidth - menuRect.width - 8;
    }

    // Adjust if menu goes beyond bottom edge
    if (y + menuRect.height > viewportHeight) {
      y = viewportHeight - menuRect.height - 8;
    }

    return {
      position: 'fixed',
      left: Math.max(8, x),
      top: Math.max(8, y),
      zIndex: 1000,
    };
  };

  const handleItemClick = (item: MenuItem) => {
    item.onClick();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="py-1 rounded-lg shadow-lg min-w-[160px]"
      style={{
        ...getMenuStyle(),
        backgroundColor: THEME.BG_SECONDARY,
        border: `1px solid ${THEME.BORDER_DEFAULT}`,
      }}
    >
      {items.map((item, index) => (
        <div key={item.id}>
          {item.separator && index > 0 && (
            <div
              className="my-1 mx-2 h-px"
              style={{ backgroundColor: THEME.BORDER_DEFAULT }}
            />
          )}
          <button
            onClick={() => handleItemClick(item)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer"
            style={{
              color: item.danger ? THEME.ERROR : THEME.TEXT_SECONDARY,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = item.danger
                ? 'rgba(239, 68, 68, 0.1)'
                : 'rgba(63, 63, 70, 0.5)';
              if (item.danger) {
                e.currentTarget.style.color = THEME.ERROR;
              } else {
                e.currentTarget.style.color = THEME.TEXT_PRIMARY;
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = item.danger
                ? THEME.ERROR
                : THEME.TEXT_SECONDARY;
            }}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

// Predefined menu item icons
export const MenuIcons = {
  newNote: <FilePlus size={14} />,
  newFolder: <FolderPlus size={14} />,
  rename: <Edit3 size={14} />,
  delete: <Trash2 size={14} />,
  openLocation: <FolderOpen size={14} />,
};
