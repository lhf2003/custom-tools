import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { Tooltip } from './Tooltip';
import type { MenuItem } from '@/types';

interface ActionMenuProps {
  items: MenuItem[];
  /** 传入时用「文字标签 + 下拉箭头」替代三点图标（Raycast 式动作入口） */
  label?: string;
}

export function ActionMenu({ items, label }: ActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Handle menu item click
  const handleItemClick = (item: MenuItem) => {
    if (!item.disabled) {
      item.onClick();
      setIsOpen(false);
    }
  };

  const trigger = (
    <button
      ref={buttonRef}
      onClick={() => setIsOpen(!isOpen)}
      className={`h-8 rounded-lg flex items-center justify-center transition-all duration-200 ${
        label ? 'px-2.5 gap-1 text-sm' : 'w-8'
      } ${
        isOpen
          ? 'bg-app-bg-pressed text-app-text-primary'
          : 'text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-elevated/50'
      }`}
    >
      {label ? (
        <>
          {label}
          <ChevronDown size={14} />
        </>
      ) : (
        <MoreHorizontal size={18} />
      )}
    </button>
  );

  return (
    <div className="relative z-50">
      {label ? (
        trigger
      ) : (
        <Tooltip content="更多操作" placement="bottom">
          {trigger}
        </Tooltip>
      )}

      {isOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-2 min-w-[220px] bg-app-bg-primary/80 border border-app-border rounded-xl shadow-lg z-10 animate-in fade-in slide-in-from-top-1 duration-150"
          style={{ WebkitBackdropFilter: 'blur(20px)', backdropFilter: 'blur(20px)' }}>
          <MenuPanel items={items} onItemClick={handleItemClick} />
        </div>
      )}
    </div>
  );
}

/** 菜单面板（导航栏下拉与页面右键菜单共用） */
export function MenuPanel({
  items,
  onItemClick,
}: {
  items: MenuItem[];
  onItemClick: (item: MenuItem) => void;
}) {
  // Group items by separator
  const groupedItems: (MenuItem | 'separator')[] = [];
  items.forEach((item, index) => {
    if (index > 0 && item.separator) {
      groupedItems.push('separator');
    }
    groupedItems.push(item);
  });

  return (
    <div className="p-1.5">
      {groupedItems.map((item, index) => {
        if (item === 'separator') {
          return (
            <div
              key={`sep-${index}`}
              className="my-1.5 border-t border-app-border-subtle"
            />
          );
        }

        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onClick={() => onItemClick(item)}
            disabled={item.disabled}
            className={`w-full px-3 py-2 flex items-center justify-between rounded-lg text-sm transition-colors duration-150 ease-out ${
              item.disabled
                ? 'text-app-text-disabled cursor-not-allowed'
                : item.danger
                ? 'text-app-status-error hover:bg-app-status-error/10'
                : 'text-app-text-secondary hover:bg-app-bg-hover hover:text-app-text-primary'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {Icon && <Icon size={16} />}
              <span>{item.label}</span>
            </div>
            {item.shortcut && <ShortcutKeys shortcut={item.shortcut} />}
          </button>
        );
      })}
    </div>
  );
}

/** Raycast 式键帽：shortcut 以 + 分隔组合键，逐键渲染小方帽 */
function ShortcutKeys({ shortcut }: { shortcut: string }) {
  return (
    <span className="flex items-center gap-1 ml-6">
      {shortcut.split('+').map((key) => (
        <kbd
          key={key}
          className="min-w-[18px] px-1 py-px text-center rounded border border-white/10 bg-white/5 text-[10px] font-medium text-app-text-tertiary"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
