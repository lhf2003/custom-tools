import { ArrowLeft, History } from 'lucide-react';
import { ModelSelector } from './ModelSelector';

interface ChatHeaderProps {
  title: string;
  isLoading: boolean;
  historyOpen: boolean;
  historyBtnRef: React.RefObject<HTMLButtonElement>;
  onBack: () => void;
  onNewSession: () => void;
  onToggleHistory: () => void;
}

/** 顶栏：返回 + 会话标题 + 模型选择/新会话/历史操作组（兼窗口拖拽区） */
export function ChatHeader({
  title,
  isLoading,
  historyOpen,
  historyBtnRef,
  onBack,
  onNewSession,
  onToggleHistory,
}: ChatHeaderProps) {
  return (
    <div className="px-3 py-2 shrink-0 flex items-center gap-2" data-tauri-drag-region>
      <button
        onClick={onBack}
        className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
        aria-label="返回启动器"
        data-tauri-drag-region={undefined}
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      <span className="flex-1 min-w-0 text-sm font-semibold text-zinc-100 truncate">
        {title}
      </span>

      <div className="flex items-center gap-1 shrink-0">
        <ModelSelector />
        {!isLoading && (
          <>
            <button
              onClick={onNewSession}
              className="text-xs px-2 h-7 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="开启新会话"
              data-tauri-drag-region={undefined}
            >
              新会话
            </button>
            <button
              ref={historyBtnRef}
              onClick={onToggleHistory}
              className={`flex items-center w-7 h-7 justify-center rounded-md transition-colors cursor-pointer ${
                historyOpen
                  ? 'text-app-text-primary bg-white/10'
                  : 'text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10'
              }`}
              aria-label="会话历史"
              data-tauri-drag-region={undefined}
            >
              <History className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
