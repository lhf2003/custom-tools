/**
 * 剪贴板内容检测与格式化工具（纯函数）
 *
 * - 类型配置（扁平语义色，禁渐变）
 * - 文本内容分级：JSON / 整链 / 普通文本
 * - JSON 着色的极简扫描器（输入限定为 JSON.stringify 的规范输出）
 * - 链接切分（linkify），中英混排安全
 */
import { FileText, Image as ImageIcon, Folder, type LucideIcon } from 'lucide-react';

// ─── 类型配置 ────────────────────────────────────────────────────────────────

export interface TypeConfig {
  label: string;
  icon: LucideIcon;
  /** 列表图标色（同色相亮字，无底色块） */
  iconClass: string;
  /** chip：语义色 15% 透明底 + 同色相亮字（DESIGN.md Chips 规则） */
  chipClass: string;
}

const IMAGE_CONFIG: TypeConfig = {
  label: '图片',
  icon: ImageIcon,
  iconClass: 'text-[#c084fc]',
  chipClass: 'bg-[#a855f7]/15 text-[#c084fc]',
};

export function getTypeConfig(type: string, content?: string): TypeConfig {
  // 文件类型但路径是图片 → 按图片处理
  if (type === 'file' && content && isImageFile(content)) {
    return IMAGE_CONFIG;
  }
  switch (type) {
    case 'text':
      return { label: '文本', icon: FileText, iconClass: 'text-[#60a5fa]', chipClass: 'bg-[#2563eb]/15 text-[#60a5fa]' };
    case 'image':
      return IMAGE_CONFIG;
    case 'file':
      return { label: '文件', icon: Folder, iconClass: 'text-[#fbbf24]', chipClass: 'bg-[#f59e0b]/15 text-[#fbbf24]' };
    default:
      return { label: '未知', icon: FileText, iconClass: 'text-app-text-tertiary', chipClass: 'bg-white/10 text-app-text-tertiary' };
  }
}

export function isImageFile(path: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];
  const lowerPath = path.toLowerCase();
  return imageExtensions.some((ext) => lowerPath.endsWith(ext));
}

/** 列表单行预览：文本取首行；图片/文件取文件名（content 存的是完整路径，多文件附计数） */
export function displayName(content: string, contentType: string): string {
  const firstLine = content.split('\n')[0];
  if (contentType === 'text') return firstLine;
  const base = firstLine.split(/[\\/]/).pop() || firstLine;
  const extra = content.split('\n').filter(Boolean).length - 1;
  return extra > 0 ? `${base} 等 ${extra + 1} 个文件` : base;
}

// ─── 相对时间 ────────────────────────────────────────────────────────────────

/** SQLite 返回 "YYYY-MM-DD HH:MM:SS"，转成 ISO 再解析 */
function parseSqliteDate(dateStr: string): Date {
  if (dateStr.includes(' ')) {
    const [date, time] = dateStr.split(' ');
    return new Date(`${date}T${time}Z`);
  }
  return new Date(dateStr);
}

