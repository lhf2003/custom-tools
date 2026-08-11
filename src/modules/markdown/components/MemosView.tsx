// 备忘视图（DB 驱动）：memos 表是唯一真源，勾选/忽略直接改库。
// 旧「陪伴日报/备忘.md」已停写，作为历史档案留在文件树中（本视图不读它）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, Loader2, ListTodo, X } from 'lucide-react';
import { THEME } from '@/constants/theme';
import { Tooltip } from '@/components/Tooltip';

/** MarkdownView 里选中备忘视图的哨兵路径（不可能与真实笔记路径冲突） */
export const MEMO_VIEW_PATH = '__memos_view__';

interface Memo {
  id: number;
  content: string;
  content_raw: string;
  status: 'pending' | 'done' | 'dismissed';
  acted_at: number | null;
  due_date: string | null;
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

export function MemosView() {
  const [memos, setMemos] = useState<Memo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const setStatus = useCallback(
    async (id: number, status: 'pending' | 'done' | 'dismissed') => {
      // 乐观更新，失败重拉对齐
      setMemos((prev) =>
        prev
          ? prev.map((m) => (m.id === id ? { ...m, status } : m))
          : prev,
      );
      try {
        await invoke('set_memo_status', { id, status });
      } catch (e) {
        console.error('Failed to set memo status:', e);
      }
      load();
    },
    [load],
  );

  const { pendingGroups, doneList } = useMemo(() => {
    const list = memos ?? [];
    const pending = list.filter((m) => m.status === 'pending');
    const done = list.filter((m) => m.status === 'done');
    const byDate = new Map<string, Memo[]>();
    for (const m of pending) {
      const d = localDate(m.created_at);
      const arr = byDate.get(d) ?? [];
      arr.push(m);
      byDate.set(d, arr);
    }
    // 分组按日期倒序（最新在上），组内新备忘在前
    const groups = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(
        ([date, items]) =>
          [date, [...items].sort((a, b) => b.created_at - a.created_at)] as const,
      );
    return { pendingGroups: groups, doneList: done };
  }, [memos]);

  const today = localDate(Date.now() / 1000);
  const yesterday = localDate(Date.now() / 1000 - 86400);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 flex items-center gap-2">
        <ListTodo size={15} style={{ color: THEME.TEXT_TERTIARY }} />
        <span className="text-sm font-semibold" style={{ color: THEME.TEXT_PRIMARY }}>
          备忘
        </span>
        <span className="text-xs" style={{ color: THEME.TEXT_DISABLED }}>
          启动器输入「记 + 内容」快速记录
        </span>
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
        ) : pendingGroups.length === 0 && doneList.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2 text-center"
            style={{ color: THEME.TEXT_DISABLED }}
          >
            <ListTodo size={28} className="opacity-40" />
            <p className="text-xs">暂无备忘</p>
            <p className="text-xs">在启动器输入「记 + 空格 + 内容」快速记录</p>
          </div>
        ) : (
          <div className="space-y-5 max-w-2xl">
            {pendingGroups.map(([date, items]) => (
              <section key={date}>
                <h3
                  className="text-xs font-medium mb-2"
                  style={{ color: THEME.TEXT_TERTIARY }}
                >
                  {groupLabel(date, today, yesterday)}
                </h3>
                <ul className="space-y-1">
                  {items.map((m) => (
                    <MemoRow
                      key={m.id}
                      memo={m}
                      onToggle={() => setStatus(m.id, 'done')}
                      onDismiss={() => setStatus(m.id, 'dismissed')}
                    />
                  ))}
                </ul>
              </section>
            ))}

            {doneList.length > 0 && (
              <section>
                <h3
                  className="text-xs font-medium mb-2"
                  style={{ color: THEME.TEXT_TERTIARY }}
                >
                  已完成
                </h3>
                <ul className="space-y-1">
                  {doneList.map((m) => (
                    <MemoRow
                      key={m.id}
                      memo={m}
                      onToggle={() => setStatus(m.id, 'pending')}
                      onDismiss={() => setStatus(m.id, 'dismissed')}
                    />
                  ))}
                </ul>
              </section>
            )}
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
}

function MemoRow({ memo, onToggle, onDismiss }: MemoRowProps) {
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
