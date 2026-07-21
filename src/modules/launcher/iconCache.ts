/**
 * 应用图标模块级缓存。
 * ItemCard 随视图切换频繁卸载/重挂载，缓存挂在模块单例上，
 * 避免每次回到启动器都重新走 IPC 提取图标（pop-in 闪烁）。
 * 简单容量上限：超出后淘汰最早写入的条目（Map 保持插入序）。
 */

const MAX_ENTRIES = 300;
const cache = new Map<string, string | null>();

/** 已缓存则返回 data URL 或 null（提取过但没有图标）；未缓存返回 undefined */
export function getCachedIcon(path: string): string | null | undefined {
  return cache.has(path) ? (cache.get(path) as string | null) : undefined;
}

export function setCachedIcon(path: string, data: string | null): void {
  // 重新写入视为最近使用：先删再插，保持插入序即新旧序
  cache.delete(path);
  cache.set(path, data);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
}
