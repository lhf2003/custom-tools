// 桌面便签窗：pinned 备忘的桌面镜像（可勾选完成）。
// 数据经 invoke 自拉 + memo:changed 事件回流（主视图勾选/钉图钉，这里同步；
// 这里勾选完成，主视图同样同步）——窗口间不直接通信，memos 表是唯一真源。
// 施工规范：透明浮窗禁常驻阴影（只 border 描边）；drag-region 只挂头部把手；
// 滚动条自动显隐 hook 独立窗口各自挂载。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Check, ListTodo, X } from 'lucide-react';
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar';
import { PANEL_ALPHA_CACHE_KEY } from '@/components/ThemeController';

interface Memo {
  id: number;
  content: string;
  status: 'pending' | 'done' | 'dismissed';
  due_date: string | null;
  pinned: boolean;
}

/** 拖拽落点上报节流（tauri://move 高频触发，静止后才落盘） */
const POS_SAVE_DELAY_MS = 500;
/** 卡片边框(1×2) + 外边距 m-1(4×2) + 列表 pb-2：内容高度之外的固定余量 */
const HEIGHT_EXTRA_PX = 2 + 8 + 8;

export function MemoStickyView() {
  const [memos, setMemos] = useState<Memo[]>([]);
  const headerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const lastReportedH = useRef(0);
  useAutoHideScrollbar();

  // 高度随行数自适应：量「头部 + 内容自然高度」上报后端（钳制区间在 Rust），
  // ResizeObserver 覆盖数据变化/字体落版/换行变化，自收敛无需手动触发
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const report = () => {
      const contentH =
        (headerRef.current?.offsetHeight ?? 0) + el.offsetHeight + HEIGHT_EXTRA_PX;
      if (contentH === lastReportedH.current) return;
      lastReportedH.current = contentH;
      invoke('set_memo_sticky_height', { height: contentH }).catch((e: unknown) => {
        console.error('Failed to resize sticky window:', e);
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, []);

  // 透明度实时跟随外观设置：主窗滑杆 → ThemeController 写 localStorage 缓存 →
  // storage 事件跨窗口广播（同 origin），这里即时应用（启动首帧由 theme-bootstrap 预读）
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PANEL_ALPHA_CACHE_KEY || e.newValue === null) return;
      const alpha = parseFloat(e.newValue);
      // 合法区间同 theme-bootstrap / Rust clamp（0.4~1.0），越界丢弃
      if (alpha >= 0.4 && alpha <= 1) {
        document.documentElement.style.setProperty('--app-panel-alpha', alpha.toFixed(2));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await invoke<Memo[]>('list_memos');
      setMemos(list.filter((m) => m.status === 'pending' && m.pinned));
    } catch (e) {
      console.error('Failed to load pinned memos:', e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 主视图/便签任一侧改库 → 事件回流双端刷新
  useEffect(() => {
    const unlisten = listen('memo:changed', () => {
      void load();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [load]);

  // 拖拽落点持久化：静止 POS_SAVE_DELAY_MS 后上报一次
  const posTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<{ x: number; y: number }>(
      'tauri://move',
      (event) => {
        if (posTimerRef.current !== null) {
          window.clearTimeout(posTimerRef.current);
        }
        const { x, y } = event.payload;
        posTimerRef.current = window.setTimeout(() => {
          invoke('save_memo_sticky_position', { x, y }).catch((e: unknown) => {
            console.error('Failed to save sticky position:', e);
          });
        }, POS_SAVE_DELAY_MS);
      },
    );
    return () => {
      if (posTimerRef.current !== null) {
        window.clearTimeout(posTimerRef.current);
      }
      unlisten.then((f) => f());
    };
  }, []);

  const complete = useCallback(async (id: number) => {
    // 乐观移除，事件回流对齐
    setMemos((prev) => prev.filter((m) => m.id !== id));
    try {
      await invoke('set_memo_status', { id, status: 'done' });
    } catch (e) {
      console.error('Failed to complete memo:', e);
    }
  }, []);

  const close = useCallback(() => {
    invoke('set_memo_sticky_enabled', { enabled: false }).catch((e: unknown) => {
      console.error('Failed to close sticky:', e);
    });
  }, []);

  return (
    <div className="h-screen flex">
      <div className="relative flex-1 m-1 rounded-xl border border-app-border-subtle panel-glass-toast overflow-hidden flex flex-col">
        {/* 头部把手：drag-region 只挂标题与留白，关闭按钮保持可点 */}
        <div ref={headerRef} className="flex items-center h-8 px-2.5 shrink-0">
          <span data-tauri-drag-region className="flex items-center gap-1.5 cursor-move select-none">
            <ListTodo size={12} className="text-app-text-tertiary" />
            <span className="text-xs font-medium text-app-text-secondary">备忘便签</span>
          </span>
          <span data-tauri-drag-region className="flex-1 h-full cursor-move" />
          <button
            onClick={close}
            aria-label="关闭便签"
            className="p-1 rounded text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>

        {/* 列表：内层 measure 容器高度纯由内容驱动（自适应测量源），
            窗口钳到上限时外层 overflow-y-auto 接管滚动 */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div ref={measureRef}>
          {memos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-1.5 text-center">
              <ListTodo size={20} className="text-app-text-disabled opacity-40" />
              <p className="text-xs text-app-text-disabled">没有钉住的备忘</p>
              <p className="text-xs text-app-text-disabled">在备忘页给待办钉上图钉</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {memos.map((m) => (
                <li
                  key={m.id}
                  className="group flex items-start gap-2 px-1.5 py-1 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <button
                    onClick={() => complete(m.id)}
                    aria-label="标记为完成"
                    className="mt-0.5 w-3.5 h-3.5 rounded border border-app-text-disabled flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                  >
                    <Check size={10} className="text-app-status-success opacity-0 group-hover:opacity-40" />
                  </button>
                  <span className="flex-1 min-w-0 text-xs leading-4 text-app-text-secondary">
                    {m.content}
                    {m.due_date && (
                      <span
                        className="ml-1.5 text-[10px] px-1 py-px rounded"
                        style={{
                          backgroundColor: 'rgba(99, 102, 241, 0.15)',
                          color: 'var(--app-brand-primary-light)',
                        }}
                      >
                        {m.due_date}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
