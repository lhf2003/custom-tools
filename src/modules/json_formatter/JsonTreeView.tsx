import { useState, useMemo, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

interface FlatLine {
  id: string;
  path: string;
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
      path, lineNum: 0, indent, key, keyIsIndex, nodeType,
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
    id: `o:${path}`, path, lineNum: 0, indent, key, keyIsIndex, nodeType,
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
        item, `${path}[${i}]`, String(i), true, indent + 1,
        i < arr.length - 1, expandState, defaultExpanded, out,
      ));
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.forEach(([k, v], i) =>
      flatten(
        v, `${path}.${k}`, k, false, indent + 1,
        i < entries.length - 1, expandState, defaultExpanded, out,
      ));
  }

  // ── Closing bracket ─────────────────────────────────────────────────────────
  out.push({
    id: `c:${path}`, path, lineNum: 0, indent,
    key: null, keyIsIndex: false, nodeType,
    isExpandable: false, isExpanded: false, childCount: 0,
    isClosingBracket: true, closingChar: isArr ? ']' : '}', addComma,
  });
}

// ─── Single line renderer ─────────────────────────────────────────────────────

// Root node = expandable, at indent 0, with no key (key === null)
const isRootOpen = (line: FlatLine) =>
  line.isExpandable && line.indent === 0 && line.key === null;

function ExpandIcon({
  path, isExpanded, onToggle,
}: {
  path: string;
  isExpanded: boolean;
  onToggle: (path: string, current: boolean) => void;
}) {
  return (
    <button
      onClick={() => onToggle(path, isExpanded)}
      className="text-zinc-500 hover:text-yellow-400 transition-colors font-bold select-none"
      tabIndex={-1}
    >
      {isExpanded ? '[-]' : '[+]'}
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

function LineRow({
  line,
  lineNumDigits,
  onToggle,
}: {
  line: FlatLine;
  lineNumDigits: number;
  onToggle: (path: string, current: boolean) => void;
}) {
  const root = isRootOpen(line);

  return (
    <div
      className="flex items-baseline hover:bg-white/[0.03] group leading-[1.65rem] min-h-[1.65rem]"
    >
      {/* ── Line number ──────────────────────────────────────────────────── */}
      <span
        className="flex-shrink-0 text-right text-zinc-600 group-hover:text-zinc-500
                   select-none pr-4 pl-3 tabular-nums text-xs"
        style={{ minWidth: `${lineNumDigits + 3}ch` }}
      >
        {line.lineNum}
      </span>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <span className="flex-1 whitespace-pre font-mono text-sm">
        {'  '.repeat(line.indent)}

        {/* Root node: [+]/[-] on the LEFT before everything else */}
        {root && (
          <><ExpandIcon path={line.path} isExpanded={line.isExpanded} onToggle={onToggle} />{' '}</>
        )}

        {/* ── Closing bracket ──────────────────────────────────────────── */}
        {line.isClosingBracket && (
          <span className="text-zinc-400">{line.closingChar}</span>
        )}

        {/* ── Key (for non-root nodes) ─────────────────────────────────── */}
        {!line.isClosingBracket && line.key !== null && (
          <>
            <span className={line.keyIsIndex ? 'text-zinc-500' : 'text-sky-300'}>
              {line.key}
            </span>
            <span className="text-zinc-500">{': '}</span>
          </>
        )}

        {/* Non-root expandable: [+]/[-] AFTER the colon */}
        {line.isExpandable && !root && (
          <><ExpandIcon path={line.path} isExpanded={line.isExpanded} onToggle={onToggle} />{' '}</>
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
              return <span className="text-zinc-500">null</span>;
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

  const lines = useMemo(() => {
    const out: FlatLine[] = [];
    flatten(data, 'root', null, false, 0, false, expandState, defaultExpanded, out);
    // Assign sequential 1-based line numbers after flatten
    out.forEach((l, i) => { l.lineNum = i + 1; });
    return out;
  }, [data, expandState, defaultExpanded]);

  const toggle = useCallback((path: string, current: boolean) => {
    setExpandState(prev => ({ ...prev, [path]: !current }));
  }, []);

  const lineNumDigits = String(lines.length).length;

  return (
    <div className="font-mono text-sm select-text py-2">
      {lines.map(line => (
        <LineRow
          key={line.id}
          line={line}
          lineNumDigits={lineNumDigits}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}
