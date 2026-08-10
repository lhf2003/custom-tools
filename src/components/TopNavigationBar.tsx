// 移除了 @tauri-apps/api/window，因为我们直接交给系统底层处理
import { ArrowLeft } from 'lucide-react';
import { ActionMenu } from './ActionMenu';
import { Tooltip } from './Tooltip';
import type { MenuItem } from '@/types';

/** 导航栏右侧的主操作（Raycast 式：主动作外露 + 其余收进动作菜单） */
export interface PrimaryAction {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

interface TopNavigationBarProps {
  title: string;
  menuItems: MenuItem[];
  onBack: () => void;
  primaryAction?: PrimaryAction;
  /** 动作菜单入口的文字标签（不传则为三点图标） */
  menuLabel?: string;
}

export function TopNavigationBar({
                                   title,
                                   menuItems,
                                   onBack,
                                   primaryAction,
                                   menuLabel,
                                 }: TopNavigationBarProps) {
  return (
      <header
          className="h-12 panel-glass border-b border-app-border flex items-center pl-0 pr-4 shrink-0 relative select-none"
          data-tauri-drag-region
      >
        {/* Left: Back button - no-drag 确保按钮可点击 */}
        <div className="flex items-center pl-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Tooltip content="返回主页 (Esc)" placement="bottom">
            <button
                onClick={onBack}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {/* Center: Flexible spacer for drag region */}
        <div className="flex-1 h-full" />

        {/* Title: absolutely centered across entire header, non-interactive */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <h1 className="text-sm font-semibold text-app-text-primary">{title}</h1>
        </div>

        {/* Right: Primary action + Action menu - no-drag 确保可点击 */}
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {primaryAction && (
            <button
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-app-text-secondary"
            >
              {primaryAction.label}
              {primaryAction.shortcut && (
                <kbd className="min-w-[18px] px-1 py-px text-center rounded border border-white/10 bg-white/5 text-[10px] font-medium text-app-text-tertiary">
                  {primaryAction.shortcut}
                </kbd>
              )}
            </button>
          )}
          <ActionMenu items={menuItems} label={menuLabel} />
        </div>
      </header>
  );
}
