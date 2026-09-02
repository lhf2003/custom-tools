import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  Search,
  Pencil,
  Trash2,
  Check,
  X,
  History,
  ChevronDown,
  ChevronRight,
  Brain,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { confirmDialog } from '@/stores/confirmStore';
import { useToastStore } from '@/stores/toastStore';
import { CustomSelect } from '../components/CustomSelect';

interface MemoryFact {
  id: number;
  fact: string;
  category: string;
  source: string;
  confirmations: number;
  created_at: number;
  last_confirmed: number;
}

interface MemoryFactEvent {
  id: number;
  fact_id: number | null;
  action: string;
  old_text: string | null;
  new_text: string | null;
  category: string | null;
  source: string;
  created_at: number;
}

interface HabitPattern {
  id: number;
  pattern_type: string;
  signature: string;
  description: string;
  pattern_data: string;
  confidence: number;
  occurrences: number;
  status: string;
  first_seen: number;
  last_seen: number;
}

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'person', label: '他是谁' },
  { key: 'project', label: '他的项目' },
  { key: 'workflow', label: '他怎么做事' },
  { key: 'voice', label: '他的表达偏好' },
  { key: 'expectation', label: '他对贾维斯的期望' },
];

const ACTION_LABEL: Record<string, string> = {
  add: '新增',
  confirm: '再次确认',
  update: '修改',
  delete: '删除',
};

const SOURCE_LABEL: Record<string, string> = {
  daily_analysis: '每日分析',
  recall: '聊天提取',
  explicit: '对话中记录',
  user: '手动编辑',
  analysis: '每日分析',
};

/** 两级流水线来源串（explicit|vec=0.88|llm:update）→ 可读标签 */
function sourceLabel(source: string): string {
  const base = source.split('|')[0];
  const label = SOURCE_LABEL[base] ?? base;
  return source.includes('|llm:') ? `${label} · 向量裁决` : label;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  dismissed: { text: '已忽略', color: 'text-white/30' },
  learning: { text: '学习中', color: 'text-amber-400' },
  confirmed: { text: '已确认', color: 'text-emerald-400' },
};

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface MemoryCenterProps {
  onBack: () => void;
}

