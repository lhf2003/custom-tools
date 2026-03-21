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
          className="h-12 bg-zinc-800/50 border-b border-white/15 flex items-center px-4 shrink-0 relative select-none"
      >
        {/* Left: Back button */}
        <div className="flex items-center gap-3 relative z-10">
          <button
              onClick={onBack}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer"
              title="返回主页 (Esc)"
          >
            <ArrowLeft size={18} />
            <span className="text-sm font-medium">返回</span>
          </button>
          <div className="w-px h-5 bg-zinc-700/50" />
        </div>

        {/* Center: Drag region - 使用 data-tauri-drag-region="true" 启用系统级拖拽 */}
        <div
            className="flex-1 h-full cursor-grab active:cursor-grabbing"
            data-tauri-drag-region="true"
        />

        {/* Title: absolutely centered across entire header, non-interactive */}
        {/* 由于它是绝对定位且 pointer-events-none，它不会阻挡下方的拖拽区域 */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <h1 className="text-sm font-semibold text-zinc-200">{title}</h1>
        </div>

        {/* Right: Action menu */}
        <div className="flex items-center gap-1 relative z-10">
          <ActionMenu items={menuItems} />
        </div>
      </header>
  );
}