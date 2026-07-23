import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

interface FlatLine {
  id: string;
  path: string;
  parentPath: string | null; // nearest expandable ancestor; null for root
  lineNum: number;
  indent: number;
  key: string | null;    // null = no key (root / closing bracket)
  keyIsIndex: boolean;   // true for array element numeric index
  nodeType: NodeType;
  // expandable only
  isExpandable: boolean;
  isExpanded: boolean;
  childCount: number;
  // leaf only
  primitiveValue?: string | number | boolean | null;
  // closing bracket only
  isClosingBracket: boolean;
  closingChar: '}' | ']' | '';
  // trailing comma
  addComma: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNodeType(value: unknown): NodeType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'object';
}

// ─── Flatten JSON into a renderable line list ─────────────────────────────────

function flatten(
  value: unknown,
  path: string,
  parentPath: string | null,
  key: string | null,
  keyIsIndex: boolean,
  indent: number,
  addComma: boolean,
  expandState: Record<string, boolean>,
  defaultExpanded: boolean,
  out: FlatLine[],
): void {
  const nodeType = getNodeType(value);

  // ── Leaf value ──────────────────────────────────────────────────────────────
  if (nodeType !== 'object' && nodeType !== 'array') {
    out.push({
      id: `v:${path}`,
      path, parentPath, lineNum: 0, indent, key, keyIsIndex, nodeType,
      isExpandable: false, isExpanded: false, childCount: 0,
      primitiveValue: value as string | number | boolean | null,
      isClosingBracket: false, closingChar: '', addComma,
    });
    return;
  }

  // ── Expandable node ─────────────────────────────────────────────────────────
  const isArr = nodeType === 'array';
  const isExpanded = expandState[path] ?? defaultExpanded;
  const childCount = isArr
    ? (value as unknown[]).length
    : Object.keys(value as Record<string, unknown>).length;

  out.push({
    id: `o:${path}`, path, parentPath, lineNum: 0, indent, key, keyIsIndex, nodeType,
    isExpandable: true, isExpanded, childCount,
    isClosingBracket: false, closingChar: '',
    addComma: isExpanded ? false : addComma,
  });

  if (!isExpanded) return;

  // ── Children ────────────────────────────────────────────────────────────────
  if (isArr) {
    const arr = value as unknown[];
    arr.forEach((item, i) =>
      flatten(
        item, `${path}[${i}]`, path, String(i), true, indent + 1,
        i < arr.length - 1, expandState, defaultExpanded, out,
      ));
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.forEach(([k, v], i) =>
      flatten(
        v, `${path}.${k}`, path, k, false, indent + 1,
        i < entries.length - 1, expandState, defaultExpanded, out,
      ));
  }

  // ── Closing bracket ─────────────────────────────────────────────────────────
  out.push({
    id: `c:${path}`, path, parentPath: path, lineNum: 0, indent,
    key: null, keyIsIndex: false, nodeType,
    isExpandable: false, isExpanded: false, childCount: 0,
    isClosingBracket: true, closingChar: isArr ? ']' : '}', addComma,
  });
}

// ─── Single line renderer ─────────────────────────────────────────────────────

// 行首固定列单 chevron（展开时旋转 90°），宽度 = 一级缩进（2ch）——
// 所有行内容起点 = 行号 + 2ch + indent×2ch，expandable 与 leaf 严格对齐，
// 层级完全由 indent 表达，chevron 整齐成列。
function ExpandChevron({
  path, isExpanded, onToggle,
}: {
  path: string;
  isExpanded: boolean;
  onToggle: (path: string, current: boolean) => void;
}) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onToggle(path, isExpanded); }}
      aria-label={isExpanded ? '折叠' : '展开'}
      // 键盘主通道是 treeitem 行焦点（←/→/Enter），chevron 仅作鼠标补充，
      // 故不进 Tab 序列（W3C treeview 惯例：交互集中在 treeitem）。
      tabIndex={-1}
      className="w-[2ch] inline-flex items-center justify-center align-middle
                 text-zinc-500 hover:text-zinc-200 transition-colors select-none"
    >
      <ChevronRight
        className={`w-3 h-3 motion-safe:transition-transform motion-safe:duration-150 ${
          isExpanded ? 'rotate-90' : ''
        }`}
      />
    </button>
  );
}

function TypeHint({ nodeType, childCount }: { nodeType: NodeType; childCount: number }) {
  return (
    <>
      <span className="text-zinc-500 text-xs">
        {nodeType === 'object' ? 'Object{' : 'Array['}
      </span>
      <span className="text-amber-400 text-xs font-semibold">{childCount}</span>
      <span className="text-zinc-500 text-xs">
        {nodeType === 'object' ? '}' : ']'}
      </span>
    </>
  );
}

