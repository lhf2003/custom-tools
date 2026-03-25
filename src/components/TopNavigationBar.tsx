// 移除了 @tauri-apps/api/window，因为我们直接交给系统底层处理
import { ArrowLeft } from 'lucide-react';
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
      <header
          className="h-12 bg-zinc-800/50 border-b border-white/15 flex items-center pl-0 pr-4 shrink-0 relative select-none"
          data-tauri-drag-region
      >
        {/* Left: Back button - no-drag 确保按钮可点击 */}
        <div className="flex items-stretch self-stretch" style={{ 'app-region': 'no-drag' } as React.CSSProperties}>
          <button
              onClick={onBack}
              className="flex items-center justify-center w-10 self-stretch text-zinc-300 hover:text-white hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
              title="返回主页 (Esc)"
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        {/* Center: Flexible spacer for drag region */}
        <div className="flex-1 h-full" />

        {/* Title: absolutely centered across entire header, non-interactive */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <h1 className="text-sm font-semibold text-zinc-200">{title}</h1>
        </div>

        {/* Right: Action menu - no-drag 确保菜单可点击 */}
        <div className="flex items-center gap-1" style={{ 'app-region': 'no-drag' } as React.CSSProperties}>
          <ActionMenu items={menuItems} />
        </div>
      </header>
  );
}