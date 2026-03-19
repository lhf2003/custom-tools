import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { MenuItem } from '@/types';

interface ActionMenuProps {
  items: MenuItem[];
}

export function ActionMenu({ items }: ActionMenuProps) {
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

  // Group items by separator
  const groupedItems: (MenuItem | 'separator')[] = [];
  items.forEach((item, index) => {
    if (index > 0 && item.separator) {
      groupedItems.push('separator');
    }
    groupedItems.push(item);
  });

  return (
    <div className="relative z-50">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 ${
          isOpen
            ? 'bg-zinc-600 text-white'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
        }`}
        title="更多操作"
      >
        <MoreHorizontal size={18} />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-2 min-w-[200px] bg-zinc-800/80 border border-white/10 rounded-xl shadow-2xl z-10 py-1.5 animate-in fade-in slide-in-from-top-1 duration-150"
          style={{ WebkitBackdropFilter: 'blur(20px)', backdropFilter: 'blur(20px)' }}>
          {groupedItems.map((item, index) => {
            if (item === 'separator') {
              return (
                <div
                  key={`sep-${index}`}
                  className="my-1.5 border-t border-zinc-700/50"
                />
              );
            }

            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
                className={`w-full px-3 py-2 flex items-center justify-between text-sm transition-colors ${
                  item.disabled
                    ? 'text-zinc-600 cursor-not-allowed'
                    : item.danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-zinc-300 hover:bg-zinc-700/50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {Icon && <Icon size={16} />}
                  <span>{item.label}</span>
                </div>
                {item.shortcut && (
                  <kbd className="text-xs text-zinc-500 font-mono">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
