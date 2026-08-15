import { parseActionMessage } from './a2ui/action';
import { richDisplayText } from './attachments';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** a2ui = A2UI 界面卡片（content 为 SurfacePayload JSON）；
   *  rich = 附件消息（content 为附件 JSON，协议见 attachments.ts）；缺省 markdown */
  contentType?: 'markdown' | 'a2ui' | 'rich';
}

export interface ChatHistoryMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  content_type: string;
}

export interface ChatSessionSummary {
  id: number;
  preview: string;
  updated_at: string;
}

// ─────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────

/** 摘要单行化并截断（历史列表条目用）；rich 会话的首条消息是附件 JSON，降级为引用标签 */
export function previewText(text: string): string {
  const richText = richDisplayText(text);
  const oneLine = (richText ?? text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
}

/** 顶栏标题：首条用户消息单行截断（A2UI 操作回传显示胶囊文案，不显示协议 JSON）；
 *  空会话显示「新会话」 */
export function sessionTitleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '新会话';
  const action = parseActionMessage(first.content);
  const richText = first.contentType === 'rich' ? richDisplayText(first.content) : null;
  const raw = action ? `点击了「${action.label}」` : (richText ?? first.content);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine;
}

/**
 * 合并一条 a2ui 消息进消息列表：同一 surfaceId 的多次 render_ui 调用
 * （创建 → 增量更新 → 删除）合并为一个气泡，消息数组按序追加（重放语义）。
 */
export function mergeA2uiRow(list: ChatMessage[], content: string): ChatMessage[] {
  let payload: { surfaceId?: string; messages?: unknown[] };
  try {
    payload = JSON.parse(content);
  } catch {
    return list;
  }
  if (!payload.surfaceId || !Array.isArray(payload.messages)) return list;
  const idx = list.findIndex((m) => {
    if (m.contentType !== 'a2ui') return false;
    try {
      return JSON.parse(m.content).surfaceId === payload.surfaceId;
    } catch {
      return false;
    }
  });
  if (idx === -1) {
    return [...list, { role: 'assistant' as const, content, contentType: 'a2ui' as const }];
  }
  const prev = JSON.parse(list[idx].content) as { messages: unknown[] };
  const merged = JSON.stringify({
    ...prev,
    messages: [...prev.messages, ...(payload.messages as unknown[])],
  });
  return list.map((m, i) => (i === idx ? { ...m, content: merged } : m));
}

/** a2ui 消息的稳定渲染 key：surfaceId 不变，增量合并（数组长度变化）时不重挂载 */
export function surfaceKey(content: string): string {
  try {
    return (JSON.parse(content) as { surfaceId?: string }).surfaceId ?? content;
  } catch {
    return content;
  }
}

/** 历史行 → 渲染消息：a2ui 行按 surfaceId 合并，rich 行带类型分发附件渲染，其余原样 */
export function historyRowsToMessages(rows: ChatHistoryMessage[]): ChatMessage[] {
  let out: ChatMessage[] = [];
  for (const m of rows) {
    if (m.content_type === 'a2ui') {
      out = mergeA2uiRow(out, m.content);
    } else if (m.content_type === 'rich') {
      out.push({ role: m.role, content: m.content, contentType: 'rich' });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** chat 表时间列为本地时间（datetime('now','localtime')），按本地解析转相对时间 */
export function formatRelativeTime(localTime: string): string {
  const t = new Date(localTime.replace(' ', 'T'));
  if (Number.isNaN(t.getTime())) return '';
  const diffMin = Math.floor((Date.now() - t.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}
