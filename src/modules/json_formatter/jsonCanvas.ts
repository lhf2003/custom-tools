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
  bg:         '#1e1e21', // app-bg-primary（与界面树视图底色一致）
  lineNum:    '#9a9aa2', // app-text-placeholder（与界面行号一致）
  keyObj:     '#7dd3fc', // sky-300
  keyIdx:     '#a1a1aa', // app-text-tertiary（下标是内容，zinc-500 不达标）
  sep:        '#71717a', // zinc-500
  bracket:    '#a1a1aa', // zinc-400
  valString:  '#6ee7b7', // emerald-300
  valNumber:  '#fcd34d', // amber-300
  valBoolean: '#c4b5fd', // violet-400
  valNull:    '#a1a1aa', // app-text-tertiary（null 是内容，zinc-500 不达标）
  comma:      '#71717a', // zinc-500
};

// ─── Layout constants ─────────────────────────────────────────────────────────

const LINE_H    = 26;   // px — matches leading-[1.65rem] at 16px base
const FONT_PX   = 14;   // px — text-sm
const HINT_PX   = 12;   // px — text-xs (line numbers)
const INDENT_PX = 16;   // px per indent level (2 monospace chars)
const PAD_Y     = 8;    // px top/bottom padding
const PAD_LN_L  = 12;   // px — pl-3
const PAD_LN_R  = 16;   // px — pr-4

const MIN_CANVAS_W  = 800;    // px — matches app window width
const PAD_CONTENT_R = 16;     // px right padding after the widest line
// WebView2/Chromium canvas per-dimension texture limit. Exceeding it silently
// produces a blank/clipped image, so height is guarded with an explicit error.
const MAX_TEXTURE_PX = 16384;

const MONO = 'ui-monospace, "Cascadia Code", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const FONT      = `${FONT_PX}px ${MONO}`;
const HINT_FONT = `${HINT_PX}px ${MONO}`;

// ─── Line segments (shared by width measurement and drawing) ─────────────────

interface Segment {
  text: string;
  color: string;
}

function buildLineSegments(line: FlatLine): Segment[] {
  const segs: Segment[] = [];

  if (line.isClosingBracket) {
    segs.push({ text: line.closingChar, color: C.bracket });
  } else {
    if (line.key !== null) {
      segs.push({ text: line.key, color: line.keyIsIndex ? C.keyIdx : C.keyObj });
      segs.push({ text: ': ', color: C.sep });
    }
    if (line.isExpandable) {
      segs.push({ text: line.nodeType === 'object' ? '{' : '[', color: C.bracket });
    } else {
      switch (line.nodeType) {
        case 'string':
          segs.push({ text: `"${String(line.primitiveValue)}"`, color: C.valString });
          break;
        case 'number':
          segs.push({ text: String(line.primitiveValue), color: C.valNumber });
          break;
        case 'boolean':
          segs.push({ text: String(line.primitiveValue), color: C.valBoolean });
          break;
        default:
          segs.push({ text: 'null', color: C.valNull });
      }
    }
  }

  if (line.addComma) segs.push({ text: ',', color: C.comma });
  return segs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render the full (always-expanded) JSON tree to an HTMLCanvasElement.
 * Returns the canvas; caller can call `.toDataURL('image/png')`.
 * Throws when the content exceeds the canvas texture limit (too many lines) —
 * callers must surface that error instead of shipping a silently blank image.
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

  const maxDim = Math.floor(MAX_TEXTURE_PX / pixelRatio);

  // Guard the texture height limit: exceeding it silently blanks the image.
  const totalH = PAD_Y * 2 + lines.length * LINE_H;
  if (totalH > maxDim) {
    throw new Error(`内容过长（${lines.length} 行），超出图片画布上限`);
  }

  // Segments are built once and shared by width measurement and drawing.
  const rows = lines.map(line => ({ line, segs: buildLineSegments(line) }));

  // Canvas width follows the widest line. Like height, exceeding the texture
  // limit is an explicit error — silently clamping would crop long lines.
  let maxContentW = 0;
  for (const { line, segs } of rows) {
    let w = line.indent * INDENT_PX;
    for (const s of segs) w += probe.measureText(s.text).width;
    if (w > maxContentW) maxContentW = w;
  }
  const neededW = Math.ceil(lineNumCol + maxContentW + PAD_CONTENT_R);
  if (neededW > maxDim) {
    throw new Error(`存在超长行（约 ${Math.round(maxContentW / charW)} 字符），超出图片画布上限`);
  }
  const canvasW = Math.max(MIN_CANVAS_W, neededW);

  const canvas = document.createElement('canvas');
  canvas.width  = canvasW * pixelRatio;
  canvas.height = totalH  * pixelRatio;

  const ctx = canvas.getContext('2d')!;
  ctx.scale(pixelRatio, pixelRatio);

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, canvasW, totalH);
  ctx.textBaseline = 'middle';
  ctx.font = FONT;

  rows.forEach(({ line, segs }, i) => {
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
    for (const s of segs) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, x, midY);
      x += ctx.measureText(s.text).width;
    }
  });

  return canvas;
}
