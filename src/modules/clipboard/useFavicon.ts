/**
 * 站点 favicon 加载 hook（剪贴板整链条目图标）。
 *
 * - 模块级缓存按 hostname 去重：同站多条链接只请求一次，列表滚动复用结果
 * - inflight 去重：StrictMode 双执行/多行同域名并发只发一次 invoke
 * - 失败（含离线、无图标）缓存 null，本次会话不再重试，调用方回退通用图标
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function loadFavicon(url: string, host: string): Promise<string | null> {
  const pending = inflight.get(host);
  if (pending) return pending;

  const request = invoke<string | null>('get_site_favicon', { url })
    .then((data) => {
      cache.set(host, data ?? null);
      return data ?? null;
    })
    .catch((err) => {
      console.warn('[favicon] 加载失败:', host, err);
      cache.set(host, null);
      return null;
    })
    .finally(() => {
      inflight.delete(host);
    });

  inflight.set(host, request);
  return request;
}

/** 传入整链 URL 返回 favicon data URL；未加载完成或抓取失败返回 null（调用方渲染兜底图标） */
export function useFavicon(url: string | null): string | null {
  const host = url ? hostnameOf(url) : null;
  const [favicon, setFavicon] = useState<string | null>(() =>
    host ? (cache.get(host) ?? null) : null
  );

  useEffect(() => {
    if (!url || !host) {
      setFavicon(null);
      return;
    }
    const cached = cache.get(host);
    if (cached !== undefined) {
      setFavicon(cached);
      return;
    }
    let cancelled = false;
    loadFavicon(url, host).then((data) => {
      if (!cancelled) setFavicon(data);
    });
    return () => {
      cancelled = true;
    };
  }, [url, host]);

  return favicon;
}
