// A2UI 动态值求值：数据绑定、注册函数（checks 校验 + formatString 插值）。
// 函数名录与官方 catalog 对齐；求值全部无副作用（openUrl 除外，语义就是打开浏览器）。

import type { A2uiCheck, DynamicValue } from './types';

/** 求值上下文：按绝对路径读数据模型 */
export interface EvalCtx {
  resolvePath: (absPath: string) => unknown;
}

/** 任意值转展示字符串（规范：null/undefined → ""，对象/数组 → JSON） */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isPathSpec(v: unknown): v is { path: string } {
  return typeof v === 'object' && v !== null && typeof (v as { path?: unknown }).path === 'string';
}

function isCallSpec(v: unknown): v is { call: string; args?: Record<string, unknown> } {
  return typeof v === 'object' && v !== null && typeof (v as { call?: unknown }).call === 'string';
}

/** 解析动态值：字面量原样返回，{path} 取数据，{call} 调函数 */
export function resolveDynamic(spec: DynamicValue | unknown, ctx: EvalCtx): unknown {
  if (isPathSpec(spec)) return ctx.resolvePath(spec.path);
  if (isCallSpec(spec)) return evalFunction(spec.call, spec.args ?? {}, ctx);
  return spec;
}

function resolveArg(args: Record<string, unknown>, key: string, ctx: EvalCtx): unknown {
  return resolveDynamic(args[key], ctx);
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(toDisplayString(v));
  return Number.isFinite(n) ? n : 0;
}

/** 简易日期格式化：支持 yyyy MM dd HH mm ss 令牌 */
export function formatDateTokens(value: unknown, pattern: string): string {
  const s = toDisplayString(value);
  const d = new Date(s.includes('T') || s.includes('-') ? s : Number(s));
  if (Number.isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

/** 注册函数求值。未知函数返回空串并记警告——不让一个函数拖垮整张卡片 */
export function evalFunction(call: string, args: Record<string, unknown>, ctx: EvalCtx): unknown {
  switch (call) {
    case 'required': {
      const v = resolveArg(args, 'value', ctx);
      return v !== null && v !== undefined && v !== '';
    }
    case 'regex': {
      const v = toDisplayString(resolveArg(args, 'value', ctx));
      const pattern = toDisplayString(resolveArg(args, 'pattern', ctx));
      try {
        return new RegExp(pattern).test(v);
      } catch {
        return false;
      }
    }
    case 'email': {
      const v = toDisplayString(resolveArg(args, 'value', ctx));
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    }
    case 'length': {
      const v = toDisplayString(resolveArg(args, 'value', ctx)).length;
      const min = args.min !== undefined ? toNumber(resolveArg(args, 'min', ctx)) : undefined;
      const max = args.max !== undefined ? toNumber(resolveArg(args, 'max', ctx)) : undefined;
      if (min !== undefined && v < min) return false;
      if (max !== undefined && v > max) return false;
      return true;
    }
    case 'numeric': {
      const v = resolveArg(args, 'value', ctx);
      const n = typeof v === 'number' ? v : Number(toDisplayString(v));
      if (!Number.isFinite(n)) return false;
      const min = args.min !== undefined ? toNumber(resolveArg(args, 'min', ctx)) : undefined;
      const max = args.max !== undefined ? toNumber(resolveArg(args, 'max', ctx)) : undefined;
      if (min !== undefined && n < min) return false;
      if (max !== undefined && n > max) return false;
      return true;
    }
    case 'and': {
      const values = args.values;
      const list = Array.isArray(values) ? values : [values];
      return list.every((v) => Boolean(resolveDynamic(v, ctx)));
    }
    case 'or': {
      const values = args.values;
      const list = Array.isArray(values) ? values : [values];
      return list.some((v) => Boolean(resolveDynamic(v, ctx)));
    }
    case 'not':
      return !resolveArg(args, 'value', ctx);
    case 'formatString':
      return interpolate(toDisplayString(resolveArg(args, 'value', ctx)), ctx);
    case 'formatNumber': {
      const n = toNumber(resolveArg(args, 'value', ctx));
      const decimals = args.decimals !== undefined ? toNumber(resolveArg(args, 'decimals', ctx)) : undefined;
      return new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals ?? 20,
      }).format(n);
    }
    case 'formatCurrency': {
      const n = toNumber(resolveArg(args, 'value', ctx));
      const currency = toDisplayString(resolveArg(args, 'currency', ctx)) || 'CNY';
      try {
        return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(n);
      } catch {
        return String(n);
      }
    }
    case 'formatDate': {
      const pattern = toDisplayString(resolveArg(args, 'format', ctx)) || 'yyyy-MM-dd';
      return formatDateTokens(resolveArg(args, 'value', ctx), pattern);
    }
    case 'pluralize': {
      const n = toNumber(resolveArg(args, 'value', ctx));
      const one = toDisplayString(resolveArg(args, 'one', ctx));
      const other = toDisplayString(resolveArg(args, 'other', ctx));
      return n === 1 ? one : other || one;
    }
    case 'openUrl': {
      const url = toDisplayString(resolveArg(args, 'url', ctx));
      if (url) window.open(url, '_blank');
      return '';
    }
    case 'now':
      return new Date().toISOString();
    case 'upper':
      return toDisplayString(resolveArg(args, 'value', ctx)).toUpperCase();
    case 'lower':
      return toDisplayString(resolveArg(args, 'value', ctx)).toLowerCase();
    case 'add': {
      const values = Array.isArray(args.values) ? args.values : Object.values(args);
      return values.reduce((sum, v) => sum + toNumber(resolveDynamic(v, ctx)), 0);
    }
    case 'concat': {
      const values = Array.isArray(args.values) ? args.values : Object.values(args);
      return values.map((v) => toDisplayString(resolveDynamic(v, ctx))).join('');
    }
    default:
      console.warn(`[a2ui] unknown function: ${call}`);
      return '';
  }
}

