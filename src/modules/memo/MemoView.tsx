// 备忘视图（memo 插件本体）：memos 表是唯一真源，勾选/忽略直接改库。
// 顶部合并框：边输边滤（实时收窄列表）、回车即记（复用 launcher「记」同一命令）。
// 列表刷新走后端 memo:changed 事件（创建/解析写回/处置/批量处置四处 emit），
// 因此 @memo 带参创建后能眼睁睁看着原文被 LLM 重构正文替换。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, ListTodo, Loader2, PenLine, Pin, X } from 'lucide-react';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';
import { immediateResize } from '@/utils/tauri';
import { Tooltip } from '@/components/Tooltip';
import { useToastStore } from '@/stores/toastStore';
import { usePluginPayload } from '@/plugins/usePluginPayload';

interface Memo {
  id: number;
  content: string;
  content_raw: string;
  status: 'pending' | 'done' | 'dismissed';
  acted_at: number | null;
  due_date: string | null;
  pinned: boolean;
  created_at: number;
}

function localDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function groupLabel(date: string, today: string, yesterday: string): string {
  if (date === today) return '今天';
  if (date === yesterday) return '昨天';
  return date;
}

interface MemoSection {
  key: string;
  label: string;
  /** 逾期组：组头红色 */
  danger?: boolean;
  items: Memo[];
}

