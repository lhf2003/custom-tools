import { useMemo } from 'react';
import { marked } from 'marked';

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    return marked.parse(content, {
      gfm: true,
      breaks: true,
    });
  }, [content]);

  return (
    <div
      className="flex-1 overflow-y-auto p-6 prose prose-invert prose-zinc max-w-none"
      style={{
        backgroundColor: '#2a2a2a',
        fontSize: '14px',
        lineHeight: '1.6',
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