/** formatString 模板插值：${/abs/path}、${relativePath}、${fn(arg:${/path}, k:'v')} */
export function interpolate(template: string, ctx: EvalCtx): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf('${', i);
    if (start === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, start);
    // 转义 \${ → 字面 ${
    if (start > 0 && template[start - 1] === '\\') {
      out = out.slice(0, -1) + '${';
      i = start + 2;
      continue;
    }
    const end = findMatchingBrace(template, start + 2);
    if (end === -1) {
      out += template.slice(start);
      break;
    }
    out += toDisplayString(evalExpression(template.slice(start + 2, end).trim(), ctx));
    i = end + 1;
  }
  return out;
}

function findMatchingBrace(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** ${...} 内部表达式：函数调用（含命名参数）或纯路径 */
function evalExpression(expr: string, ctx: EvalCtx): unknown {
  const callMatch = expr.match(/^([A-Za-z_]\w*)\((.*)\)$/s);
  if (!callMatch) {
    // 纯路径（绝对 / 开头，相对由 resolvePath 内部按作用域处理——
    // 注意此处拿到的一定是完整路径，相对性已在 joinPath 层拼好）
    return ctx.resolvePath(expr);
  }
  const [, name, argsText] = callMatch;
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(argsText)) {
    if (!part) continue;
    const kv = splitNamedArg(part);
    if (kv) {
      args[kv[0]] = parseArgValue(kv[1], ctx);
    } else {
      args.value = parseArgValue(part, ctx);
    }
  }
  return evalFunction(name, args, ctx);
}

/** 按顶层逗号切分（跳过引号、括号与 ${} 嵌套） */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '(' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ')' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 命名参数 k:v（冒号不在引号/嵌套内） */
function splitNamedArg(s: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === ':' && depth === 0) {
      const key = s.slice(0, i).trim();
      if (/^[A-Za-z_]\w*$/.test(key)) return [key, s.slice(i + 1).trim()];
      return null;
    }
  }
  return null;
}

/** 参数值：引号字符串 / 数字 / 布尔 / ${...} 嵌套表达式 / 裸词按字符串 */
function parseArgValue(s: string, ctx: EvalCtx): unknown {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  if (t.startsWith('${') && t.endsWith('}')) {
    return evalExpression(t.slice(2, -1).trim(), ctx);
  }
  return t;
}

/** 校验清单求值：返回首个失败项的 message；全过返回 ok */
export function evalChecks(checks: unknown, ctx: EvalCtx): { ok: boolean; message?: string } {
  if (!Array.isArray(checks) || checks.length === 0) return { ok: true };
  for (const raw of checks as A2uiCheck[]) {
    // 两种形态：{"call","args","message"} 或 {"condition":{"call","args"},"message"}
    const call = raw.call ?? raw.condition?.call;
    const args = raw.args ?? raw.condition?.args ?? {};
    if (!call) continue;
    const passed = Boolean(evalFunction(call, args, ctx));
    if (!passed) return { ok: false, message: raw.message ?? '校验未通过' };
  }
  return { ok: true };
}
