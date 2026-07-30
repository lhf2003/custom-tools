// 统计页共用格式化与文案映射

/** LLM 调用来源中文名（后端 source 字段 → 展示名） */
export const SOURCE_LABELS: Record<string, string> = {
  chat: '聊天',
  analysis: '每日分析',
  report: '日报',
  recall: '记忆提取',
  intent_parse: '意图解析',
  translate: '翻译',
  qa: '问答',
  test: '连接测试',
  diary: '情感日记',
  focus: '今日关注',
  chat_summary: '聊天摘要',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** 字节数 → 可读大小（61.5 MB / 543 KB） */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4)}`;
}

/** 计数（千分位）：12,345 */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** unix 秒 → MM-DD HH:mm */
export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** unix 秒 → 7月30日 10:28（统计时刻） */
export function fmtScannedAt(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** unix 秒 → datetime-local 输入框值（本地时区 YYYY-MM-DDTHH:mm） */
export function toLocalInputValue(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
