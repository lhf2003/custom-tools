import html2canvas from 'html2canvas';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { createElement } from 'react';

export interface ExportOptions {
  filename?: string;
  scale?: number;
}

type ExportTheme = 'dark' | 'light';

/** 导出图片跟随当前应用明暗族（data-theme-family 由 ThemeController / index.html 内联脚本设置） */
function resolveExportTheme(): ExportTheme {
  return document.documentElement.dataset.themeFamily === 'light' ? 'light' : 'dark';
}

const EXPORT_CONTAINER_BASE = {
  padding: '40px',
  width: '800px',
  // 【字体同步点 1/2】与编辑器正文一致的中英一体字体栈；
  // 改动必须同步 src/styles/fonts/harmonyos-sans-sc.css 等五处（见打包字体流程备忘）
  fontFamily: '"HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  lineHeight: '1.6',
  boxSizing: 'border-box' as const,
};

/** 容器底色/正文色：浅底为经典导出白，深底对齐 app-bg-primary */
const EXPORT_CONTAINER_THEME: Record<ExportTheme, { backgroundColor: string; color: string }> = {
  light: { backgroundColor: '#ffffff', color: '#1f2937' },
  dark: { backgroundColor: '#1e1e21', color: '#d4d4d8' },
};

/** 浅色导出样式（GitHub light 风，hljs 补丁适配 rehype-highlight 输出） */
const STYLE_CONTENT_LIGHT = `
    .markdown-export {
      color: #1f2937 !important;
      background-color: #ffffff !important;
      font-family: "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
      font-size: 16px !important;
      line-height: 1.6 !important;
    }
    .markdown-export h1, .markdown-export h2, .markdown-export h3,
    .markdown-export h4, .markdown-export h5, .markdown-export h6 {
      color: #111827 !important;
      margin-top: 24px !important;
      margin-bottom: 16px !important;
      font-weight: 600 !important;
    }
    .markdown-export h1 { font-size: 28px !important; border-bottom: 2px solid #e5e7eb !important; padding-bottom: 8px !important; }
    .markdown-export h2 { font-size: 24px !important; }
    .markdown-export h3 { font-size: 20px !important; }
    .markdown-export p { color: #1f2937 !important; margin-bottom: 16px !important; }
    .markdown-export code { background-color: #f3f4f6 !important; color: #e11d48 !important; padding: 2px 6px !important; border-radius: 4px !important; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important; font-size: 0.875em !important; }
    .markdown-export pre { background-color: #f6f8fa !important; padding: 16px !important; border-radius: 8px !important; overflow-x: auto !important; margin-bottom: 16px !important; border: 1px solid #e5e7eb !important; }
    .markdown-export pre code { background-color: transparent !important; color: #24292e !important; padding: 0 !important; font-size: 14px !important; line-height: 1.6 !important; }
    .markdown-export blockquote { border-left: 4px solid #e5e7eb !important; padding-left: 16px !important; color: #6b7280 !important; margin-bottom: 16px !important; }
    .markdown-export ul, .markdown-export ol { color: #1f2937 !important; padding-left: 24px !important; margin-bottom: 16px !important; }
    .markdown-export ul { list-style-type: disc !important; }
    .markdown-export ol { list-style: none !important; counter-reset: list-counter !important; }
    .markdown-export ol > li { position: relative !important; counter-increment: list-counter !important; }
    .markdown-export ol > li::before { content: counter(list-counter) "." !important; position: absolute !important; right: 100% !important; margin-right: 8px !important; top: 0 !important; width: 20px !important; text-align: right !important; color: #1f2937 !important; font-size: inherit !important; line-height: inherit !important; }
    .markdown-export li { color: #1f2937 !important; margin-bottom: 4px !important; }
    .markdown-export table { width: 100% !important; border-collapse: collapse !important; margin-bottom: 16px !important; }
    .markdown-export th, .markdown-export td { border: 1px solid #e5e7eb !important; padding: 8px 12px !important; color: #1f2937 !important; }
    .markdown-export th { background-color: #f9fafb !important; font-weight: 600 !important; }
    .markdown-export a { color: #2563eb !important; text-decoration: none !important; }
    .markdown-export hr { border: none !important; border-top: 1px solid #e5e7eb !important; margin: 24px 0 !important; }
    .markdown-export img { max-width: 100% !important; height: auto !important; border-radius: 4px !important; }
    .export-title { font-size: 28px; font-weight: 700; color: #111827; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #e5e7eb; }
    /* 代码高亮样式 - 配合 GitHub light 主题（rehype-highlight 输出 hljs-* 类名） */
    .markdown-export .hljs { display: block; overflow-x: auto; padding: 0 !important; background: transparent !important; color: #24292e !important; }
    .markdown-export .hljs-comment, .markdown-export .hljs-quote { color: #6a737d !important; font-style: italic !important; }
    .markdown-export .hljs-keyword, .markdown-export .hljs-selector-tag, .markdown-export .hljs-subst { color: #d73a49 !important; font-weight: normal !important; }
    .markdown-export .hljs-number, .markdown-export .hljs-literal, .markdown-export .hljs-variable, .markdown-export .hljs-template-variable, .markdown-export .hljs-tag .hljs-attr { color: #005cc5 !important; }
    .markdown-export .hljs-string, .markdown-export .hljs-doctag { color: #032f62 !important; }
    .markdown-export .hljs-title, .markdown-export .hljs-section, .markdown-export .hljs-selector-id { color: #6f42c1 !important; }
    .markdown-export .hljs-type, .markdown-export .hljs-class .markdown-export .hljs-title { color: #458 !important; font-weight: bold !important; }
    .markdown-export .hljs-tag, .markdown-export .hljs-name, .markdown-export .hljs-attribute { color: #000080 !important; font-weight: normal !important; }
    .markdown-export .hljs-regexp, .markdown-export .hljs-link { color: #009926 !important; }
    .markdown-export .hljs-symbol, .markdown-export .hljs-bullet { color: #990073 !important; }
    .markdown-export .hljs-built_in, .markdown-export .hljs-builtin-name { color: #0086b3 !important; }
    .markdown-export .hljs-meta { color: #999 !important; font-weight: bold !important; }
    .markdown-export .hljs-deletion { background: #fdd !important; }
    .markdown-export .hljs-addition { background: #dfd !important; }
    .markdown-export .hljs-emphasis { font-style: italic !important; }
    .markdown-export .hljs-strong { font-weight: bold !important; }
  `;

