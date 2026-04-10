import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import '../styles/vditor.css';

interface VditorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onReady?: () => void;
}

export interface VditorEditorRef {
  getPreviewHtml: () => Promise<string>;
}

export const VditorEditor = forwardRef<VditorEditorRef, VditorEditorProps>(
  function VditorEditor({ value, onChange, placeholder = '开始写作...', onReady }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const vditorRef = useRef<Vditor | null>(null);
    const isUpdatingRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const valueRef = useRef(value);

    // 保持 value 引用最新
    useEffect(() => {
      valueRef.current = value;
    }, [value]);

    // 暴露获取预览 HTML 的方法给父组件
    useImperativeHandle(ref, () => ({
      getPreviewHtml: async () => {
        const vditor = vditorRef.current;
        if (!vditor) return '';

        const markdown = vditor.getValue();
        if (!markdown.trim()) return '';

        // 创建临时容器用于渲染预览
        const tempDiv = document.createElement('div');
        tempDiv.className = 'vditor-reset';
        tempDiv.style.cssText = 'padding: 20px; background: #ffffff; min-width: 800px;';
        tempDiv.style.visibility = 'hidden';
        tempDiv.style.position = 'fixed';
        tempDiv.style.left = '0';
        tempDiv.style.top = '0';
        tempDiv.style.zIndex = '-9999';
        document.body.appendChild(tempDiv);

        try {
          // 使用 Vditor.preview 渲染 HTML
          await new Promise<void>((resolve) => {
            Vditor.preview(tempDiv, markdown, {
              mode: 'light',
              theme: {
                current: 'light',
                path: '/vditor/dist/css/content-theme',
              },
              hljs: {
                enable: true,
                lineNumber: false,
                style: 'github',
              },
              after: () => {
                // 等待一小段时间确保高亮和样式应用完成
                setTimeout(() => {
                  resolve();
                }, 200);
              },
            });
          });

          // 等待额外的渲染时间
          await new Promise(resolve => setTimeout(resolve, 100));

          const html = tempDiv.innerHTML;
          return html;
        } finally {
          document.body.removeChild(tempDiv);
        }
      },
    }));

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
          cdn: '/vditor',
          toolbar: [
            { name: 'headings', tip: '标题', tipPosition: 's' },
            { name: 'bold', tip: '粗体', tipPosition: 's' },
            { name: 'italic', tip: '斜体', tipPosition: 's' },
            { name: 'strike', tip: '删除线', tipPosition: 's' },
            '|',
            { name: 'list', tip: '无序列表', tipPosition: 's' },
            { name: 'ordered-list', tip: '有序列表', tipPosition: 's' },
            { name: 'check', tip: '任务列表', tipPosition: 's' },
            '|',
            { name: 'code', tip: '代码块', tipPosition: 's' },
            { name: 'inline-code', tip: '行内代码', tipPosition: 's' },
            '|',
            { name: 'link', tip: '链接', tipPosition: 's' },
            { name: 'table', tip: '表格', tipPosition: 's' },
            '|',
            { name: 'undo', tip: '撤销', tipPosition: 's' },
            { name: 'redo', tip: '重做', tipPosition: 's' },
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
            if (valueRef.current) {
              vditor.setValue(valueRef.current);
            }
            onReady?.();
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
);
