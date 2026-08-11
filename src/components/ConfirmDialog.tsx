import { useEffect, useRef } from 'react';
import { useConfirmStore, settleConfirm } from '@/stores/confirmStore';

/**
 * 全局确认弹窗宿主（App 根挂载一份）。
 * 样式遵循设置页弹窗范式：玻璃面板 + token 色彩 + danger 红色确认钮；
 * ESC / 遮罩点击 = 取消，打开时聚焦确认按钮（Enter 即确认）。
 */
export function ConfirmDialogHost() {
  const request = useConfirmStore((s) => s.request);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settleConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    confirmRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;

  const {
    title = '操作确认',
    message,
    detail,
    confirmLabel = '确认',
    cancelLabel = '取消',
    danger = false,
  } = request;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleConfirm(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-[380px] bg-app-bg-tertiary border border-app-border rounded-xl shadow-2xl p-5 animate-in fade-in duration-100">
        <h3 className="text-sm font-semibold text-app-text-primary mb-2">{title}</h3>
        <div className="text-xs text-app-text-tertiary leading-relaxed whitespace-pre-line">
          {message}
        </div>
        {detail && (
          <p className="text-xs text-app-text-disabled leading-relaxed mt-1 whitespace-pre-line">
            {detail}
          </p>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={() => settleConfirm(false)}
            className="px-3 py-1.5 rounded-lg text-sm text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-elevated/50 transition-colors cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={() => settleConfirm(true)}
            className={`px-3 py-1.5 rounded-lg text-sm text-white transition-colors cursor-pointer ${
              danger
                ? 'bg-app-status-error hover:brightness-110'
                : 'bg-app-status-info hover:brightness-110'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