/** 深色导出样式（镜像浅色结构；hljs 补丁取自编辑器 --cm-hl-* 深色调色板） */
const STYLE_CONTENT_DARK = `
    .markdown-export {
      color: #d4d4d8 !important;
      background-color: #1e1e21 !important;
      font-family: "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
      font-size: 16px !important;
      line-height: 1.6 !important;
    }
    .markdown-export h1, .markdown-export h2, .markdown-export h3,
    .markdown-export h4, .markdown-export h5, .markdown-export h6 {
      color: #f4f4f5 !important;
      margin-top: 24px !important;
      margin-bottom: 16px !important;
      font-weight: 600 !important;
    }
    .markdown-export h1 { font-size: 28px !important; border-bottom: 2px solid rgba(255, 255, 255, 0.14) !important; padding-bottom: 8px !important; }
    .markdown-export h2 { font-size: 24px !important; }
    .markdown-export h3 { font-size: 20px !important; }
    .markdown-export p { color: #d4d4d8 !important; margin-bottom: 16px !important; }
    .markdown-export code { background-color: rgba(255, 255, 255, 0.10) !important; color: #f472b6 !important; padding: 2px 6px !important; border-radius: 4px !important; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important; font-size: 0.875em !important; }
    .markdown-export pre { background-color: #26262a !important; padding: 16px !important; border-radius: 8px !important; overflow-x: auto !important; margin-bottom: 16px !important; border: 1px solid rgba(255, 255, 255, 0.10) !important; }
    .markdown-export pre code { background-color: transparent !important; color: #e4e4e7 !important; padding: 0 !important; font-size: 14px !important; line-height: 1.6 !important; }
    .markdown-export blockquote { border-left: 4px solid rgba(255, 255, 255, 0.20) !important; padding-left: 16px !important; color: #a1a1aa !important; margin-bottom: 16px !important; }
    .markdown-export ul, .markdown-export ol { color: #d4d4d8 !important; padding-left: 24px !important; margin-bottom: 16px !important; }
    .markdown-export ul { list-style-type: disc !important; }
    .markdown-export ol { list-style: none !important; counter-reset: list-counter !important; }
    .markdown-export ol > li { position: relative !important; counter-increment: list-counter !important; }
    .markdown-export ol > li::before { content: counter(list-counter) "." !important; position: absolute !important; right: 100% !important; margin-right: 8px !important; top: 0 !important; width: 20px !important; text-align: right !important; color: #d4d4d8 !important; font-size: inherit !important; line-height: inherit !important; }
    .markdown-export li { color: #d4d4d8 !important; margin-bottom: 4px !important; }
    .markdown-export table { width: 100% !important; border-collapse: collapse !important; margin-bottom: 16px !important; }
    .markdown-export th, .markdown-export td { border: 1px solid rgba(255, 255, 255, 0.14) !important; padding: 8px 12px !important; color: #d4d4d8 !important; }
    .markdown-export th { background-color: #26262a !important; font-weight: 600 !important; }
    .markdown-export a { color: #818cf8 !important; text-decoration: none !important; }
    .markdown-export hr { border: none !important; border-top: 1px solid rgba(255, 255, 255, 0.14) !important; margin: 24px 0 !important; }
    .markdown-export img { max-width: 100% !important; height: auto !important; border-radius: 4px !important; }
    .export-title { font-size: 28px; font-weight: 700; color: #f4f4f5; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid rgba(255, 255, 255, 0.14); }
    /* 代码高亮 - 编辑器深色 hljs 调色板内联版（--cm-hl-* 的字面量对应） */
    .markdown-export .hljs { display: block; overflow-x: auto; padding: 0 !important; background: transparent !important; color: #e4e4e7 !important; }
    .markdown-export .hljs-comment, .markdown-export .hljs-quote, .markdown-export .hljs-doctag { color: #71717a !important; font-style: italic !important; }
    .markdown-export .hljs-keyword, .markdown-export .hljs-selector-tag, .markdown-export .hljs-literal, .markdown-export .hljs-section, .markdown-export .hljs-meta-keyword, .markdown-export .hljs-tag .hljs-name, .markdown-export .hljs-name { color: #c084fc !important; }
    .markdown-export .hljs-string, .markdown-export .hljs-regexp, .markdown-export .hljs-template-tag, .markdown-export .hljs-template-variable, .markdown-export .hljs-addition, .markdown-export .hljs-attribute { color: #4ade80 !important; }
    .markdown-export .hljs-number, .markdown-export .hljs-bullet, .markdown-export .hljs-variable.constant_ { color: #fbbf24 !important; }
    .markdown-export .hljs-function, .markdown-export .hljs-title.function_, .markdown-export .hljs-built_in, .markdown-export .hljs-selector-id, .markdown-export .hljs-selector-class, .markdown-export .hljs-selector-attr, .markdown-export .hljs-selector-pseudo { color: #93c5fd !important; }
    .markdown-export .hljs-class, .markdown-export .hljs-title.class_, .markdown-export .hljs-type, .markdown-export .hljs-attr, .markdown-export .hljs-params { color: #22d3ee !important; }
    .markdown-export .hljs-variable, .markdown-export .hljs-property, .markdown-export .hljs-deletion, .markdown-export .hljs-symbol, .markdown-export .hljs-subst, .markdown-export .hljs-tag .hljs-attr { color: #f472b6 !important; }
    .markdown-export .hljs-tag, .markdown-export .hljs-tag .hljs-title { color: #f87171 !important; }
    .markdown-export .hljs-punctuation, .markdown-export .hljs-operator, .markdown-export .hljs-meta { color: #a1a1aa !important; }
    .markdown-export .hljs-link { color: #93c5fd !important; text-decoration: underline !important; }
    .markdown-export .hljs-emphasis { font-style: italic !important; }
    .markdown-export .hljs-strong { font-weight: bold !important; }
  `;

