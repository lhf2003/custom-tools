/**
 * A2UI 展示组件 URL 安全校验。
 * 仅允许白名单协议，防止模型返回的 URL 通过 img/video/audio 标签执行
 * javascript: 或加载本地文件等危险资源。
 *
 * 白名单：
 * - https: / http:
 * - asset:（Tauri 转换后的本地资源）
 * - data:image/*（仅图片，禁止 data:text/html 等）
 */
export function sanitizeA2uiUrl(url: string): string | null {
  if (!url) return null;
  try {
    const lower = url.trim().toLowerCase();
    if (lower.startsWith('https:') || lower.startsWith('http:') || lower.startsWith('asset:')) {
      return url;
    }
    if (lower.startsWith('data:image/')) {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}
