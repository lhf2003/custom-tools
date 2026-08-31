/**
 * 右栏详情面板：头部（类型/时间/来源 + 操作）、正文（按内容分级渲染）、底部提示
 *
 * 正文分级：
 * - 图片 → 大图预览（点击弹层放大）
 * - 文件 → 路径卡片 + 打开所在文件夹
 * - 文本 → detectTextKind 分级：整链 → 链接卡片；JSON → 着色格式化（可切原文）；其余 → 全文（内联链接可点）
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Copy, FolderOpen, ExternalLink, Link2, Loader2, X } from 'lucide-react';
import type { ClipboardItemData } from './types';
import {
  detectTextKind,
  formatJson,
  tokenizeJson,
  linkifyText,
  getTypeConfig,
  isImageFile,
  isPlayableAudioFile,
  isPlayableVideoFile,
  formatTime,
  JSON_TOKEN_COLORS,
} from './utils';
import { imageCache } from './imageCache';
import { useFavicon } from './useFavicon';
import { MediaPlayer } from './MediaPlayer';

interface ClipboardDetailProps {
  item: ClipboardItemData;
  onCopyPartial: (text: string) => void;
}

interface SelectionToolbar {
  x: number;
  y: number;
  text: string;
}

const MONO_STACK = "'Fira Code', 'JetBrains Mono', 'SF Mono', Consolas, Monaco, monospace";

export function ClipboardDetail({ item, onCopyPartial }: ClipboardDetailProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [selToolbar, setSelToolbar] = useState<SelectionToolbar | null>(null);
  const [appIcon, setAppIcon] = useState<string | null>(null);

  const config = getTypeConfig(item.content_type, item.content);
  const isImage = item.content_type === 'image' || (item.content_type === 'file' && isImageFile(item.content));

  // 来源应用图标（后端有缓存，仅选中项加载，比逐行加载省调用）
  useEffect(() => {
    setAppIcon(null);
    if (!item.source_exe) return;
    let cancelled = false;
    invoke<string | null>('get_app_icon', { exePath: item.source_exe })
      .then((data) => { if (!cancelled) setAppIcon(data); })
      .catch(() => { /* 图标缺失时仅隐藏，不影响主流程 */ });
    return () => { cancelled = true; };
  }, [item.source_exe]);

  // 切换条目时收起划词工具条
  useEffect(() => {
    setSelToolbar(null);
  }, [item.id]);

  // 划词复制工具条（监听正文区域内的文本选择）
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const body = bodyRef.current;
      if (!selection || selection.isCollapsed || !body) {
        setSelToolbar(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) {
        setSelToolbar(null);
        return;
      }
      const selectedText = selection.toString().trim();
      if (selectedText.length === 0) {
        setSelToolbar(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = body.getBoundingClientRect();
      setSelToolbar({
        x: rect.left - containerRect.left + rect.width / 2,
        y: rect.top - containerRect.top - 8,
        text: selectedText,
      });
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (bodyRef.current && !bodyRef.current.contains(e.target as Node)) {
        setSelToolbar(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const openUrl = async (url: string) => {
    try {
      await invoke('open_external_url', { url });
    } catch (err) {
      console.error('Failed to open URL:', err);
    }
  };

  const footerRight = item.content_type === 'text' ? `${item.content.length} 字符` : '';

  return (
    <>
      {/* 头部：单行元信息（类型/时间/来源），高度与左栏搜索行对齐（h-11）。
          条目动作（粘贴/复制/发送给AI/收藏/删除）在页面右键菜单里 */}
      <div className="flex items-center gap-2 px-5 h-11 border-b border-app-border-subtle shrink-0 min-w-0">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${config.chipClass}`}>
          {config.label}
        </span>
        <span className="text-xs text-app-text-tertiary shrink-0">{formatTime(item.created_at)}</span>
        {item.source_app && item.source_app !== 'Unknown' && (
          <>
            <span className="text-app-text-disabled text-xs shrink-0">·</span>
            {appIcon && <img src={appIcon} alt="" className="w-3.5 h-3.5 rounded shrink-0" />}
            <span className="text-xs text-app-text-tertiary truncate min-w-0">来自 {item.source_app}</span>
          </>
        )}
      </div>

      {/* 正文 */}
      <div ref={bodyRef} className="relative flex-1 overflow-y-auto px-5 py-4">
        {isImage ? (
          <ImageContent item={item} />
        ) : item.content_type === 'file' ? (
          // 单文件 + Chromium 可解码 → 内嵌播放器；多文件/不支持格式 → 路径卡片
          !item.content.includes('\n') && isPlayableAudioFile(item.content) ? (
            <MediaPlayer key={item.id} path={item.content} mode="audio" />
          ) : !item.content.includes('\n') && isPlayableVideoFile(item.content) ? (
            <MediaPlayer key={item.id} path={item.content} mode="video" />
          ) : (
            <FileContent path={item.content} />
          )
        ) : (
          <TextContent content={item.content} onOpenUrl={openUrl} />
        )}

        {/* 划词复制工具条 */}
        {selToolbar && (
          <div
            className="absolute z-20 flex items-center gap-1 px-2 py-1.5 bg-app-bg-elevated rounded-lg shadow-lg border border-app-border animate-in fade-in zoom-in-95 duration-150"
            style={{
              left: `${Math.max(44, Math.min(selToolbar.x, 320))}px`,
              top: `${Math.max(0, selToolbar.y)}px`,
              transform: 'translate(-50%, -100%)',
            }}
            onMouseDown={(e) => {
              e.preventDefault(); // 保持文本选择不被点击清除
              e.stopPropagation();
            }}
          >
            <span className="text-app-text-tertiary text-xs whitespace-nowrap mr-1">
              {selToolbar.text.length} 字符
            </span>
            <button
              onClick={() => {
                onCopyPartial(selToolbar.text);
                setSelToolbar(null);
                window.getSelection()?.removeAllRanges();
              }}
              className="flex items-center gap-1 px-2 py-1 bg-app-brand-primary/20 hover:bg-app-brand-primary/30 text-app-brand-primary-light text-xs rounded transition-colors cursor-pointer"
            >
              <Copy size={12} />
              复制选中
            </button>
          </div>
        )}
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-app-border-subtle text-xs text-app-text-disabled shrink-0">
        <span>⏎ 粘贴 · Ctrl+⏎ 复制 · F 收藏 · Del 删除 · 双击粘贴</span>
        <span className="truncate">{footerRight}</span>
      </div>
    </>
  );
}

// ─── 文本（JSON / 整链 / 普通）────────────────────────────────────────────────

function TextContent({ content, onOpenUrl }: { content: string; onOpenUrl: (url: string) => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const kind = detectTextKind(content);

  // 切换条目时回到格式化视图
  useEffect(() => {
    setShowRaw(false);
  }, [content]);

  if (kind === 'link') {
    return <LinkCard url={content.trim()} onOpenUrl={onOpenUrl} />;
  }

  if (kind === 'json' && !showRaw) {
    const pretty = formatJson(content);
    if (pretty) {
      return (
        <div>
          <div className="flex justify-end mb-2">
            <button
              onClick={() => setShowRaw(true)}
              className="text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-md px-2 py-1 transition-colors cursor-pointer"
            >
              查看原文
            </button>
          </div>
          <pre
            className="bg-app-bg-tertiary rounded-lg p-4 text-xs leading-relaxed overflow-x-auto select-text"
            style={{ fontFamily: MONO_STACK, userSelect: 'text' }}
          >
            {tokenizeJson(pretty).map((token, i) => (
              <span key={i} style={{ color: JSON_TOKEN_COLORS[token.kind] }}>
                {token.text}
              </span>
            ))}
          </pre>
        </div>
      );
    }
  }

  return (
    <div>
      {kind === 'json' && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setShowRaw(false)}
            className="text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-md px-2 py-1 transition-colors cursor-pointer"
          >
            格式化
          </button>
        </div>
      )}
      <p className="text-sm leading-7 text-app-text-secondary whitespace-pre-wrap break-all select-text">
        {linkifyText(content).map((seg, i) =>
          seg.isLink ? (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                onOpenUrl(seg.text);
              }}
              className="text-[#60a5fa] hover:underline cursor-pointer break-all text-left inline"
            >
              {seg.text}
            </button>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </p>
    </div>
  );
}

// ─── 整链卡片 ────────────────────────────────────────────────────────────────

function LinkCard({ url, onOpenUrl }: { url: string; onOpenUrl: (url: string) => void }) {
  // 站点 favicon 替换通用链接图标，加载中/抓取失败回退 Link2
  const favicon = useFavicon(url);

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="w-full flex items-start gap-2.5 bg-app-bg-tertiary rounded-lg px-4 py-3.5">
        {favicon ? (
          <img src={favicon} alt="" className="w-4 h-4 rounded-sm shrink-0 mt-1" />
        ) : (
          <Link2 size={16} className="text-[#60a5fa] shrink-0 mt-1" />
        )}
        <button
          onClick={() => onOpenUrl(url)}
          className="text-sm text-[#60a5fa] hover:underline break-all text-left leading-6 cursor-pointer select-text"
        >
          {url}
        </button>
      </div>
      <button
        onClick={() => onOpenUrl(url)}
        className="flex items-center gap-1.5 text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-md px-2 py-1.5 transition-colors cursor-pointer"
      >
        <ExternalLink size={13} />
        在浏览器打开
      </button>
    </div>
  );
}

// ─── 文件 ────────────────────────────────────────────────────────────────────

function FileContent({ path }: { path: string }) {
  const handleReveal = async () => {
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.error('Failed to reveal file:', err);
    }
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="w-full flex items-center gap-3 bg-app-bg-tertiary rounded-lg px-4 py-3.5">
        <FolderOpen size={18} className="text-[#fbbf24] shrink-0" />
        <span className="text-sm text-app-text-primary break-all leading-6 select-text">{path}</span>
      </div>
      <button
        onClick={handleReveal}
        className="flex items-center gap-1.5 text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-md px-2 py-1.5 transition-colors cursor-pointer"
      >
        <FolderOpen size={13} />
        打开所在文件夹
      </button>
    </div>
  );
}

// ─── 图片 ────────────────────────────────────────────────────────────────────

function ImageContent({ item }: { item: ClipboardItemData }) {
  const [src, setSrc] = useState<string | null>(imageCache.get(item.id) ?? null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    setSrc(imageCache.get(item.id) ?? null);
    setZoomed(false);
    if (imageCache.get(item.id)) return;

    let cancelled = false;
    const load = async () => {
      try {
        const base64 =
          item.content_type === 'image'
            ? await invoke<string>('get_clipboard_image_base64', { id: item.id })
            : await invoke<string>('read_image_file_as_base64', { path: item.content });
        if (!cancelled) {
          imageCache.set(item.id, base64);
          setSrc(base64);
        }
      } catch (err) {
        console.error('Failed to load image:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [item.id, item.content_type, item.content]);

  // 放大态 Esc 关闭
  useEffect(() => {
    if (!zoomed) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 挂 document（冒泡先于壳的 window 监听触发）+ preventDefault 标记已消费，
      // 避免关放大预览的同时被壳的 Escape 带回启动器
      e.preventDefault();
      setZoomed(false);
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [zoomed]);

  if (!src) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-app-text-disabled" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <img
          src={src}
          alt={item.content}
          onClick={() => setZoomed(true)}
          className="max-w-full max-h-full object-contain rounded-lg border border-white/5 cursor-zoom-in"
        />
      </div>

      {/* 放大层用 fixed 但 top-12 让开顶部导航栏（TopNavigationBar h-12），
          导航栏的返回/菜单按钮在放大态保持可用；不用 absolute 是因为
          父级 bodyRef（relative + overflow-y-auto）会把它吞进滚动容器 */}
      {zoomed && (
        <div
          className="fixed inset-x-0 bottom-0 top-12 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
          onClick={() => setZoomed(false)}
        >
          <button
            onClick={() => setZoomed(false)}
            className="absolute top-3 right-3 p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
          <img
            src={src}
            alt={item.content}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
