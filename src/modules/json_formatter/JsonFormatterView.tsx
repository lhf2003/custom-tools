import { useState, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { toPng } from 'html-to-image';
import {
  Copy, Download, Check, AlignLeft, GitBranch,
  AlertCircle, ChevronsDownUp, ChevronsUpDown,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '@/stores/appStore';
import { JsonTreeView } from './JsonTreeView';

type DisplayMode = 'tree' | 'text';

export function JsonFormatterView() {
  const { jsonFormatterData, setJsonFormatterData } = useAppStore();

  const [displayMode, setDisplayMode] = useState<DisplayMode>('tree');
  const [parsedJson, setParsedJson] = useState<unknown>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Tree expand/collapse state: defaultExpanded controls initial state of all nodes;
  // treeKey forces a re-mount (clearing per-node overrides) when all-expand/collapse is triggered.
  const [treeDefaultExpanded, setTreeDefaultExpanded] = useState(true);
  const [treeKey, setTreeKey] = useState(0);

  // Parse JSON data on mount or when data changes
  useEffect(() => {
    const data = jsonFormatterData ?? '';
    setRawText(data);

    if (!data.trim()) {
      setParsedJson(null);
      setParseError(null);
      return;
    }

    try {
      const parsed = JSON.parse(data);
      setParsedJson(parsed);
      setParseError(null);
    } catch (err) {
      setParsedJson(null);
      setParseError(err instanceof Error ? err.message : 'JSON 解析失败');
    }
  }, [jsonFormatterData]);

  // Resize window to fit content
  useEffect(() => {
    invoke('resize_window', { height: 560 }).catch(() => {});
  }, []);

  const formattedText = parsedJson !== null
    ? JSON.stringify(parsedJson, null, 2)
    : rawText;

  // ── Toolbar actions ────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formattedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Tauri clipboard context — fail silently */
    }
  }, [formattedText]);

  const handleExportImage = useCallback(async () => {
    if (parsedJson === null) return;
    setExporting(true);
    setExportMsg(null);

    // Render the full JSON tree (always expanded) into an off-screen container
    // so that scrollable-overflow clipping never truncates the output.
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;top:-100000px;left:0;width:800px;background:#18181b;padding:8px 0;';
    document.body.appendChild(container);

    const root = createRoot(container);
    try {
      flushSync(() => {
        root.render(
          <JsonTreeView
            data={parsedJson as Record<string, unknown> | unknown[]}
            defaultExpanded={true}
          />
        );
      });

      const dataUrl = await toPng(container, {
        backgroundColor: '#18181b',
        pixelRatio: 2,
      });
      const base64Data = dataUrl.replace('data:image/png;base64,', '');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `json-${timestamp}.png`;
      const savedPath = await invoke<string>('save_image_to_downloads', { base64Data, filename });
      setExportMsg(`已保存至 ${savedPath}`);
      setTimeout(() => setExportMsg(null), 4000);
    } catch (err) {
      console.error('Export failed:', err);
      setExportMsg('导出失败');
      setTimeout(() => setExportMsg(null), 3000);
    } finally {
      root.unmount();
      document.body.removeChild(container);
      setExporting(false);
    }
  }, [parsedJson]);

  const handleExpandAll = useCallback(() => {
    setTreeDefaultExpanded(true);
    setTreeKey(k => k + 1);
  }, []);

  const handleCollapseAll = useCallback(() => {
    setTreeDefaultExpanded(false);
    setTreeKey(k => k + 1);
  }, []);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setRawText(val);
    setJsonFormatterData(val);
  }, [setJsonFormatterData]);

  // ── Rendering ──────────────────────────────────────────────────────────────

  const hasContent = !!(parsedJson ?? rawText);

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-zinc-200">
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 flex-shrink-0">

        {/* View mode toggle */}
        <div className="flex items-center bg-zinc-800 rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => setDisplayMode('tree')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              displayMode === 'tree'
                ? 'bg-zinc-600 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <GitBranch className="w-3 h-3" />
            树状视图
          </button>
          <button
            onClick={() => setDisplayMode('text')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              displayMode === 'text'
                ? 'bg-zinc-600 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <AlignLeft className="w-3 h-3" />
            文本视图
          </button>
        </div>

        {/* Expand / Collapse all — only in tree mode with valid JSON */}
        {displayMode === 'tree' && parsedJson !== null && (
          <>
            <div className="w-px h-4 bg-zinc-700" />
            <button
              onClick={handleExpandAll}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400
                         hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="展开全部"
            >
              <ChevronsUpDown className="w-3 h-3" />
              展开全部
            </button>
            <button
              onClick={handleCollapseAll}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400
                         hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="折叠全部"
            >
              <ChevronsDownUp className="w-3 h-3" />
              折叠全部
            </button>
          </>
        )}

        <div className="flex-1" />

        {/* Copy */}
        <button
          onClick={handleCopy}
          disabled={!hasContent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                     bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copied
            ? <Check className="w-3.5 h-3.5 text-green-400" />
            : <Copy className="w-3.5 h-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>

        {/* Export image */}
        <button
          onClick={handleExportImage}
          disabled={exporting || parsedJson === null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                     bg-blue-600 hover:bg-blue-500 text-white transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? '导出中...' : '导出图片'}
        </button>
      </div>

      {/* ── Export result banner ──────────────────────────────────────────── */}
      {exportMsg && (
        <div className={`flex items-center gap-2 px-4 py-1.5 border-b flex-shrink-0 text-xs
          ${exportMsg === '导出失败'
            ? 'bg-red-900/30 border-red-800/50 text-red-300'
            : 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300'}`}>
          <span>{exportMsg}</span>
        </div>
      )}

      {/* ── Parse error banner ────────────────────────────────────────────── */}
      {parseError && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-red-900/30
                        border-b border-red-800/50 text-red-300 text-xs flex-shrink-0">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>JSON 解析错误：{parseError}</span>
        </div>
      )}

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 bg-zinc-900">

        {/* Tree view — valid JSON */}
        {displayMode === 'tree' && parsedJson !== null && (
          <JsonTreeView
            key={treeKey}
            data={parsedJson as Record<string, unknown> | unknown[]}
            defaultExpanded={treeDefaultExpanded}
          />
        )}

        {/* Tree view — parse error: show editable textarea */}
        {displayMode === 'tree' && parseError && (
          <textarea
            value={rawText}
            onChange={handleTextChange}
            spellCheck={false}
            placeholder="在此粘贴 JSON 数据..."
            className="w-full h-full bg-transparent text-sm font-mono text-zinc-300
                       resize-none outline-none p-4 leading-relaxed"
          />
        )}

        {/* Tree view — empty state */}
        {displayMode === 'tree' && !rawText && !parseError && (
          <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-3">
            <GitBranch className="w-10 h-10 opacity-20" />
            <p className="text-sm">在启动器中粘贴 JSON，或直接在此处输入</p>
          </div>
        )}

        {/* Text view */}
        {displayMode === 'text' && (
          <textarea
            value={parsedJson !== null ? formattedText : rawText}
            onChange={handleTextChange}
            spellCheck={false}
            placeholder="在此粘贴 JSON 数据..."
            className="w-full h-full bg-transparent text-sm font-mono text-zinc-300
                       resize-none outline-none p-4 leading-relaxed"
          />
        )}
      </div>
    </div>
  );
}
