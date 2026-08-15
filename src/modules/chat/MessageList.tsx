import { Check, Copy, RotateCcw, Square, Volume2, X } from 'lucide-react';
import { A2uiSurface } from './a2ui/A2uiSurface';
import { AssistantContent, UserMessageBubble } from './MessageBubbles';
import { surfaceKey, type ChatMessage } from './sessionUtils';

interface MessageListProps {
  messages: ChatMessage[];
  streamText: string;
  isLoading: boolean;
  agentStatus: string | null;
  error: string | null;
  cancelled: boolean;
  showEmptyState: boolean;
  retryTargetIdx: number;
  playingIdx: number | null;
  copyFeedback: { idx: number; ok: boolean } | null;
  onDismissError: () => void;
  onSendOverride: (text: string) => void;
  onCopy: (idx: number, content: string) => void;
  onRetry: () => void;
  onSpeak: (idx: number, content: string) => void;
}

/** 内容区消息渲染：空状态引导 / 错误条 / 历史气泡 / 加载行 / 流式气泡 / 取消终态 */
export function MessageList({
  messages,
  streamText,
  isLoading,
  agentStatus,
  error,
  cancelled,
  showEmptyState,
  retryTargetIdx,
  playingIdx,
  copyFeedback,
  onDismissError,
  onSendOverride,
  onCopy,
  onRetry,
  onSpeak,
}: MessageListProps) {
  return (
    <>
      {/* Empty state：居中 hero——18px/600 主标题（守 18px Ceiling）+ 副标题 + 示例 chip（点击代发） */}
      {showEmptyState && (
        <div className="h-full flex flex-col items-center justify-center gap-3 select-none">
          <span className="text-lg font-semibold text-zinc-100">问我你的电脑</span>
          <span className="text-xs text-app-text-tertiary">
            数据、习惯、剪贴板，他都知道
          </span>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => onSendOverride('总结我今天的电脑使用情况')}
              className="text-xs px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:text-zinc-100 hover:bg-white/10 transition-colors cursor-pointer"
            >
              总结我的今天
            </button>
            <button
              onClick={() => onSendOverride('我最近在忙什么')}
              className="text-xs px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:text-zinc-100 hover:bg-white/10 transition-colors cursor-pointer"
            >
              最近在忙什么
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <span className="flex-1 text-sm text-red-400">{error}</span>
          <button
            onClick={onDismissError}
            className="shrink-0 text-red-400 hover:text-red-300 transition-colors"
            aria-label="关闭错误"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* History messages */}
      {messages.map((msg, idx) => (
        <div
          key={msg.contentType === 'a2ui' ? surfaceKey(msg.content) : `${idx}-${msg.role}`}
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {msg.role === 'user' ? (
            <UserMessageBubble content={msg.content} contentType={msg.contentType} />
          ) : msg.contentType === 'a2ui' ? (
            <div className="max-w-[90%] w-full">
              <A2uiSurface
                payloadJson={msg.content}
                onAction={(text) => onSendOverride(text)}
              />
            </div>
          ) : (
            <div className="max-w-[90%] group">
              <div className="prose prose-invert prose-sm max-w-none select-text prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-pre:rounded-lg prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                <AssistantContent text={msg.content} />
              </div>
              {/* 操作行：复制 → 重试（仅最后一轮回服）→ 播报；hover 浮现，
                  播报中/复制反馈瞬间常亮。重试仅挂最后一条——中间轮次的重试
                  意味着删掉后续所有消息，破坏性语义不提供 */}
              <div
                className={`mt-1 flex items-center gap-0.5 transition-all ${
                  playingIdx === idx || copyFeedback?.idx === idx
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onCopy(idx, msg.content)}
                  className={`w-6 h-6 rounded-md flex items-center justify-center transition-all cursor-pointer ${
                    copyFeedback?.idx === idx
                      ? copyFeedback.ok
                        ? 'text-emerald-400'
                        : 'text-red-400'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/10'
                  }`}
                  aria-label={
                    copyFeedback?.idx === idx
                      ? copyFeedback.ok
                        ? '已复制'
                        : '复制失败'
                      : '复制回复'
                  }
                >
                  {copyFeedback?.idx === idx ? (
                    copyFeedback.ok ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <X className="w-3.5 h-3.5" />
                    )
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                {idx === retryTargetIdx && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="w-6 h-6 rounded-md flex items-center justify-center transition-all cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-white/10"
                    aria-label="重新生成回复"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* 重播入口:播报中常亮方块,再点即停 */}
                <button
                  type="button"
                  onClick={() => onSpeak(idx, msg.content)}
                  className={`w-6 h-6 rounded-md flex items-center justify-center transition-all cursor-pointer ${
                    playingIdx === idx
                      ? 'text-indigo-400'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/10'
                  }`}
                  aria-label={playingIdx === idx ? '停止播报' : '朗读这条回复'}
                >
                  {playingIdx === idx ? (
                    <Square className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Loading row（回复行位置）：脉冲点 + 工具活动提示/「正在思考」 */}
      {isLoading && streamText.length === 0 && (
        <div className="flex items-center gap-2 py-2 px-1">
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse"
              style={{ animationDelay: '300ms' }}
            />
          </div>
          <span className="text-xs text-app-text-tertiary" aria-live="polite">
            {agentStatus ?? '正在思考...'}
          </span>
        </div>
      )}

      {/* Streaming assistant response：tool 循环中途的工具活动提示跟在气泡上方 */}
      {streamText.length > 0 && (
        <div className="flex justify-start">
          <div className="max-w-[90%]">
            {isLoading && agentStatus && (
              <div
                className="flex items-center gap-1.5 mb-1 px-1 text-xs text-app-text-tertiary"
                aria-live="polite"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse shrink-0" />
                {agentStatus}
              </div>
            )}
            <div className="prose prose-invert prose-sm max-w-none select-text prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-pre:rounded-lg prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
              <AssistantContent text={streamText} />
              {isLoading && streamText.length > 0 && (
                <span className="inline-block w-0.5 h-4 bg-indigo-400/80 animate-pulse ml-0.5 align-middle" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 取消终态（回复行位置的小字）；完成不显示任何状态——响应内容即终态 */}
      {cancelled && !isLoading && (
        <div className="px-1 text-xs text-app-text-tertiary">已停止</div>
      )}
    </>
  );
}