/** 记忆中心：贾维斯记住的事（五维分组）+ 学到的习惯模式——分组折叠、搜索、编辑、删除、变更审计 */
export function MemoryCenter({ onBack }: MemoryCenterProps) {
  const { addToast } = useToastStore();
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [events, setEvents] = useState<MemoryFactEvent[]>([]);
  const [patterns, setPatterns] = useState<HabitPattern[]>([]);
  const [keyword, setKeyword] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('person');
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [historyEvents, setHistoryEvents] = useState<MemoryFactEvent[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    try {
      const [factList, recentEvents, patternList] = await Promise.all([
        invoke<MemoryFact[]>('get_companion_memory_facts'),
        invoke<MemoryFactEvent[]>('get_companion_memory_fact_events', { limit: 20 }),
        invoke<HabitPattern[]>('get_companion_patterns'),
      ]);
      setFacts(factList);
      setEvents(recentEvents);
      setPatterns(patternList);
    } catch (err) {
      console.error('Failed to load memory center:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const searching = keyword.trim().length > 0;

  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return facts;
    return facts.filter((f) => f.fact.includes(kw));
  }, [facts, keyword]);

  const groups = useMemo(() => {
    const known = CATEGORIES.map((c) => ({
      ...c,
      items: filtered.filter((f) => f.category === c.key),
    }));
    const others = {
      key: 'others',
      label: '其他',
      items: filtered.filter((f) => !CATEGORIES.some((c) => c.key === f.category)),
    };
    return { known, others };
  }, [filtered]);

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const isOpen = (key: string) => (searching ? true : expanded.has(key));

  const handleStartEdit = (fact: MemoryFact) => {
    setEditingId(fact.id);
    setEditText(fact.fact);
    setEditCategory(
      CATEGORIES.some((c) => c.key === fact.category) ? fact.category : 'person'
    );
  };

  const handleSaveEdit = async () => {
    if (editingId === null || !editText.trim()) return;
    try {
      await invoke('update_companion_memory_fact', {
        id: editingId,
        fact: editText.trim(),
        category: editCategory,
      });
      setEditingId(null);
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '保存失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirmDialog({
      title: '删除记忆',
      message: '确定删除这条记忆吗？',
      detail: '变更历史会保留在审计记录里。',
      danger: true,
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await invoke('delete_companion_memory_fact', { id });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '删除失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDismissPattern = async (id: number) => {
    try {
      await invoke('set_companion_pattern_status', { id, status: 'dismissed' });
      await loadData();
    } catch (err) {
      console.error('Failed to dismiss pattern:', err);
    }
  };

  const handleToggleHistory = async (factId: number) => {
    if (historyFor === factId) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(factId);
    try {
      const list = await invoke<MemoryFactEvent[]>('get_companion_memory_fact_events', {
        factId,
        limit: 20,
      });
      setHistoryEvents(list);
    } catch (err) {
      console.error('Failed to load fact history:', err);
    }
  };

  const renderFactRow = (fact: MemoryFact) => {
    const editing = editingId === fact.id;
    return (
      <div key={fact.id} className="rounded-lg px-2 py-1.5 -mx-2 hover:bg-white/5 transition-colors">
        {editing ? (
          <div className="space-y-2">
            <input
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full bg-zinc-700 text-white text-xs rounded-lg px-2.5 py-1.5 outline-none border border-zinc-600 focus:border-zinc-500"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <CustomSelect
                value={editCategory}
                onChange={setEditCategory}
                options={CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
                className="w-32 flex-shrink-0"
              />
              <button
                onClick={handleSaveEdit}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors cursor-pointer"
              >
                <Check size={12} /> 保存
              </button>
              <button
                onClick={() => setEditingId(null)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-white/50 text-xs hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X size={12} /> 取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-white/80 flex-1 min-w-0 break-words">{fact.fact}</span>
            <Tooltip content={`来源：${sourceLabel(fact.source)}`} wrapperClassName="shrink-0">
              <span className="text-white/30 shrink-0">
                {sourceLabel(fact.source)} · ×{fact.confirmations}
              </span>
            </Tooltip>
            <Tooltip content="变更历史" wrapperClassName="shrink-0">
              <button
                onClick={() => handleToggleHistory(fact.id)}
                className="text-white/30 hover:text-white/70 transition-colors cursor-pointer shrink-0"
              >
                {historyFor === fact.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            </Tooltip>
            <Tooltip content="编辑" wrapperClassName="shrink-0">
              <button
                onClick={() => handleStartEdit(fact)}
                className="text-white/30 hover:text-white/70 transition-colors cursor-pointer shrink-0"
              >
                <Pencil size={12} />
              </button>
            </Tooltip>
            <Tooltip content="删除" wrapperClassName="shrink-0">
              <button
                onClick={() => handleDelete(fact.id)}
                className="text-white/30 hover:text-red-400 transition-colors cursor-pointer shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </Tooltip>
          </div>
        )}
        {historyFor === fact.id && (
          <div className="mt-1.5 ml-1 pl-2 border-l border-white/10 space-y-1">
            {historyEvents.length === 0 ? (
              <p className="text-white/30 text-xs">还没有变更记录</p>
            ) : (
              historyEvents.map((ev) => (
                <div key={ev.id} className="text-xs text-white/40">
                  <span className="text-white/50">{formatTime(ev.created_at)}</span>
                  {' · '}
                  <span>{ACTION_LABEL[ev.action] ?? ev.action}</span>
                  {' · '}
                  <span>{sourceLabel(ev.source)}</span>
                  {ev.action === 'update' && ev.old_text && (
                    <div className="text-white/30 mt-0.5">
                      「{ev.old_text}」→「{ev.new_text}」
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  const renderPatternRow = (p: HabitPattern) => {
    const status = STATUS_LABEL[p.status] ?? STATUS_LABEL.learning;
    return (
      <div
        key={p.id}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-white/5 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <Tooltip content={p.description} wrapperClassName="w-full truncate">
            <div className="text-white/80 text-xs">{p.description}</div>
          </Tooltip>
          <div className="text-white/30 text-xs mt-0.5">
            置信度 {Math.round(p.confidence * 100)}% · 观察到 {p.occurrences} 次 ·{' '}
            <span className={status.color}>{status.text}</span>
          </div>
        </div>
        {p.status !== 'dismissed' && (
          <Tooltip content="不再使用此模式" wrapperClassName="shrink-0">
            <button
              onClick={() => handleDismissPattern(p.id)}
              className="text-white/30 hover:text-red-400 transition-colors cursor-pointer shrink-0"
            >
              <Trash2 size={13} />
            </button>
          </Tooltip>
        )}
      </div>
    );
  };

  /** 分组折叠行：一行标题 + 点击展开/收起内容 */
  const renderGroupRow = (
    key: string,
    label: string,
    count: number,
    children: React.ReactNode,
    emptyHint?: string
  ) => {
    const open = isOpen(key);
    const toggleable = !searching;
    return (
      <div key={key}>
        <button
          onClick={() => toggleable && toggleGroup(key)}
          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-colors cursor-pointer ${
            open
              ? 'bg-white/[0.04] border-white/15'
              : 'bg-white/[0.02] border-white/10 hover:bg-white/5'
          }`}
        >
          <ChevronRight
            size={14}
            className={`text-white/40 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="text-white/70 text-xs font-medium">{label}</span>
          <span className="text-white/25 text-xs">{count}</span>
        </button>
        {open && (
          <div className="mt-1 pl-2 space-y-0.5">
            {count === 0 ? (
              <p className="text-white/25 text-xs px-2 py-1">{emptyHint ?? '这组还没有内容'}</p>
            ) : (
              children
            )}
          </div>
        )}
      </div>
    );
  };

  const emptyAll = facts.length === 0 && patterns.length === 0;

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <Tooltip content="返回陪伴设置">
          <button
            onClick={onBack}
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Tooltip>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-app-brand-primary/30 to-app-brand-primary/20 flex items-center justify-center">
          <Brain size={20} className="text-app-brand-primary-light" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">记忆中心</h2>
          <p className="text-white/40 text-xs">
            贾维斯记住的事与学到的习惯模式，可查看、编辑、删除，变更有迹可循
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索记忆…"
            className="w-full bg-white/5 text-white text-sm rounded-xl pl-9 pr-3 py-2.5 outline-none border border-white/10 focus:border-white/20 placeholder:text-white/30"
          />
        </div>

        {emptyAll && !searching ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 text-center">
            <p className="text-white/30 text-xs">
              还没有记忆——和贾维斯聊聊，或者说一句「记住我喜欢…」
            </p>
          </div>
        ) : filtered.length === 0 && searching ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 text-center">
            <p className="text-white/30 text-xs">没有匹配的记忆</p>
          </div>
        ) : (
          <div className="space-y-2">
            {patterns.length > 0 && !searching && (
              <div>
                {renderGroupRow(
                  'patterns',
                  '学到的习惯模式',
                  patterns.length,
                  patterns.map(renderPatternRow),
                  '还没有学到模式——积累一天数据后每晚 21 点自动分析'
                )}
              </div>
            )}
            <div className="space-y-2">
              {groups.known.map((g) =>
                searching && g.items.length === 0
                  ? null
                  : renderGroupRow(g.key, g.label, g.items.length, g.items.map(renderFactRow))
              )}
              {(groups.others.items.length > 0 || !searching) &&
                renderGroupRow(
                  'others',
                  '其他',
                  groups.others.items.length,
                  groups.others.items.map(renderFactRow)
                )}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 mb-2">
            <History size={13} className="text-white/40" />
            <span className="text-white/50 text-xs font-medium">最近变更</span>
          </div>
          {events.length === 0 ? (
            <p className="text-white/30 text-xs">还没有变更记录</p>
          ) : (
            <div className="space-y-1">
              {events.map((ev) => (
                <div key={ev.id} className="text-xs text-white/40 flex items-baseline gap-1.5">
                  <span className="text-white/30 shrink-0 tabular-nums">
                    {formatTime(ev.created_at)}
                  </span>
                  <span className="text-white/50 shrink-0">{ACTION_LABEL[ev.action] ?? ev.action}</span>
                  <span className="text-white/25 shrink-0">{sourceLabel(ev.source)}</span>
                  <span className="text-white/60 truncate">
                    {ev.new_text ?? ev.old_text ?? ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
