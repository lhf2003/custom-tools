/**
 * LRU image cache for clipboard thumbnails and previews.
 *
 * Keys are clipboard item IDs (number).
 * JS Map preserves insertion order, so the oldest (least recently used)
 * entry is always at the front — making eviction O(1).
 *
 * Size limit: 50 MB (measured as estimated decoded bytes of each data URL).
 * When the limit is exceeded the least-recently-used entry is evicted first.
 */

const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB

interface CacheEntry {
  data: string;      // base64 data URL ("data:<mime>;base64,...")
  bytes: number;     // estimated decoded size in bytes
}

const cache = new Map<number, CacheEntry>();
let totalBytes = 0;

/** Estimate decoded image size from a base64 data URL. */
function estimateBytes(dataUrl: string): number {
  // "data:<mime>;base64,<base64>" — base64 region starts after the comma
  const commaIdx = dataUrl.indexOf(',');
  const base64Len = commaIdx >= 0 ? dataUrl.length - commaIdx - 1 : dataUrl.length;
  // Every 4 base64 chars encode 3 bytes; subtract padding if present
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.floor(base64Len * 0.75) - padding;
}

/** Evict least-recently-used entries until total size is within the limit. */
function evictToLimit(): void {
  while (totalBytes > MAX_CACHE_BYTES && cache.size > 0) {
    // Get the first (oldest) entry from the Map
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    const entry = cache.get(firstKey);
    if (entry) {
      cache.delete(firstKey);
      totalBytes -= entry.bytes;
    }
  }
}

export const imageCache = {
  /**
   * Retrieve a cached image data URL.
   * Accessing an entry marks it as most-recently-used (moved to end of Map).
   */
  get(id: number): string | undefined {
    const entry = cache.get(id);
    if (!entry) return undefined;
    // Promote to most-recently-used position
    cache.delete(id);
    cache.set(id, entry);
    return entry.data;
  },

  /**
   * Store an image data URL in the cache.
   * Triggers LRU eviction if the 50 MB limit is exceeded.
   */
  set(id: number, data: string): void {
    const bytes = estimateBytes(data);
    const existing = cache.get(id);
    if (existing) {
      totalBytes -= existing.bytes;
      cache.delete(id);
    }
    cache.set(id, { data, bytes });
    totalBytes += bytes;
    evictToLimit();
  },

  /** Remove a single entry (call when the clipboard item is deleted). */
  remove(id: number): void {
    const entry = cache.get(id);
    if (entry) {
      totalBytes -= entry.bytes;
      cache.delete(id);
    }
  },

  /** Clear all cached entries (call when clipboard history is fully cleared). */
  clear(): void {
    cache.clear();
    totalBytes = 0;
  },

  /** Diagnostic info for debugging. */
  get stats() {
    return {
      count: cache.size,
      totalMB: (totalBytes / 1024 / 1024).toFixed(2),
      limitMB: (MAX_CACHE_BYTES / 1024 / 1024).toFixed(0),
    };
  },
};
