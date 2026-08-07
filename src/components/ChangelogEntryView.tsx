import ReactMarkdown from 'react-markdown';

interface ChangelogEntryViewProps {
  version: string;
  releaseDate: string | null;
  /** 列表首条标「最新」徽章 */
  isLatest?: boolean;
  content: string;
}

/** 发布日志条目：版本头部（版本号 + 最新徽章 + 日期）+ markdown 正文。
 *  ChangelogModal（关于页历史）与 ChangelogDialog（更新后弹窗）共用，样式走 app-* token */
export function ChangelogEntryView({
  version,
  releaseDate,
  isLatest,
  content,
}: ChangelogEntryViewProps) {
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <div className="py-4">
      <div className="flex items-center gap-2.5 mb-2">
        <span className="text-app-text-primary text-sm font-semibold font-mono">v{version}</span>
        {isLatest && (
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-app-status-success/15 text-app-status-success">
            最新
          </span>
        )}
        {releaseDate && (
          <span className="text-app-text-disabled text-xs ml-auto">{formatDate(releaseDate)}</span>
        )}
      </div>
      <div className="text-xs text-app-text-secondary leading-relaxed">
        <ReactMarkdown
          components={{
            h2: ({ children }) => (
              <h2 className="text-sm font-semibold text-app-text-primary mt-3 mb-1.5 first:mt-0">{children}</h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-xs font-medium text-app-text-primary mt-2 mb-1 first:mt-0">{children}</h3>
            ),
            p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="space-y-1">{children}</ul>,
            li: ({ children }) => (
              <li className="flex items-start gap-2">
                <span className="mt-[7px] w-1 h-1 rounded-full bg-app-text-disabled flex-shrink-0" />
                <span>{children}</span>
              </li>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-app-status-info underline hover:opacity-80"
              >
                {children}
              </a>
            ),
            code: ({ children }) => (
              <code className="bg-white/5 px-1 py-0.5 rounded text-xs text-app-text-primary">
                {children}
              </code>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