interface LineRowProps {
  line: FlatLine;
  lineNumDigits: number;
  focused: boolean;
  onToggle: (path: string, current: boolean) => void;
  onFocus: (id: string) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

function LineRow({ line, lineNumDigits, focused, onToggle, onFocus, registerRef }: LineRowProps) {
  return (
    <div
      ref={el => registerRef(line.id, el)}
      role="treeitem"
      aria-level={line.indent + 1}
      aria-expanded={line.isExpandable ? line.isExpanded : undefined}
      tabIndex={focused ? 0 : -1}
      onFocus={() => onFocus(line.id)}
      className="flex items-baseline hover:bg-white/[0.03] focus:bg-white/[0.06] focus:outline-none
                 group leading-[1.65rem] min-h-[1.65rem]"
    >
      {/* ── Line number（对读屏隐藏：孤立数字无语义，只造噪音） ────────────── */}
      <span
        aria-hidden="true"
        className="flex-shrink-0 text-right text-app-text-placeholder group-hover:text-app-text-tertiary
                   select-none pr-4 pl-3 tabular-nums text-xs"
        style={{ minWidth: `${lineNumDigits + 3}ch` }}
      >
        {line.lineNum}
      </span>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {/* 注意：这里不能用 flex 布局——flex 容器会丢弃「仅含空白的文本节点」，
          indent 空格会被整个吃掉（曾导致层级缩进全失）。保持纯文本流，
          chevron/占位用 inline-block 控宽。 */}
      <span className="flex-1 whitespace-pre font-mono text-sm">
        {/* chevron 固定列（行号后、indent 前）；leaf/closing 行同宽占位，
            所有行内容起点 = 2ch + indent×2ch，严格对齐 */}
        {line.isExpandable
          ? <ExpandChevron path={line.path} isExpanded={line.isExpanded} onToggle={onToggle} />
          : <span className="inline-block w-[2ch]" />}
        {'  '.repeat(line.indent)}

        {/* ── Closing bracket ──────────────────────────────────────────── */}
        {line.isClosingBracket && (
          <span className="text-zinc-400">{line.closingChar}</span>
        )}

        {/* ── Key ──────────────────────────────────────────────────────── */}
        {!line.isClosingBracket && line.key !== null && (
          <>
            <span className={line.keyIsIndex ? 'text-app-text-tertiary' : 'text-sky-300'}>
              {line.key}
            </span>
            <span className="text-zinc-500">{': '}</span>
          </>
        )}

        {/* ── Type hint (collapsed only) or opening bracket (expanded only) ── */}
        {line.isExpandable && (
          <>
            {line.isExpanded
              ? <span className="text-zinc-400">{line.nodeType === 'object' ? '{' : '['}</span>
              : <TypeHint nodeType={line.nodeType} childCount={line.childCount} />
            }
          </>
        )}

        {/* ── Leaf value ───────────────────────────────────────────────── */}
        {!line.isExpandable && !line.isClosingBracket && (() => {
          switch (line.nodeType) {
            case 'string':
              return <span className="text-emerald-300">"{String(line.primitiveValue)}"</span>;
            case 'number':
              return <span className="text-amber-300">{String(line.primitiveValue)}</span>;
            case 'boolean':
              return <span className="text-violet-400">{String(line.primitiveValue)}</span>;
            default:
              // null 是数据内容不是装饰，与下标同档（zinc-500 3.08:1 不达正文标准）
              return <span className="text-app-text-tertiary">null</span>;
          }
        })()}

        {/* ── Trailing comma ───────────────────────────────────────────── */}
        {line.addComma && <span className="text-zinc-500">,</span>}
      </span>
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface JsonTreeViewProps {
  data: Record<string, unknown> | unknown[];
  defaultExpanded?: boolean;
}

export function JsonTreeView({ data, defaultExpanded = true }: JsonTreeViewProps) {
  const [expandState, setExpandState] = useState<Record<string, boolean>>({});
  // Roving tabindex：记录键盘焦点所在行；null = 尚未键盘导航（Tab 进入时落在第一行）
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const lines = useMemo(() => {
    const out: FlatLine[] = [];
    flatten(data, 'root', null, null, false, 0, false, expandState, defaultExpanded, out);
    // Assign sequential 1-based line numbers after flatten
    out.forEach((l, i) => { l.lineNum = i + 1; });
    return out;
  }, [data, expandState, defaultExpanded]);

  const activeId = focusedId ?? lines[0]?.id ?? null;

  // 键盘导航引发的焦点移动统一在这里落到 DOM（展开后新行渲染完成再聚焦）。
  // focusedId 为 null（纯鼠标使用）时不抢焦点。
  useEffect(() => {
    if (focusedId == null) return;
    rowRefs.current.get(focusedId)?.focus();
  }, [focusedId, lines]);

  const toggle = useCallback((path: string, current: boolean) => {
    setExpandState(prev => ({ ...prev, [path]: !current }));
  }, []);

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  const handleFocus = useCallback((id: string) => {
    setFocusedId(id);
  }, []);

  // W3C treeview 键位：↑/↓ 移动，→ 展开/进子行，← 折叠/回父行，Enter/Space 切换
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const idx = lines.findIndex(l => l.id === activeId);
    if (idx < 0) return;
    const line = lines[idx];

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (idx < lines.length - 1) setFocusedId(lines[idx + 1].id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (idx > 0) setFocusedId(lines[idx - 1].id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (line.isExpandable && !line.isExpanded) toggle(line.path, line.isExpanded);
        else if (line.isExpandable && idx < lines.length - 1) setFocusedId(lines[idx + 1].id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (line.isExpandable && line.isExpanded) {
          toggle(line.path, line.isExpanded);
        } else if (line.parentPath) {
          const pIdx = lines.findIndex(l => l.path === line.parentPath && l.isExpandable);
          if (pIdx >= 0) setFocusedId(lines[pIdx].id);
        }
        break;
      case 'Enter':
      case ' ':
        if (line.isExpandable) {
          e.preventDefault();
          toggle(line.path, line.isExpanded);
        }
        break;
    }
  }, [lines, activeId, toggle]);

  const lineNumDigits = String(lines.length).length;

  return (
    <div
      role="tree"
      aria-label="JSON 结构"
      onKeyDown={handleKeyDown}
      className="font-mono text-sm select-text py-2"
    >
      {lines.map(line => (
        <LineRow
          key={line.id}
          line={line}
          lineNumDigits={lineNumDigits}
          focused={line.id === activeId}
          onToggle={toggle}
          onFocus={handleFocus}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}
