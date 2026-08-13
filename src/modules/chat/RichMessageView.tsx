/**
 * 聊天附件相关 UI：待发区 chips、rich 消息气泡（图片网格 + 文件卡片）、
 * 视觉门槛对话框（模型未标视觉时的拦截/快捷切换）。
 * 数据协议见 attachments.ts。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, ChevronRight, FileText, ImageOff, Settings, X } from 'lucide-react';
import type { PendingAttachment, RichContent } from './attachments';
import { parseRichContent } from './attachments';

// ── 历史图片（懒加载 data URL + 点击 lightbox）─────────────────────────

/** 单张历史图片：mount 时按需读盘转 data URL（大会话不全量加载），点击看大图 */
function ChatImage({ relPath, size }: { relPath: string; size: 'large' | 'grid' }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<string>('read_chat_image', { path: relPath })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [relPath]);

  const boxClass =
    size === 'large' ? 'max-w-[240px] max-h-[240px]' : 'w-[120px] h-[120px]';

  if (failed) {
    return (
      <div
        className={`${boxClass} w-[120px] rounded-lg border border-white/10 bg-white/5 flex flex-col items-center justify-center gap-1 text-zinc-500`}
      >
        <ImageOff className="w-4 h-4" />
        <span className="text-[10px]">图片已失效</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => src && setZoomed(true)}
        className={`${boxClass} rounded-lg overflow-hidden border border-white/15 bg-white/5 cursor-zoom-in`}
        aria-label="查看大图"
      >
        {src ? (
          <img src={src} alt="聊天图片" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full min-w-[120px] min-h-[120px] animate-pulse bg-white/5" />
        )}
      </button>
      {/* lightbox：fixed 遮罩 + 压缩版大图，点击任意处关闭（不做缩放/拖动） */}
      {zoomed && src && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomed(false)}
        >
          <img
            src={src}
            alt="聊天图片大图"
            className="max-w-full max-h-full rounded-lg object-contain"
          />
        </div>
      )}
    </>
  );
}

// ── 文本文件卡片（气泡内 inline 展开全文）──────────────────────────────

function FileCard({ name, content }: { name: string; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const kb = content.length > 1024 ? `${(content.length / 1024).toFixed(1)}K` : `${content.length}`;
  return (
    <div className="rounded-lg border border-white/15 bg-white/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/5 transition-colors cursor-pointer"
        aria-expanded={expanded}
      >
        <FileText className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
        <span className="flex-1 min-w-0 truncate text-xs text-zinc-200">{name}</span>
        <span className="shrink-0 text-[10px] text-zinc-500">{kb} 字</span>
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <pre className="px-2.5 pb-2 max-h-[240px] overflow-y-auto text-[10px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-all select-text">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── rich 用户气泡：图片网格 + 文件卡片 + 文本 ──────────────────────────

export function UserRichBubble({ content }: { content: string }) {
  const rich = parseRichContent(content);
  // 解析失败（脏数据）回退纯文本气泡，不让 JSON 上屏
  if (!rich) {
    return (
      <div className="max-w-[80%] px-3 py-2 rounded-xl bg-white/10 text-sm text-zinc-100 break-words select-text">
        {content}
      </div>
    );
  }
  return (
    <div className="max-w-[80%] flex flex-col items-end gap-1.5">
      {rich.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {rich.images.map((p) => (
            <ChatImage
              key={p}
              relPath={p}
              size={rich.images.length === 1 ? 'large' : 'grid'}
            />
          ))}
        </div>
      )}
      {rich.files.map((f) => (
        <FileCard key={f.name} name={f.name} content={f.content} />
      ))}
      {rich.text && (
        <div className="px-3 py-2 rounded-xl bg-white/10 text-sm text-zinc-100 break-words select-text whitespace-pre-wrap">
          {rich.text}
        </div>
      )}
    </div>
  );
}

// ── 待发区 chips（输入框上方，逐个可移除）──────────────────────────────

interface PendingChipsProps {
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
}

export function PendingChips({ attachments, onRemove }: PendingChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
      {attachments.map((a, i) => (
        <div
          key={a.kind === 'image' ? a.relPath : a.name}
          className="relative group h-12 rounded-lg border border-white/15 bg-white/5 overflow-hidden"
        >
          {a.kind === 'image' ? (
            <img src={a.dataUrl} alt="待发送图片" className="h-12 w-12 object-cover" />
          ) : (
            <div className="h-12 flex items-center gap-1.5 px-2 max-w-[160px]">
              <FileText className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
              <span className="truncate text-xs text-zinc-300">{a.name}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-zinc-300 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            aria-label="移除附件"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── 视觉门槛对话框 ─────────────────────────────────────────────────────

export interface VisionCandidate {
  providerId: number;
  modelId: string;
  name: string;
  providerLabel: string;
}

interface VisionGateDialogProps {
  /** 已标视觉且启用的候选模型；空 = 用户一个都没标过 → 引导去设置 */
  candidates: VisionCandidate[];
  currentModelName: string | null;
  onSwitch: (c: VisionCandidate) => void;
  onGoSettings: () => void;
  onClose: () => void;
}

export function VisionGateDialog({
  candidates,
  currentModelName,
  onSwitch,
  onGoSettings,
  onClose,
}: VisionGateDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-[320px] rounded-xl border border-app-border bg-app-bg-primary/80 shadow-2xl p-4"
        style={{ WebkitBackdropFilter: 'blur(20px)', backdropFilter: 'blur(20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-zinc-100 font-medium">当前模型看不了图片</div>
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
          {currentModelName
            ? `「${currentModelName}」未标记视觉能力。发图片需要先切到支持视觉的模型。`
            : '当前聊天未配置模型。发图片需要先选择支持视觉的模型。'}
        </p>

        {candidates.length > 0 ? (
          <div className="mt-3 max-h-[180px] overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
            {candidates.map((c) => (
              <button
                key={`${c.providerId}:${c.modelId}`}
                type="button"
                onClick={() => onSwitch(c)}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/10 transition-colors cursor-pointer"
              >
                <Bot className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                <span className="flex-1 min-w-0 truncate text-xs text-zinc-200">{c.name}</span>
                <span className="shrink-0 text-[10px] text-zinc-500">{c.providerLabel}</span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={onGoSettings}
            className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-app-brand-primary/90 hover:bg-app-brand-primary text-white text-xs transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
            去设置标记视觉模型
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
        >
          取消
        </button>
      </div>
    </div>
  );
}
