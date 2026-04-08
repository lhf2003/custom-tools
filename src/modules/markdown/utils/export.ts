import html2canvas from 'html2canvas';
import Vditor from 'vditor';

export interface ExportOptions {
  filename?: string;
  scale?: number;
}

const EXPORT_CONTAINER_STYLE = {
  backgroundColor: '#ffffff',
  color: '#1f2937',
  padding: '40px',
  width: '800px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  lineHeight: '1.6',
  boxSizing: 'border-box' as const,
};

export async function exportNoteAsImage(
  markdown: string,
  title: string,
  options: ExportOptions = {}
): Promise<Blob> {
  const { scale = 2 } = options;

  console.log('[Export] Starting export, title:', title);
  console.log('[Export] Markdown length:', markdown?.length || 0);

  if (!markdown.trim()) {
    throw new Error('笔记内容为空');
  }

  // 创建临时容器
  const container = document.createElement('div');
  container.style.cssText = Object.entries(EXPORT_CONTAINER_STYLE)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}`)
    .join('; ');

  // 添加浅色主题样式
  const styleContent = `
    .vditor-reset {
      color: #1f2937 !important;
      background-color: #ffffff !important;
      font-size: 16px !important;
      line-height: 1.6 !important;
    }
    .vditor-reset h1, .vditor-reset h2, .vditor-reset h3,
    .vditor-reset h4, .vditor-reset h5, .vditor-reset h6 {
      color: #111827 !important;
      margin-top: 24px !important;
      margin-bottom: 16px !important;
      font-weight: 600 !important;
    }
    .vditor-reset h1 { font-size: 28px !important; border-bottom: 2px solid #e5e7eb !important; padding-bottom: 8px !important; }
    .vditor-reset h2 { font-size: 24px !important; }
    .vditor-reset h3 { font-size: 20px !important; }
    .vditor-reset p { color: #1f2937 !important; margin-bottom: 16px !important; }
    .vditor-reset code { background-color: #f3f4f6 !important; color: #e11d48 !important; padding: 2px 6px !important; border-radius: 4px !important; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important; font-size: 0.875em !important; }
    .vditor-reset pre { background-color: #f6f8fa !important; padding: 16px !important; border-radius: 8px !important; overflow-x: auto !important; margin-bottom: 16px !important; border: 1px solid #e5e7eb !important; }
    .vditor-reset pre code { background-color: transparent !important; color: #24292e !important; padding: 0 !important; font-size: 14px !important; line-height: 1.6 !important; }
    .vditor-reset blockquote { border-left: 4px solid #e5e7eb !important; padding-left: 16px !important; color: #6b7280 !important; margin-bottom: 16px !important; }
    .vditor-reset ul, .vditor-reset ol { color: #1f2937 !important; padding-left: 24px !important; margin-bottom: 16px !important; }
    .vditor-reset li { color: #1f2937 !important; margin-bottom: 4px !important; }
    .vditor-reset table { width: 100% !important; border-collapse: collapse !important; margin-bottom: 16px !important; }
    .vditor-reset th, .vditor-reset td { border: 1px solid #e5e7eb !important; padding: 8px 12px !important; color: #1f2937 !important; }
    .vditor-reset th { background-color: #f9fafb !important; font-weight: 600 !important; }
    .vditor-reset a { color: #2563eb !important; text-decoration: none !important; }
    .vditor-reset hr { border: none !important; border-top: 1px solid #e5e7eb !important; margin: 24px 0 !important; }
    .vditor-reset img { max-width: 100% !important; height: auto !important; border-radius: 4px !important; }
    .export-title { font-size: 28px; font-weight: 700; color: #111827; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #e5e7eb; }
    /* 代码高亮样式 - 配合 GitHub 主题 */
    .vditor-reset .hljs { display: block; overflow-x: auto; padding: 0 !important; background: transparent !important; color: #24292e !important; }
    .vditor-reset .hljs-comment, .vditor-reset .hljs-quote { color: #6a737d !important; font-style: italic !important; }
    .vditor-reset .hljs-keyword, .vditor-reset .hljs-selector-tag, .vditor-reset .hljs-subst { color: #d73a49 !important; font-weight: normal !important; }
    .vditor-reset .hljs-number, .vditor-reset .hljs-literal, .vditor-reset .hljs-variable, .vditor-reset .hljs-template-variable, .vditor-reset .hljs-tag .hljs-attr { color: #005cc5 !important; }
    .vditor-reset .hljs-string, .vditor-reset .hljs-doctag { color: #032f62 !important; }
    .vditor-reset .hljs-title, .vditor-reset .hljs-section, .vditor-reset .hljs-selector-id { color: #6f42c1 !important; }
    .vditor-reset .hljs-subst { font-weight: normal !important; }
    .vditor-reset .hljs-type, .vditor-reset .hljs-class .vditor-reset .hljs-title { color: #458 !important; font-weight: bold !important; }
    .vditor-reset .hljs-tag, .vditor-reset .hljs-name, .vditor-reset .hljs-attribute { color: #000080 !important; font-weight: normal !important; }
    .vditor-reset .hljs-regexp, .vditor-reset .hljs-link { color: #009926 !important; }
    .vditor-reset .hljs-symbol, .vditor-reset .hljs-bullet { color: #990073 !important; }
    .vditor-reset .hljs-built_in, .vditor-reset .hljs-builtin-name { color: #0086b3 !important; }
    .vditor-reset .hljs-meta { color: #999 !important; font-weight: bold !important; }
    .vditor-reset .hljs-deletion { background: #fdd !important; }
    .vditor-reset .hljs-addition { background: #dfd !important; }
    .vditor-reset .hljs-emphasis { font-style: italic !important; }
    .vditor-reset .hljs-strong { font-weight: bold !important; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styleContent;
  container.appendChild(styleEl);

  // 添加标题
  const titleEl = document.createElement('h1');
  titleEl.className = 'export-title';
  titleEl.textContent = title.replace(/\.md$/, '');
  container.appendChild(titleEl);

  // 添加内容容器
  const contentEl = document.createElement('div');
  contentEl.className = 'vditor-reset';
  container.appendChild(contentEl);

  // 添加到 DOM - 移出视口以避免遮罩效果，同时保持元素可渲染
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  document.body.appendChild(container);

  try {
    console.log('[Export] Starting Vditor.preview...');

    // 使用 Vditor.preview 渲染 Markdown
    await new Promise<void>((resolve, reject) => {
      try {
        Vditor.preview(contentEl, markdown, {
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
            console.log('[Export] Vditor.preview completed');
            setTimeout(resolve, 300);
          },
        });
      } catch (err) {
        reject(err);
      }
    });

    // 额外等待确保渲染完成
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('[Export] Container dimensions:', container.offsetWidth, 'x', container.offsetHeight);
    console.log('[Export] Calling html2canvas...');

    // 使用 html2canvas 截图
    const canvas = await html2canvas(container, {
      scale: scale,
      backgroundColor: '#ffffff',
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: container.offsetWidth,
      height: container.offsetHeight,
    });

    console.log('[Export] html2canvas completed, canvas size:', canvas.width, 'x', canvas.height);

    // 转换为 Blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas to Blob failed'));
        }
      }, 'image/png', 1.0);
    });

    console.log('[Export] Blob size:', blob.size, 'bytes');

    if (blob.size === 0) {
      throw new Error('生成的图片文件为空');
    }

    console.log('[Export] Export successful');
    return blob;
  } catch (err) {
    console.error('[Export] Export failed:', err);
    throw err;
  } finally {
    document.body.removeChild(container);
    console.log('[Export] Container cleaned up');
  }
}
