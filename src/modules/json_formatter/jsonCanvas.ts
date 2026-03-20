/**
 * Canvas-based JSON tree renderer for image export.
 *
 * Bypasses html-to-image (which fails in Tauri/WebView2 due to SVG foreignObject
 * + external CSS inlining issues) and draws the JSON tree directly via Canvas API.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

interface FlatLine {
  lineNum: number;
  indent: number;
  key: string | null;
  keyIsIndex: boolean;
  nodeType: NodeType;
  isExpandable: boolean;
  childCount: number;
  primitiveValue?: string | number | boolean | null;
  isClosingBracket: boolean;
  closingChar: '}' | ']' | '';
  addComma: boolean;
}

// ─── Flatten (always fully expanded) ─────────────────────────────────────────

function getNodeType(value: unknown): NodeType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'object';
}

function flatten(
  value: unknown,
  indent: number,
  key: string | null,
  keyIsIndex: boolean,
  addComma: boolean,
  out: FlatLine[],
): void {
  const nodeType = getNodeType(value);

  if (nodeType !== 'object' && nodeType !== 'array') {
    out.push({
      lineNum: 0, indent, key, keyIsIndex, nodeType,
      isExpandable: false, childCount: 0,
      primitiveValue: value as string | number | boolean | null,
      isClosingBracket: false, closingChar: '', addComma,
    });
    return;
  }

  const isArr = nodeType === 'array';
  const childCount = isArr
    ? (value as unknown[]).length
    : Object.keys(value as Record<string, unknown>).length;

  out.push({
    lineNum: 0, indent, key, keyIsIndex, nodeType,
    isExpandable: true, childCount,
    isClosingBracket: false, closingChar: '', addComma: false,
  });

  if (isArr) {
    const arr = value as unknown[];
    arr.forEach((item, i) =>
      flatten(item, indent + 1, String(i), true, i < arr.length - 1, out));
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.forEach(([k, v], i) =>
      flatten(v, indent + 1, k, false, i < entries.length - 1, out));
  }

  out.push({
    lineNum: 0, indent, key: null, keyIsIndex: false, nodeType,
    isExpandable: false, childCount: 0,
    isClosingBracket: true, closingChar: isArr ? ']' : '}', addComma,
  });
}

// ─── Color palette (mirrors Tailwind classes used in JsonTreeView) ────────────

const C = {
  bg:         '#18181b', // zinc-900
  lineNum:    '#52525b', // zinc-600
  keyObj:     '#7dd3fc', // sky-300
  keyIdx:     '#71717a', // zinc-500
  sep:        '#71717a', // zinc-500
  bracket:    '#a1a1aa', // zinc-400
  valString:  '#6ee7b7', // emerald-300
  valNumber:  '#fcd34d', // amber-300
  valBoolean: '#c4b5fd', // violet-400
  valNull:    '#71717a', // zinc-500
  comma:      '#71717a', // zinc-500
};

// ─── Layout constants ─────────────────────────────────────────────────────────

const LINE_H    = 26;   // px — matches leading-[1.65rem] at 16px base
const FONT_PX   = 14;   // px — text-sm
const HINT_PX   = 12;   // px — text-xs (line numbers)
const INDENT_PX = 16;   // px per indent level (2 monospace chars)
const PAD_Y     = 8;    // px top/bottom padding
const CANVAS_W  = 800;  // px — matches app window width
const PAD_LN_L  = 12;   // px — pl-3
const PAD_LN_R  = 16;   // px — pr-4

const MONO = 'ui-monospace, "Cascadia Code", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const FONT      = `${FONT_PX}px ${MONO}`;
const HINT_FONT = `${HINT_PX}px ${MONO}`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render the full (always-expanded) JSON tree to an HTMLCanvasElement.
 * Returns the canvas; caller can call `.toDataURL('image/png')`.
 */
export function renderJsonToCanvas(
  data: Record<string, unknown> | unknown[],
  pixelRatio = 2,
): HTMLCanvasElement {
  // Build flat line list
  const lines: FlatLine[] = [];
  flatten(data, 0, null, false, false, lines);
  lines.forEach((l, i) => { l.lineNum = i + 1; });

  // Measure one monospace character to size the line-number column
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = FONT;
  const charW = probe.measureText('0').width;
  const digits = Math.max(3, String(lines.length).length);
  const lineNumCol = PAD_LN_L + Math.ceil((digits + 1) * charW) + PAD_LN_R;

  const totalH = PAD_Y * 2 + lines.length * LINE_H;

  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_W * pixelRatio;
  canvas.height = totalH   * pixelRatio;

  const ctx = canvas.getContext('2d')!;
  ctx.scale(pixelRatio, pixelRatio);

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CANVAS_W, totalH);
  ctx.textBaseline = 'middle';

  lines.forEach((line, i) => {
    const midY = PAD_Y + i * LINE_H + LINE_H / 2;

    // ── Line number ─────────────────────────────────────────────────────────
    ctx.font = HINT_FONT;
    ctx.fillStyle = C.lineNum;
    ctx.textAlign = 'right';
    ctx.fillText(String(line.lineNum), lineNumCol - PAD_LN_R, midY);
    ctx.textAlign = 'left';
    ctx.font = FONT;

    // ── Content ─────────────────────────────────────────────────────────────
    let x = lineNumCol + line.indent * INDENT_PX;

    const put = (text: string, color: string, small = false): void => {
      ctx.font = small ? HINT_FONT : FONT;
      ctx.fillStyle = color;
      ctx.fillText(text, x, midY);
      x += ctx.measureText(text).width;
      if (small) ctx.font = FONT;
    };

    if (line.isClosingBracket) {
      put(line.closingChar, C.bracket);
    } else {
      // Key
      if (line.key !== null) {
        put(line.key, line.keyIsIndex ? C.keyIdx : C.keyObj);
        put(': ', C.sep);
      }
      // Opening bracket (expandable) or leaf value
      if (line.isExpandable) {
        put(line.nodeType === 'object' ? '{' : '[', C.bracket);
      } else {
        switch (line.nodeType) {
          case 'string':
            put(`"${String(line.primitiveValue)}"`, C.valString);
            break;
          case 'number':
            put(String(line.primitiveValue), C.valNumber);
            break;
          case 'boolean':
            put(String(line.primitiveValue), C.valBoolean);
            break;
          default:
            put('null', C.valNull);
        }
      }
    }

    if (line.addComma) put(',', C.comma);
  });

  return canvas;
}