export function MemoView() {
  const { addToast } = useToastStore();

  // 与其他工具视图同一窗口规范：挂载即校准尺寸（冲掉启动器残留的 debounce）
  useEffect(() => {
    immediateResize(WINDOW_SIZE.MEMO.height, WINDOW_SIZE.MEMO.width);
  }, []);

  const [memos, setMemos] = useState<Memo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await invoke<Memo[]>('list_memos');
      setMemos(list);
      setError(null);
    } catch (e) {
      console.error('Failed to load memos:', e);
      setError('加载备忘失败');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 后端 memo:changed 驱动刷新：创建/解析写回/处置/批量处置后列表自动对齐
  useEffect(() => {
    const unlisten = listen('memo:changed', () => {
      void load();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [load]);

  // @memo 带参捕获：创建 + 打开视图（确认型捕获，与「记」的盲记互补）。
  // 空白载荷静默当裸 @memo 处理（框架对无参 trigger 本就不投载荷，这里是纵深防御）
  const createMemo = useCallback(
    async (text: string) => {
      if (creating) return;
      setCreating(true);
      try {
        await invoke('create_companion_intent', { text });
        addToast({
          type: 'success',
          title: '已记下',
          message: text.length > 50 ? `${text.slice(0, 50)}…` : text,
        });
        setQuery('');
        inputRef.current?.focus();
      } catch (e) {
        addToast({ type: 'error', title: '保存备忘失败', message: String(e) });
      } finally {
        setCreating(false);
      }
    },
    [creating, addToast],
  );

  usePluginPayload(
    'memo',
    useCallback(
      (payload: unknown) => {
        if (typeof payload !== 'string') return;
        const text = payload.trim();
        if (text) void createMemo(text);
      },
      [createMemo],
    ),
  );

  const setStatus = useCallback(
    async (id: number, status: 'pending' | 'done' | 'dismissed') => {
      // 乐观更新，事件回流对齐（memo:changed → load）
      setMemos((prev) =>
        prev ? prev.map((m) => (m.id === id ? { ...m, status } : m)) : prev,
      );
      try {
        await invoke('set_memo_status', { id, status });
      } catch (e) {
        console.error('Failed to set memo status:', e);
        load();
      }
    },
    [load],
  );

  const togglePin = useCallback(
    async (memo: Memo) => {
      const pinned = !memo.pinned;
      setMemos((prev) =>
        prev ? prev.map((m) => (m.id === memo.id ? { ...m, pinned } : m)) : prev,
      );
      try {
        await invoke('set_memo_pinned', { id: memo.id, pinned });
      } catch (e) {
        console.error('Failed to toggle pin:', e);
        load();
      }
    },
    [load],
  );

  const keyword = query.trim().toLowerCase();

  // 智能分组（Apple Reminders 语义）：置顶 → 已逾期 → 今天到期 → 近期到期 → 以后 →
  // 无日期按创建日期 → 已完成；空组不渲染，搜索过滤对各组一视同仁
  const sections = useMemo<MemoSection[]>(() => {
    const list = memos ?? [];
    const match = (m: Memo) => !keyword || m.content.toLowerCase().includes(keyword);
    const byCreatedDesc = (a: Memo, b: Memo) => b.created_at - a.created_at;
    // 逾期越早越靠前；同天到期内新记的在前
    const byDueAsc = (a: Memo, b: Memo) =>
      a.due_date! < b.due_date!
        ? -1
        : a.due_date! > b.due_date!
          ? 1
          : b.created_at - a.created_at;

    const todayStr = localDate(Date.now() / 1000);
    const weekLaterStr = localDate(Date.now() / 1000 + 7 * 86400);
    const yesterdayStr = localDate(Date.now() / 1000 - 86400);

    const pending = list.filter((m) => m.status === 'pending' && match(m));
    const done = list.filter((m) => m.status === 'done' && match(m));

    const pinned = pending.filter((m) => m.pinned).sort(byCreatedDesc);
    const rest = pending.filter((m) => !m.pinned);
    const overdue = rest
      .filter((m) => m.due_date && m.due_date < todayStr)
      .sort(byDueAsc);
    const dueToday = rest
      .filter((m) => m.due_date === todayStr)
      .sort(byCreatedDesc);
    const dueSoon = rest
      .filter((m) => m.due_date && m.due_date > todayStr && m.due_date <= weekLaterStr)
      .sort(byDueAsc);
    const dueLater = rest
      .filter((m) => m.due_date && m.due_date > weekLaterStr)
      .sort(byDueAsc);
    const noDate = rest.filter((m) => !m.due_date);

    const out: MemoSection[] = [
      { key: 'pinned', label: '置顶', items: pinned },
      { key: 'overdue', label: '已逾期', danger: true, items: overdue },
      { key: 'due-today', label: '今天到期', items: dueToday },
      { key: 'due-soon', label: '近期到期', items: dueSoon },
      { key: 'due-later', label: '以后', items: dueLater },
    ];

    // 无日期备忘按创建日期分组（今天/昨天/具体日期），组间倒序、组内新在前
    const byDate = new Map<string, Memo[]>();
    for (const m of noDate) {
      const d = localDate(m.created_at);
      const arr = byDate.get(d) ?? [];
      arr.push(m);
      byDate.set(d, arr);
    }
    for (const [date, items] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
      out.push({
        key: `created-${date}`,
        label: groupLabel(date, todayStr, yesterdayStr),
        items: items.sort(byCreatedDesc),
      });
    }

    out.push({ key: 'done', label: '已完成', items: done });
    return out.filter((s) => s.items.length > 0);
  }, [memos, keyword]);

  const isEmpty = sections.length === 0;

  return (
    <div className="w-full h-full flex flex-col min-w-0 overflow-hidden panel-glass">
      {/* 合并框：边输边滤，回车即记 */}
      <div className="px-6 pt-4 pb-2">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent focus-within:border-white/15"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)' }}
        >
          <PenLine size={14} style={{ color: THEME.TEXT_DISABLED }} className="shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const text = query.trim();
                if (text) void createMemo(text);
              }
            }}
            placeholder="输入筛选备忘，回车记下新备忘"
            autoFocus
            disabled={creating}
            className="flex-1 bg-transparent outline-none text-sm placeholder:opacity-60 disabled:opacity-50"
            style={{ color: THEME.TEXT_PRIMARY }}
          />
          {creating && (
            <Loader2 size={14} className="animate-spin shrink-0" style={{ color: THEME.TEXT_DISABLED }} />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {memos === null && !error ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: THEME.TEXT_DISABLED }}
          >
            <Loader2 size={18} className="animate-spin mr-2" />
            <span className="text-xs">加载中...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-sm" style={{ color: THEME.ERROR_TEXT }}>{error}</p>
            <button
              onClick={load}
              className="text-sm underline cursor-pointer"
              style={{ color: THEME.INFO }}
            >
              重试
            </button>
          </div>
        ) : isEmpty ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2 text-center"
            style={{ color: THEME.TEXT_DISABLED }}
          >
            <ListTodo size={28} className="opacity-40" />
            {keyword ? (
              <p className="text-xs">没有匹配「{query.trim()}」的备忘</p>
            ) : (
              <>
                <p className="text-xs">暂无备忘</p>
                <p className="text-xs">在启动器输入「记 + 空格 + 内容」快速记录</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-5 max-w-2xl">
            {sections.map((section) => (
              <section key={section.key}>
                <h3
                  className="text-xs font-medium mb-2"
                  style={{
                    color: section.danger ? THEME.ERROR_TEXT : THEME.TEXT_TERTIARY,
                  }}
                >
                  {section.label}
                </h3>
                <ul className="space-y-1">
                  {section.items.map((m) => (
                    <MemoRow
                      key={m.id}
                      memo={m}
                      onToggle={() =>
                        setStatus(m.id, m.status === 'done' ? 'pending' : 'done')
                      }
                      onDismiss={() => setStatus(m.id, 'dismissed')}
                      onPinToggle={() => togglePin(m)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface MemoRowProps {
  memo: Memo;
  onToggle: () => void;
  onDismiss: () => void;
  onPinToggle: () => void;
}

function MemoRow({ memo, onToggle, onDismiss, onPinToggle }: MemoRowProps) {
  const done = memo.status === 'done';
  return (
    <li className="group flex items-start gap-2.5 px-2 py-1.5 rounded-lg transition-colors hover:bg-white/5">
      <button
        onClick={onToggle}
        aria-label={done ? '标记为待处理' : '标记为完成'}
        className="mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer"
        style={{
          borderColor: done ? THEME.SUCCESS : THEME.TEXT_DISABLED,
          backgroundColor: done ? 'rgba(34, 197, 94, 0.2)' : 'transparent',
        }}
      >
        {done && <Check size={11} style={{ color: THEME.SUCCESS }} />}
      </button>
      <Tooltip
        content={memo.content_raw !== memo.content ? `原文：${memo.content_raw}` : undefined}
        wrapperClassName="flex-1 min-w-0"
      >
        <span
          className={`flex-1 text-sm leading-5 ${done ? 'line-through' : ''}`}
          style={{ color: done ? THEME.TEXT_DISABLED : THEME.TEXT_SECONDARY }}
        >
          {memo.content}
        {memo.due_date && (
          <span
            className="ml-2 text-[10px] px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: 'rgba(99, 102, 241, 0.15)',
              color: 'var(--app-brand-primary-light)',
            }}
          >
            {memo.due_date}
          </span>
        )}
        </span>
      </Tooltip>
      {/* pinned 常显图钉（组归属的视觉锚点）；非 pinned 仅 hover 显现 */}
      <button
        onClick={onPinToggle}
        aria-label={memo.pinned ? '取消置顶' : '置顶'}
        className={`mt-0.5 p-0.5 rounded transition-opacity cursor-pointer hover:bg-white/10 ${
          memo.pinned ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
        style={{
          color: memo.pinned ? 'var(--app-brand-primary-light)' : THEME.TEXT_DISABLED,
        }}
      >
        <Pin size={13} fill={memo.pinned ? 'currentColor' : 'none'} />
      </button>
      <button
        onClick={onDismiss}
        aria-label="忽略这条备忘"
        className="mt-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-white/10"
        style={{ color: THEME.TEXT_DISABLED }}
      >
        <X size={13} />
      </button>
    </li>
  );
}
