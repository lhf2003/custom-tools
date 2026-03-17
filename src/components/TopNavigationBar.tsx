import { ArrowLeft, Pin, PinOff } from 'lucide-react';
import { ActionMenu } from './ActionMenu';
import type { MenuItem } from '@/types';

interface TopNavigationBarProps {
  title: string;
  menuItems: MenuItem[];
  alwaysOnTop?: boolean;
  onToggleAlwaysOnTop?: () => void;
  onBack: () => void;
}

export function TopNavigationBar({
  title,
  menuItems,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onBack,
}: TopNavigationBarProps) {
  return (
    <header className="h-12 bg-zinc-800/60 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-4 shrink-0 relative" style={{ WebkitBackdropFilter: 'blur(24px)', backdropFilter: 'blur(24px)' }}>
      {/* Left: Back button and title */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-700/50 transition-all duration-200"
          title="返回主页 (Esc)"
        >
          <ArrowLeft size={18} />
          <span className="text-sm font-medium">返回</span>
        </button>
        <div className="w-px h-5 bg-zinc-700/50" />
        <h1 className="text-sm font-semibold text-zinc-200">{title}</h1>
      </div>

      {/* Right: Action menu */}
      <div className="flex items-center gap-1">
        <ActionMenu items={menuItems} />
      </div>
    </header>
  );
}
