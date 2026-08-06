import { useEffect, useRef } from 'react';

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
      className="min-w-[160px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-2xl p-1.5 animate-in fade-in duration-150"
      style={{
        ...getMenuStyle(),
        WebkitBackdropFilter: 'blur(20px)',
        backdropFilter: 'blur(20px)',
      }}
    >
      {items.map((item, index) => (
        <div key={item.id}>
          {item.separator && index > 0 && (
            <div className="my-1.5 border-t border-app-border-subtle" />
          )}
          <button
            onClick={() => handleItemClick(item)}
            className={`w-full px-3 py-2 flex items-center gap-2.5 rounded-lg text-sm transition-colors duration-150 ease-out ${
              item.danger
                ? 'text-app-status-error hover:bg-app-status-error/10'
                : 'text-app-text-secondary hover:bg-app-bg-hover hover:text-app-text-primary'
            }`}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
