/**
 * 聊天附件（rich 消息）前端管线：后缀分流 → 校验 → 图片压缩落盘 / 文本读取。
 * DB content 协议与后端 scene_chat.rs 对齐：
 *   {"text": "...", "images": ["chat_images/<sid>/<hash>.png"], "files": [{"name","content"}]}
 */

/** 待发附件：image 已压缩落盘（relPath 入库、dataUrl 预览）；file 内容 inline */
export type PendingAttachment =
  | { kind: 'image'; relPath: string; dataUrl: string }
  | { kind: 'file'; name: string; content: string };

/** rich 消息 content JSON 结构（后端 RichContent 镜像） */
export interface RichContent {
  text: string;
  images: string[];
  files: Array<{ name: string; content: string }>;
}

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'rs', 'go', 'java', 'c', 'h',
  'cpp', 'cs', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'vue',
  'php', 'rb', 'kt', 'lua',
];

/** 原始图片硬上限（超过直接拒）；视觉模型甜点最长边；文本文件上下文预算 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 4;
const IMAGE_LONG_EDGE = 1568;

export type FileClass = 'image' | 'text' | 'unsupported';

/** 按后缀分流：图片走视觉链路，文本读内容 inline，其余拒收 */
export function classifyFileName(name: string): FileClass {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return 'unsupported';
}

export interface CompressedImage {
  bytes: Uint8Array;
  ext: 'png' | 'jpg';
  dataUrl: string;
}

/**
 * canvas 压缩：最长边 1568，有透明通道保 PNG、否则 JPEG q0.85。
 * 落盘即压缩版（原图不留）——聊天里的图是给模型看的，不是相册。
 */
export async function compressImage(blob: Blob): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const px = ctx.getImageData(0, 0, w, h).data;
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 255) {
      hasAlpha = true;
      break;
    }
  }

  const mime = hasAlpha ? 'image/png' : 'image/jpeg';
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, 0.85),
  );
  if (!out) throw new Error('图片压缩失败');
  const bytes = new Uint8Array(await out.arrayBuffer());
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('预览生成失败'));
    reader.readAsDataURL(out);
  });
  return { bytes, ext: hasAlpha ? 'png' : 'jpg', dataUrl };
}

/** 文本文件读取：UTF-8 优先，失败回退 GBK（Windows 中文环境 txt/log 大量 GBK） */
export async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

/** 待发附件 + 输入文本 → rich content JSON（入库与发送共用同一串） */
export function buildRichContent(text: string, attachments: PendingAttachment[]): string {
  const images = attachments
    .filter((a) => a.kind === 'image')
    .map((a) => a.relPath);
  const files = attachments
    .filter((a) => a.kind === 'file')
    .map((a) => ({ name: a.name, content: a.content }));
  return JSON.stringify({ text, images, files });
}

/** 解析 rich content；非 rich/结构不符返回 null（防御历史脏数据） */
export function parseRichContent(content: string): RichContent | null {
  try {
    const v = JSON.parse(content) as RichContent;
    if (
      typeof v?.text === 'string' &&
      Array.isArray(v?.images) &&
      Array.isArray(v?.files)
    ) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

/** rich 消息的单行摘要（会话标题/历史列表预览用）：附件降级为引用标签 */
export function richDisplayText(content: string): string | null {
  const rich = parseRichContent(content);
  if (!rich) return null;
  const tags: string[] = [];
  if (rich.images.length > 0) tags.push(`[图片×${rich.images.length}]`);
  for (const f of rich.files) tags.push(`[文件: ${f.name}]`);
  return [rich.text, tags.join(' ')].filter(Boolean).join(' ') || '[附件]';
}
