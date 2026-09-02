import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * 站点图标（复用剪贴板模块的 favicon 管道：磁盘缓存 7 天 + 两级抓取）。
 * 前端模块级 Promise 缓存去重（同域名多卡片只 invoke 一次）；
 * 抓取失败降级首字母方块（token 合规：brand 淡色底）。
 */
const faviconCache = new Map<string, Promise<string | null>>();

function fetchFavicon(domain: string): Promise<string | null> {
  let cached = faviconCache.get(domain);
  if (!cached) {
    cached = invoke<string | null>('get_site_favicon', { url: `https://${domain}/` }).catch(
      () => null,
    );
    faviconCache.set(domain, cached);
  }
  return cached;
}

export function Favicon({
  domain,
  className = 'w-3.5 h-3.5',
}: {
  domain: string | null;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) return;
    let cancelled = false;
    fetchFavicon(domain).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [domain]);

  if (url) {
    return <img src={url} alt="" className={`${className} rounded-sm flex-shrink-0`} />;
  }
  // 降级：域名首字符方块
  const letter = (domain ?? '?').replace(/^www\./, '').charAt(0).toUpperCase();
  return (
    <span
      className={`${className} rounded-sm flex-shrink-0 inline-flex items-center justify-center bg-app-brand-primary/20 text-app-brand-primary-light text-[10px] font-medium`}
    >
      {letter}
    </span>
  );
}
