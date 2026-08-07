import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Copy, Download, Check, AlignLeft, GitBranch,
  AlertCircle, ChevronsDownUp, ChevronsUpDown, Eraser,
} from 'lucide-react';
import {
  parse as parseJsonc, format as formatJsonc, applyEdits,
  type ParseErrorCode, type ParseError,
} from 'jsonc-parser';
import { Tooltip } from '@/components/Tooltip';
import { usePluginPayload } from '@/plugins/usePluginPayload';
import { useToastStore } from '@/stores/toastStore';
import { WINDOW_SIZE } from '../../constants/window';
import { immediateResize } from '../../utils/tauri';
import { JsonTreeView } from './JsonTreeView';
import { renderJsonToCanvas } from './jsonCanvas';
import { JsonExportPreviewModal } from './JsonExportPreviewModal';
import jsonFormatterPlugin from './plugin';
import { useJsonFormatterStore } from './store';

type DisplayMode = 'tree' | 'text';

interface ParseErrorInfo {
  message: string;
  offset: number;
}

// jsonc-parser 的错误枚举面向开发者（英文），这里映射为面向用户的中文描述。
// ParseErrorCode 是 const enum，verbatimModuleSyntax 下不能运行时访问，
// 故 key 用其数值字面量（1..16 与枚举声明顺序一致）。
const PARSE_ERROR_ZH: Partial<Record<ParseErrorCode, string>> = {
  1: '包含无效符号',        // InvalidSymbol
  2: '数字格式无效',        // InvalidNumberFormat
  3: '缺少属性名',          // PropertyNameExpected
  4: '缺少值',              // ValueExpected
  5: '缺少冒号',            // ColonExpected
  6: '缺少逗号',            // CommaExpected
  7: '缺少右大括号 }',      // CloseBraceExpected
  8: '缺少右方括号 ]',      // CloseBracketExpected
  9: 'JSON 结束后存在多余内容', // EndOfFileExpected
  10: '注释格式无效',       // InvalidCommentToken
  11: '注释未闭合',         // UnexpectedEndOfComment
  12: '字符串未闭合',       // UnexpectedEndOfString
  13: '数字不完整',         // UnexpectedEndOfNumber
  14: 'Unicode 转义无效',   // InvalidUnicode
  15: '转义字符无效',       // InvalidEscapeCharacter
  16: '包含无效字符',       // InvalidCharacter
};

// 把字符偏移换算成用户能理解的「第 N 行第 M 列」
function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

// ─── 共享编辑器：只读行号 gutter + textarea ─────────────────────────────────
// banner 承诺「第 N 行第 M 列」，编辑面必须提供可见的坐标系。
interface JsonEditorProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  gutterRef: React.Ref<HTMLDivElement>;
  highlightLine: number | null;
  onScroll: () => void;
}

function JsonEditor({
  value, onChange, autoFocus, textareaRef, gutterRef, highlightLine, onScroll,
}: JsonEditorProps) {
  const lineCount = value.split('\n').length;
  return (
    <div className="flex h-full min-h-0">
      {/* 行号 gutter：只读、对读屏隐藏；行高与 textarea 的 leading-relaxed 对齐 */}
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="flex-shrink-0 overflow-hidden text-right select-none
                   pl-3 pr-2 pt-4 text-sm font-mono leading-relaxed tabular-nums
                   text-app-text-placeholder"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div
            key={i}
            className={highlightLine === i + 1
              ? 'bg-white/10 text-app-text-primary rounded-sm -mx-1 px-1'
              : undefined}
          >
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onScroll={onScroll}
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder="在此粘贴或输入 JSON…"
        className="flex-1 h-full bg-transparent text-sm font-mono text-app-text-secondary
                   placeholder:text-app-text-placeholder
                   resize-none outline-none p-4 pl-2 leading-relaxed"
      />
    </div>
  );
}

