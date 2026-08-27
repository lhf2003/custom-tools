import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../editor/extensions';
import { EditorToolbar } from './EditorToolbar';
import '../styles/editor.css';

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * CodeMirror 6 单栏即时渲染编辑器（Vditor 替代品）。
 * 与旧 VditorEditor 保持同一契约（value/onChange/placeholder），
 * MarkdownView 无需感知内部实现。
 */
export function CodeMirrorEditor({
  value,
  onChange,
  placeholder = '开始写作...',
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const isUpdatingRef = useRef(false);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const placeholderRef = useRef(placeholder);

  // 保持回调与 value 引用最新（初始化 effect 只运行一次，经 ref 读取最新值）
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    placeholderRef.current = placeholder;
  }, [value, onChange, placeholder]);

  useEffect(() => {
    if (!containerRef.current) return;

    const editorView = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: buildExtensions({
          placeholder: placeholderRef.current,
          onDocChange: (text) => {
            isUpdatingRef.current = true;
            onChangeRef.current(text);
            queueMicrotask(() => {
              isUpdatingRef.current = false;
            });
          },
        }),
      }),
      parent: containerRef.current,
    });
    setView(editorView);

    // 开发态调试句柄：读取 view.state 排障（生产构建不含）
    if (import.meta.env.DEV) {
      (window as unknown as { __cmView?: EditorView }).__cmView = editorView;
    }

    return () => {
      editorView.destroy();
      setView(null);
    };
  }, []);

  // 外部 value 同步（切笔记 / AI 排版 / 恢复原文）：
  // 仅当 prop 与文档真正不同才全量替换，本地输入（含 IME 组词）永不触发 dispatch
  useEffect(() => {
    if (!view || isUpdatingRef.current) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value, view]);

  return (
    <div className="cm-editor-root">
      <EditorToolbar view={view} />
      <div ref={containerRef} className="cm-editor-host" />
    </div>
  );
}