/** Markdown → 静态 HTML（react-markdown + GFM + hljs 高亮，替代旧 Vditor.preview） */
function renderMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHighlight] },
      markdown,
    ),
  );
}

export async function exportNoteAsImage(
  markdown: string,
  title: string,
  options: ExportOptions = {}
): Promise<Blob> {
  const { scale = 2 } = options;
  const exportTheme = resolveExportTheme();

  if (!markdown.trim()) {
    throw new Error('笔记内容为空');
  }

  // 创建临时容器
  const container = document.createElement('div');
  container.style.cssText = Object.entries({ ...EXPORT_CONTAINER_BASE, ...EXPORT_CONTAINER_THEME[exportTheme] })
    .map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}`)
    .join('; ');

  // 添加当前主题的导出样式
  const styleContent = exportTheme === 'light' ? STYLE_CONTENT_LIGHT : STYLE_CONTENT_DARK;

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
  contentEl.className = 'markdown-export';
  container.appendChild(contentEl);

  // 添加到 DOM - 移出视口以避免遮罩效果，同时保持元素可渲染
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  document.body.appendChild(container);

  try {
    // 静态渲染（同步），无需旧 Vditor.preview 的异步等待
    contentEl.innerHTML = renderMarkdownHtml(markdown);

    // 等打包字体就绪 + 一帧排版，保证 html2canvas 截图前字体已应用
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    // 使用 html2canvas 截图
    const canvas = await html2canvas(container, {
      scale: scale,
      backgroundColor: EXPORT_CONTAINER_THEME[exportTheme].backgroundColor,
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: container.offsetWidth,
      height: container.offsetHeight,
    });

    // 转换为 Blob
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((canvasBlob) => {
        if (canvasBlob) {
          resolve(canvasBlob);
        } else {
          reject(new Error('Canvas to Blob failed'));
        }
      }, 'image/png', 1.0);
    });

    if (blob.size === 0) {
      throw new Error('生成的图片文件为空');
    }

    return blob;
  } catch (err) {
    console.error('[Export] Export failed:', err);
    throw err;
  } finally {
    document.body.removeChild(container);
  }
}
