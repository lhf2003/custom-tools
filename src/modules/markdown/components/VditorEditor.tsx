import { useEffect, useRef, useState } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import '../styles/vditor.css';

interface VditorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function VditorEditor({ value, onChange, placeholder = '开始写作...' }: VditorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const isUpdatingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || vditorRef.current) return;

    try {
      const vditor = new Vditor(containerRef.current, {
        mode: 'ir',
        value,
        placeholder,
        theme: 'dark',
        height: '100%',
        minHeight: 300,
        lang: 'zh_CN',
        cache: { enable: false },
        outline: { enable: false, position: 'left' },
        cdn: '/node_modules/vditor',
        toolbar: [
          'headings', 'bold', 'italic', 'strike', '|',
          'list', 'ordered-list', 'check', '|',
          'code', 'inline-code', '|',
          'link', 'table', '|',
          'undo', 'redo'
        ],
        preview: {
          theme: {
            current: 'dark',
            path: '/node_modules/vditor/dist/css/content-theme',
          },
          hljs: {
            enable: true,
            lineNumber: false,
            style: 'github-dark',
          },
        },
        after: () => {
          vditorRef.current = vditor;
          vditor.setTheme('dark', 'dark', 'github-dark');
          if (value) {
            vditor.setValue(value);
          }
        },
        input: (text: string) => {
          isUpdatingRef.current = true;
          onChange(text);
          requestAnimationFrame(() => {
            isUpdatingRef.current = false;
          });
        },
      });

      return () => {
        try {
          vditor.destroy();
        } catch (e) {
          console.error('[Vditor] Destroy error:', e);
        }
        vditorRef.current = null;
      };
    } catch (err) {
      console.error('[Vditor] Initialization error:', err);
      setError(err instanceof Error ? err.message : '编辑器初始化失败');
    }
  }, []);

  useEffect(() => {
    const editor = vditorRef.current;
    if (!editor || isUpdatingRef.current) return;

    try {
      const currentValue = editor.getValue();
      if (value !== currentValue) {
        editor.setValue(value);
      }
    } catch (err) {
      console.error('[Vditor] Set value error:', err);
    }
  }, [value]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 p-4">
        <div className="text-center">
          <p className="mb-2">编辑器加载失败</p>
          <p className="text-xs text-zinc-500">{error}</p>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="vditor-editor h-full" />;
}
