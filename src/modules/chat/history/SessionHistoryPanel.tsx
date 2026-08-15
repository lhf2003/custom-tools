import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { formatRelativeTime, previewText, type ChatSessionSummary } from '../sessionUtils';

interface SessionHistoryPanelProps {
  loading: boolean;
  sessions: ChatSessionSummary[];
  currentSessionId: number | null;
  top: number;
  right: number;
  /** 面板外的锚点（历史按钮）：点它不触发外点关闭（其 click 会走开合切换） */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSwitch: (id: number) => void;
  /** 两态确认后的最终删除 */
  onDelete: (id: number) => void;
}

/** 会话历史浮层（fixed 定位，不受布局裁剪影响）：键盘导航 + 两态删除确认 + 入场动效 */
export function SessionHistoryPanel({
  loading,
  sessions,
  currentSessionId,
  top,
  right,
  anchorRef,
  onClose,
  onSwitch,
  onDelete,
}: SessionHistoryPanelProps) {
  // 入场动效（reduced-motion 由 motion-reduce 变体降级）
  const [visible, setVisible] = useState(false);
  const [idx, setIdx] = useState(0);
  // 会话删除两态确认：armed 后 3s 未确认自动复位
  const [armedId, setArmedId] = useState<number | null>(null);
  const armedTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 卸载清理两态确认定时器（防卸载后 setState 与资源滞留）
  useEffect(() => {
    return () => {
      if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current);
    };
  }, []);

  // 打开后聚焦面板以接收键盘导航
  useEffect(() => {
    if (!loading) panelRef.current?.focus();
  }, [loading]);

  // 点击浮层外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, anchorRef]);

  // 键盘导航时保持高亮条目可见
  useEffect(() => {
    const el = panelRef.current?.querySelectorAll('li')[idx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const confirmDelete = useCallback(
    (id: number) => {
      if (armedId === id) {
        if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current);
        setArmedId(null);
        onDelete(id);
        return;
      }
      // 第一次点击进入 armed（按钮变红勾），3s 未确认自动复位
      setArmedId(id);
      if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = window.setTimeout(() => {
        setArmedId((cur) => (cur === id ? null : cur));
      }, 3000);
    },
    [armedId, onDelete],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (sessions.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, sessions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const s = sessions[idx];
        if (s) onSwitch(s.id);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const s = sessions[idx];
        if (s) confirmDelete(s.id);
      }
    },
    [sessions, idx, onSwitch, confirmDelete, onClose],
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="listbox"
      aria-label="会话历史"
      onKeyDown={handleKeyDown}
      className={`fixed z-50 w-80 max-h-80 overflow-y-auto rounded-xl border border-app-border bg-app-bg-primary/80 shadow-lg outline-none transition-all duration-150 ease-out motion-reduce:transition-none ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
      }`}
      style={{
        top,
        right,
        WebkitBackdropFilter: 'blur(20px)',
        backdropFilter: 'blur(20px)',
      }}
    >
      {loading ? (
        <div className="p-3 space-y-2">
          <div className="h-4 rounded bg-zinc-700/60 animate-pulse" />
          <div className="h-4 rounded bg-zinc-700/40 animate-pulse w-3/4" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-app-text-tertiary">
          暂无过往会话
        </div>
      ) : (
        <ul className="p-1.5">
          {sessions.map((s, i) => (
            <li key={s.id}>
              <div
                role="button"
                tabIndex={-1}
                onClick={() => onSwitch(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSwitch(s.id);
                  }
                }}
                onMouseEnter={() => setIdx(i)}
                className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-150 ease-out ${
                  i === idx ? 'bg-app-bg-hover' : ''
                }`}
              >
                {s.id === currentSessionId && (
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                )}
                <span className="flex-1 truncate text-xs text-zinc-300">
                  {previewText(s.preview)}
                </span>
                {/* 相对时间 hover 时淡出让位删除钮（opacity 过渡，不引起布局跳动） */}
                <span className="shrink-0 text-[10px] text-app-text-tertiary transition-opacity group-hover:opacity-0">
                  {formatRelativeTime(s.updated_at)}
                </span>
                {/* 删除：键盘高亮行（idx）常显，鼠标 hover 显示；两态确认防误触 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmDelete(s.id);
                  }}
                  className={`absolute right-2 w-5 h-5 items-center justify-center rounded transition-all cursor-pointer ${
                    armedId === s.id
                      ? 'flex text-red-400 hover:bg-white/10'
                      : i === idx
                        ? 'flex text-zinc-400 hover:text-red-400 hover:bg-white/10'
                        : 'hidden group-hover:flex text-zinc-500 hover:text-red-400 hover:bg-white/10'
                  }`}
                  aria-label={armedId === s.id ? '确认删除会话' : '删除会话'}
                  tabIndex={-1}
                >
                  {armedId === s.id ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