export function formatTime(dateStr: string): string {
  try {
    const date = parseSqliteDate(dateStr);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return '刚刚';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}分钟前`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}小时前`;

    const days = Math.floor(diffInSeconds / 86400);
    if (days <= 30) return `${days}天前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ─── 文本内容分级 ────────────────────────────────────────────────────────────

export type TextKind = 'json' | 'link' | 'text';

/** JSON.parse 上限：超过 200KB 的文本不做 JSON 探测，避免阻塞 UI */
const JSON_DETECT_MAX_CHARS = 200_000;

export function detectTextKind(content: string): TextKind {
  const trimmed = content.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return 'link';
  if (
    trimmed.length > 1 &&
    trimmed.length <= JSON_DETECT_MAX_CHARS &&
    (trimmed.startsWith('{') || trimmed.startsWith('['))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      return 'text';
    }
  }
  return 'text';
}

export function formatJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return null;
  }
}

// ─── JSON 着色 ───────────────────────────────────────────────────────────────

export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'plain';

export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

/** 与 json_formatter 模块 canvas 色板一致，两处 JSON 渲染保持同一副面孔 */
export const JSON_TOKEN_COLORS: Record<JsonTokenKind, string> = {
  key: '#7dd3fc',
  string: '#6ee7b7',
  number: '#fcd34d',
  boolean: '#c4b5fd',
  null: '#a1a1aa',
  punct: '#71717a',
  plain: '#d4d4d8',
};

/**
 * 扫描 JSON.stringify 的规范输出，产出着色 token 流。
 * 输入合法（函数内部只接收 JSON.parse 通过后的重序列化结果），无需容错分支。
 */
export function tokenizeJson(pretty: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;

  while (i < pretty.length) {
    const ch = pretty[i];

    // 空白连续段（缩进/换行）
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      let j = i;
      while (j < pretty.length && (pretty[j] === ' ' || pretty[j] === '\n' || pretty[j] === '\t')) j++;
      tokens.push({ text: pretty.slice(i, j), kind: 'plain' });
      i = j;
      continue;
    }

    // 结构符
    if ('{}[],:'.includes(ch)) {
      tokens.push({ text: ch, kind: 'punct' });
      i++;
      continue;
    }

    // 字符串：处理后缀转义；收尾后看下一个非空白字符是否为冒号 → key
    if (ch === '"') {
      let j = i + 1;
      while (j < pretty.length) {
        if (pretty[j] === '\\') j += 2;
        else if (pretty[j] === '"') { j++; break; }
        else j++;
      }
      let k = j;
      while (k < pretty.length && pretty[k] === ' ') k++;
      tokens.push({ text: pretty.slice(i, j), kind: pretty[k] === ':' ? 'key' : 'string' });
      i = j;
      continue;
    }

    // 数字
    if (/[-0-9]/.test(ch)) {
      let j = i;
      while (j < pretty.length && /[0-9eE+\-.]/.test(pretty[j])) j++;
      tokens.push({ text: pretty.slice(i, j), kind: 'number' });
      i = j;
      continue;
    }

    if (pretty.startsWith('true', i)) { tokens.push({ text: 'true', kind: 'boolean' }); i += 4; continue; }
    if (pretty.startsWith('false', i)) { tokens.push({ text: 'false', kind: 'boolean' }); i += 5; continue; }
    if (pretty.startsWith('null', i)) { tokens.push({ text: 'null', kind: 'null' }); i += 4; continue; }

    tokens.push({ text: ch, kind: 'plain' });
    i++;
  }

  return tokens;
}

// ─── 链接切分 ────────────────────────────────────────────────────────────────

export interface TextSegment {
  text: string;
  isLink: boolean;
}

/** 排除不可能属于 URL 的字符（空白、引号、括号、CJK 标点）。
 *  注意 . , ; : ? 等是 URL 合法字符（域名/端口/查询串），不在此排除——
 *  句读尾随由 TRAILING_PUNCT 处理。 */
const URL_PATTERN = /https?:\/\/[^\s"'<>()\[\]{}。、；：，！？（）【】《》「」『』“”‘’]+/gi;
/** 紧跟 URL 的 ASCII 句读（"见 https://a.b/c." 的句点不属于 URL） */
const TRAILING_PUNCT = /[.,;:!?)\]'"]+$/;

export function linkifyText(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;

  for (const match of content.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const url = raw.replace(TRAILING_PUNCT, '');

    if (start > last) segments.push({ text: content.slice(last, start), isLink: false });
    if (url.length > 0) segments.push({ text: url, isLink: true });
    if (url.length < raw.length) segments.push({ text: raw.slice(url.length), isLink: false });
    last = start + raw.length;
  }

  if (last < content.length) segments.push({ text: content.slice(last), isLink: false });
  return segments;
}