export function JsonFormatterView() {
  // 工作文本归插件自有 store（跨视图切换存活）；打开载荷只负责注入
  const { text: jsonText, setText: setJsonText } = useJsonFormatterStore();
  const { addToast } = useToastStore();

  // 打开载荷（粘贴 JSON 联动 / '@json' trigger）：注入即解析，形状为 string
  usePluginPayload(jsonFormatterPlugin.id, useCallback((payload: unknown) => {
    if (typeof payload === 'string') setJsonText(payload);
  }, [setJsonText]));

  const [displayMode, setDisplayMode] = useState<DisplayMode>('tree');
  const [parsedJson, setParsedJson] = useState<unknown>(null);
  const [parseError, setParseError] = useState<ParseErrorInfo | null>(null);
  const [rawText, setRawText] = useState('');
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewData, setPreviewData] = useState<{ imageDataUrl: string; filename: string } | null>(null);

  // 文本视图 textarea 引用 + 错误定位跳转目标（点击错误 banner 时置位；
  // 用 state 而非 ref：已在文本视图时点 banner 也要能触发定位）
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);
  // 定位后目标行行号短暂高亮（在 gutter 上确认「第 N 行」）
  const [highlightLine, setHighlightLine] = useState<number | null>(null);

  // Tree expand/collapse state: defaultExpanded controls initial state of all nodes;
  // treeKey forces a re-mount (clearing per-node overrides) when all-expand/collapse is triggered.
  const [treeDefaultExpanded, setTreeDefaultExpanded] = useState(true);
  const [treeKey, setTreeKey] = useState(0);

  // Parse JSON data on mount or when data changes
  useEffect(() => {
    const data = jsonText ?? '';
    setRawText(data);

    if (!data.trim()) {
      setParsedJson(null);
      setParseError(null);
      return;
    }

    // Use jsonc-parser so JSON with comments (JSONC) and trailing commas is accepted
    const errors: ParseError[] = [];
    const parsed = parseJsonc(data, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length === 0 && parsed !== undefined) {
      setParsedJson(parsed);
      setParseError(null);
    } else if (errors.length === 0) {
      // e.g. comment-only input: syntactically valid JSONC but no value
      setParsedJson(null);
      setParseError({ message: '内容中没有有效的 JSON 数据', offset: 0 });
    } else {
      const first = errors[0];
      const { line, col } = offsetToLineCol(data, first.offset);
      setParsedJson(null);
      setParseError({
        message: `${PARSE_ERROR_ZH[first.error] ?? '语法错误'}（第 ${line} 行第 ${col} 列）`,
        offset: first.offset,
      });
    }
  }, [jsonText]);

  // Resize window to fit content
  useEffect(() => {
    immediateResize(WINDOW_SIZE.JSON_FORMATTER.height, WINDOW_SIZE.JSON_FORMATTER.width);
  }, []);

  // Format while preserving comments: jsonc-parser's format() returns edits
  // applied onto the original text, so comments survive reformatting.
  const formattedText = useMemo(() => {
    if (parsedJson === null) return rawText;
    const edits = formatJsonc(rawText, undefined, { tabSize: 2, insertSpaces: true });
    return applyEdits(rawText, edits);
  }, [parsedJson, rawText]);

  // 切到文本视图 = 一次性格式化（显式动作）。之后 textarea 始终绑定 rawText，
  // 编辑期间不做实时重排——否则有效 JSON 中间的换行会被 formatter 抹掉、
  // 光标跳文末，编辑器不可信。
  const handleSwitchToText = useCallback(() => {
    if (parsedJson !== null) {
      const edits = formatJsonc(rawText, undefined, { tabSize: 2, insertSpaces: true });
      const formatted = applyEdits(rawText, edits);
      if (formatted !== rawText) {
        setRawText(formatted);
        setJsonText(formatted);
      }
    }
    setDisplayMode('text');
  }, [parsedJson, rawText, setJsonText]);

  // 点击错误 banner：切到文本视图并把光标放到出错偏移处
  const handleErrorJump = useCallback(() => {
    if (!parseError) return;
    setJumpTarget(parseError.offset);
    setDisplayMode('text');
  }, [parseError]);

  useEffect(() => {
    if (displayMode !== 'text' || jumpTarget === null) return;
    const el = textareaRef.current;
    if (!el) return;
    const pos = Math.min(jumpTarget, el.value.length);
    setJumpTarget(null);
    el.focus();
    el.setSelectionRange(pos, pos);
    // 目标行行号短暂高亮，在 gutter 上确认「第 N 行」
    const { line } = offsetToLineCol(el.value, pos);
    setHighlightLine(line);
    const timer = setTimeout(() => setHighlightLine(null), 2000);
    return () => clearTimeout(timer);
  }, [displayMode, jumpTarget]);

  // gutter 跟随 textarea 滚动
  const syncGutterScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  // ── Toolbar actions ────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    // 树视图复制格式化结果（模块的「格式化」承诺）；
    // 文本视图复制 rawText，所见即所得（用户编辑后的内容不被重排）。
    const text = displayMode === 'text' ? rawText : formattedText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      addToast({
        type: 'error',
        title: '复制失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [displayMode, rawText, formattedText, addToast]);

  const handleExportImage = useCallback(() => {
    if (parsedJson === null) return;
    setExporting(true);
    try {
      const canvas = renderJsonToCanvas(
        parsedJson as Record<string, unknown> | unknown[],
        2,
      );
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      setPreviewData({
        imageDataUrl: canvas.toDataURL('image/png'),
        filename: `json-${timestamp}.png`,
      });
    } catch (err) {
      // 超限内容（行数超画布纹理上限等）必须明确失败并给出替代路径，
      // 不能静默产出空白/截断图。
      addToast({
        type: 'error',
        title: '无法导出图片',
        message: `${err instanceof Error ? err.message : String(err)}，请改用「复制」导出文本`,
      });
    } finally {
      setExporting(false);
    }
  }, [parsedJson, addToast]);

  const handleExpandAll = useCallback(() => {
    setTreeDefaultExpanded(true);
    setTreeKey(k => k + 1);
  }, []);

  const handleCollapseAll = useCallback(() => {
    setTreeDefaultExpanded(false);
    setTreeKey(k => k + 1);
  }, []);

  // 清空全部内容（残留数据的显式出口）
  const handleClear = useCallback(() => {
    setRawText('');
    setJsonText('');
  }, [setJsonText]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setRawText(val);
    setJsonText(val);
  }, [setJsonText]);

  // ── Rendering ──────────────────────────────────────────────────────────────

  const hasContent = !!(parsedJson ?? rawText);

  return (
    <div
      className="flex flex-col h-full text-app-text-secondary panel-glass"
    >
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border flex-shrink-0">

        {/* View mode toggle */}
        <div className="flex items-center bg-app-bg-tertiary rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => setDisplayMode('tree')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              displayMode === 'tree'
                ? 'bg-white/10 text-app-text-primary'
                : 'text-app-text-tertiary hover:text-app-text-primary'
            }`}
          >
            <GitBranch className="w-3 h-3" />
            树状视图
          </button>
          <button
            onClick={handleSwitchToText}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              displayMode === 'text'
                ? 'bg-white/10 text-app-text-primary'
                : 'text-app-text-tertiary hover:text-app-text-primary'
            }`}
          >
            <AlignLeft className="w-3 h-3" />
            文本视图
          </button>
        </div>

        {/* Expand / Collapse all — icon-only in tree mode with valid JSON;
            tooltip carries the name, so it adds information instead of repeating a label */}
        {displayMode === 'tree' && parsedJson !== null && (
          <>
            <div className="w-px h-4 bg-app-border" />
            <Tooltip content="展开全部" placement="bottom">
              <button
                onClick={handleExpandAll}
                aria-label="展开全部"
                className="flex items-center p-1.5 rounded-md text-app-text-tertiary
                           hover:text-app-text-primary hover:bg-white/5 transition-colors"
              >
                <ChevronsUpDown className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="折叠全部" placement="bottom">
              <button
                onClick={handleCollapseAll}
                aria-label="折叠全部"
                className="flex items-center p-1.5 rounded-md text-app-text-tertiary
                           hover:text-app-text-primary hover:bg-white/5 transition-colors"
              >
                <ChevronsDownUp className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </>
        )}

        <div className="flex-1" />

        {/* Copy — the primary action of this module (see/steal the JSON) */}
        <button
          onClick={handleCopy}
          disabled={!hasContent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                     bg-app-status-info hover:bg-blue-700 text-white
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copied
            ? <Check className="w-3.5 h-3.5" />
            : <Copy className="w-3.5 h-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>

        {/* Export image — secondary action */}
        <button
          onClick={handleExportImage}
          disabled={exporting || parsedJson === null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                     bg-app-bg-tertiary hover:bg-app-bg-elevated text-app-text-secondary
                     hover:text-app-text-primary transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5" />
          导出图片
        </button>

        {/* Clear — explicit exit for stale content */}
        <Tooltip content="清空内容" placement="bottom">
          <button
            onClick={handleClear}
            disabled={!hasContent}
            aria-label="清空内容"
            className="flex items-center p-1.5 rounded-md text-app-text-tertiary
                       hover:text-red-400 hover:bg-white/5 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Eraser className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* ── Export preview modal ──────────────────────────────────────────── */}
      {previewData && (
        <JsonExportPreviewModal
          imageDataUrl={previewData.imageDataUrl}
          defaultFilename={previewData.filename}
          onClose={() => setPreviewData(null)}
        />
      )}

      {/* ── Parse error banner（点击跳转到出错位置） ──────────────────────── */}
      {parseError && (
        <button
          onClick={handleErrorJump}
          className="flex items-center gap-2 px-4 py-1.5 bg-red-900/30 w-full text-left
                     border-b border-red-800/50 text-red-300 text-xs flex-shrink-0
                     hover:bg-red-900/45 transition-colors"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>JSON 解析错误:{parseError.message}</span>
          <span className="ml-auto flex-shrink-0 text-red-300/80">点击定位 →</span>
        </button>
      )}

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0">

        {/* Tree view — valid JSON */}
        {displayMode === 'tree' && parsedJson !== null && (
          <JsonTreeView
            key={treeKey}
            data={parsedJson as Record<string, unknown> | unknown[]}
            defaultExpanded={treeDefaultExpanded}
          />
        )}

        {/* Tree view — no valid JSON yet (empty or parse error): editable textarea.
            空态直接给输入框而不是「请在此输入」的死屏文案——说到做到。 */}
        {displayMode === 'tree' && parsedJson === null && (
          <JsonEditor
            value={rawText}
            onChange={handleTextChange}
            autoFocus
            textareaRef={textareaRef}
            gutterRef={gutterRef}
            highlightLine={highlightLine}
            onScroll={syncGutterScroll}
          />
        )}

        {/* Text view — always binds rawText: no live reformatting while editing */}
        {displayMode === 'text' && (
          <JsonEditor
            value={rawText}
            onChange={handleTextChange}
            textareaRef={textareaRef}
            gutterRef={gutterRef}
            highlightLine={highlightLine}
            onScroll={syncGutterScroll}
          />
        )}
      </div>
    </div>
  );
}
