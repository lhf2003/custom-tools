// 移除了 @tauri-apps/api/window，因为我们直接交给系统底层处理
import { ArrowLeft } from 'lucide-react';
import { ActionMenu } from './ActionMenu';
import { Tooltip } from './Tooltip';
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
          className="h-12 bg-app-bg-primary/50 border-b border-app-border flex items-center pl-0 pr-4 shrink-0 relative select-none"
          data-tauri-drag-region
      >
        {/* Left: Back button - no-drag 确保按钮可点击 */}
        <div className="flex items-stretch self-stretch" style={{ 'app-region': 'no-drag' } as React.CSSProperties}>
          <Tooltip content="返回主页 (Esc)" placement="bottom">
            <button
                onClick={onBack}
                className="flex items-center justify-center w-10 self-stretch text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-all duration-200 cursor-pointer"
            >
              <ArrowLeft size={16} />
            </button>
          </Tooltip>
        </div>

        {/* Center: Flexible spacer for drag region */}
        <div className="flex-1 h-full" />

        {/* Title: absolutely centered across entire header, non-interactive */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <h1 className="text-sm font-semibold text-app-text-primary">{title}</h1>
        </div>

        {/* Right: Action menu - no-drag 确保菜单可点击 */}
        <div className="flex items-center gap-1" style={{ 'app-region': 'no-drag' } as React.CSSProperties}>
          <ActionMenu items={menuItems} />
        </div>
      </header>
  );
}