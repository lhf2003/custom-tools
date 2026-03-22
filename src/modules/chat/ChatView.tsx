import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { debouncedResize, safeInvoke } from '@/utils/tauri';
import { THEME } from '@/constants/theme';
import { WINDOW_SIZE } from '@/constants/window';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type ChatMode = 'chat' | 'qa' | 'translate';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ─────────────────────────────────────────────
// Mode configuration
// ─────────────────────────────────────────────

const MODES: Record<
  ChatMode,
  {
    label: string;
    placeholder: string;
    tagColor: string;
    focusBorder: string;
    focusShadow: string;
    system: string;
  }
> = {
  chat: {
    label: '闲聊',
    placeholder: 'Hi，你想聊些什么？',
    tagColor: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    focusBorder: 'border-blue-500/60',
    focusShadow: '0 0 0 2px rgba(59,130,246,0.15)',
    system: '你是一个友好、轻松的聊天助手。用中文回答，语气自然亲切。',
  },
  qa: {
    label: '问答',
    placeholder: '请输入你需要解答的问题...',
    tagColor: 'bg-violet-500/20 text-violet-300 border border-violet-500/30',
    focusBorder: 'border-violet-500/60',
    focusShadow: '0 0 0 2px rgba(139,92,246,0.15)',
    system:
      '你是一个专业的知识助手。请用简洁、准确的中文回答问题，优先给出核心答案，再做适当补充。',
  },
  translate: {
    label: '翻译',
    placeholder: '输入需要翻译的文本...',
    tagColor: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    focusBorder: 'border-emerald-500/60',
    focusShadow: '0 0 0 2px rgba(16,185,129,0.15)',
    system:
      '你是专业翻译。请直接给出译文，不要添加任何解释或前言。如果输入是中文，译为英文；如果是其他语言，译为中文。',
  },
};

const MODE_ORDER: ChatMode[] = ['chat', 'qa', 'translate'];

// ─────────────────────────────────────────────
// ChatView
// ─────────────────────────────────────────────

export function ChatView() {
  const { setActiveView } = useAppStore();

  // Local state
  const [mode, setMode] = useState<ChatMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasResponse, setHasResponse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamTextRef = useRef('');
  const responseBodyRef = useRef<HTMLDivElement>(null);
  const isCancelledRef = useRef(false);

  // ── Mount: set window height, auto-focus ──────────────────────────
  useEffect(() => {
    debouncedResize(WINDOW_SIZE.CHAT.collapsed);
    textareaRef.current?.focus();
  }, []);

  // ── Expand window when a response arrives ────────────────────────
  useEffect(() => {
    if (hasResponse) {
      debouncedResize(WINDOW_SIZE.CHAT.expanded);
    }
  }, [hasResponse]);

  // ── Auto-scroll response area when streaming ─────────────────────
  useEffect(() => {
    if (responseBodyRef.current) {
      responseBodyRef.current.scrollTop = responseBodyRef.current.scrollHeight;
    }
  }, [streamText]);

  // ── Tauri event listeners ─────────────────────────────────────────
  useEffect(() => {
    let active = true;
    let unlistenFns: Array<() => void> = [];

    const setupListeners = async () => {
      const u1 = await listen<string>('llm:chunk', (event) => {
        if (isCancelledRef.current) return;
        setStreamText((prev) => {
          const next = prev + event.payload;
          streamTextRef.current = next;
          return next;
        });
      });
      const u2 = await listen<void>('llm:done', () => {
        if (isCancelledRef.current) {
          isCancelledRef.current = false;
          setIsLoading(false);
          return;
        }
        const finalText = streamTextRef.current;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant' as const, content: finalText },
        ]);
        setStreamText('');
        streamTextRef.current = '';
        setIsLoading(false);
      });
      const u3 = await listen<string>('llm:error', (event) => {
        isCancelledRef.current = false;
        setError(event.payload);
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
      });

      if (!active) {
        u1(); u2(); u3();
        return;
      }
      unlistenFns = [u1, u2, u3];
    };

    setupListeners();

    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);

  // ── Textarea auto-height ──────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
  }, [input]);

  // ── Send message ──────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: input.trim() };
    const systemMessage: ChatMessage = {
      role: 'system',
      content: MODES[mode].system,
    };

    const newMessages =
      messages.length === 0
        ? [systemMessage, userMessage]
        : [...messages, userMessage];

    setMessages(newMessages);
    setInput('');
    setStreamText('');
    streamTextRef.current = '';
    setIsLoading(true);
    setHasResponse(true);
    setError(null);

    try {
      await invoke('call_llm_stream', { messages: newMessages });
    } catch (err) {
      // Command-level failure (before any stream event could be emitted)
      setIsLoading(false);
      setError(typeof err === 'string' ? err : '发送失败，请检查 AI 模型设置');
    }
  }, [input, isLoading, messages, mode]);

  // ── Keyboard handler ──────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          setActiveView('launcher');
        } else {
          setMode((prev) => {
            const idx = MODE_ORDER.indexOf(prev);
            return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
          });
        }
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (e.key === 'Escape' && isLoading) {
        isCancelledRef.current = true;
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
      }
    },
    [handleSend, isLoading, setActiveView],
  );

  // ── Computed ──────────────────────────────────────────────────────
  const modeConfig = MODES[mode];
  const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
  const renderedContent = isLoading
    ? streamText
    : (lastAssistant?.content ?? '');
  const showCursor = isLoading && streamText.length > 0;

  return (
    <div
      className="w-full flex flex-col rounded-lg overflow-hidden select-none"
      style={{ backgroundColor: THEME.BG_PRIMARY }}
      data-tauri-drag-region
    >
      {/* ── Drag region header (thin strip) ───────────────────────── */}
      <div
        className="w-full h-2 flex-shrink-0"
        data-tauri-drag-region
      />

      {/* ── Response area (expandable) ────────────────────────────── */}
      <div
        className="response-grid overflow-hidden"
        style={{
          display: 'grid',
          gridTemplateRows: hasResponse ? '1fr' : '0fr',
          transition: 'grid-template-rows 300ms ease',
        }}
      >
        <div className="overflow-hidden">
          <div
            ref={responseBodyRef}
            className="px-4 pt-3 pb-2 overflow-y-auto"
            style={{
              maxHeight: '350px',
              backgroundColor: THEME.BG_SECONDARY,
            }}
          >
            {/* Error state */}
            {error && (
              <div className="flex items-start gap-2 mb-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                <span className="flex-1 text-sm text-red-400">{error}</span>
                <button
                  onClick={() => setError(null)}
                  className="flex-shrink-0 text-red-400 hover:text-red-300 transition-colors"
                  aria-label="关闭错误"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Loading dots (before any stream text) */}
            {isLoading && streamText.length === 0 && (
              <div className="flex items-center gap-1.5 py-2 px-1">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            )}

            {/* Markdown response */}
            {renderedContent.length > 0 && (
              <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {renderedContent}
                </ReactMarkdown>
                {showCursor && (
                  <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            )}
          </div>

          {/* Conversation history (user messages) */}
          {messages.filter((m) => m.role === 'user').length > 0 && (
            <div className="px-4 py-2 border-t border-zinc-700/50">
              <div className="flex flex-col gap-1 max-h-24 overflow-y-auto">
                {messages
                  .filter((m) => m.role === 'user')
                  .map((msg, idx) => (
                    <div
                      key={idx}
                      className="text-xs text-zinc-500 truncate"
                    >
                      <span className="text-zinc-600 mr-1">你：</span>
                      {msg.content}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Input area ────────────────────────────────────────────── */}
      <div
        className="px-3 py-3 flex-shrink-0"
        style={{ backgroundColor: THEME.BG_PRIMARY }}
        data-tauri-drag-region
      >
        <div
          className={`relative rounded-xl border transition-all duration-200 ${isFocused ? modeConfig.focusBorder : 'border-zinc-600/40'}`}
          style={{
            backgroundColor: THEME.BG_SECONDARY,
            boxShadow: isFocused ? modeConfig.focusShadow : 'none',
          }}
        >
          {/* Mode tag (top-right corner inside textarea wrapper) */}
          <div className="absolute right-3 top-2.5 z-10 flex items-center gap-1.5 pointer-events-none">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${modeConfig.tagColor}`}
            >
              {modeConfig.label}
            </span>
            <span className="text-[10px] text-zinc-600">Tab 切换</span>
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={modeConfig.placeholder}
            rows={1}
            className="w-full resize-none bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none px-3 pt-2.5 pb-10 pr-28 leading-relaxed"
            style={{ minHeight: '42px', maxHeight: '100px' }}
            // Prevent drag-region from interfering with text selection
            data-tauri-drag-region={undefined}
          />

          {/* Send button (bottom-right) */}
          <div className="absolute right-2.5 bottom-2.5 flex items-center gap-2">
            {/* Cancel while loading */}
            {isLoading && (
              <button
                onClick={() => {
                  isCancelledRef.current = true;
                  setIsLoading(false);
                  setStreamText('');
                  streamTextRef.current = '';
                }}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition-all"
                title="取消"
                aria-label="取消生成"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Send */}
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                input.trim() && !isLoading
                  ? 'bg-blue-500 hover:bg-blue-400 text-white shadow-md'
                  : 'bg-zinc-700/60 text-zinc-500 cursor-not-allowed'
              }`}
              title="发送 (Enter)"
              aria-label="发送消息"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Bottom hint */}
        <div className="mt-1.5 px-1 flex items-center justify-between">
          <span className="text-[10px] text-zinc-600">
            Shift+Tab 返回启动器 · Enter 发送 · Shift+Enter 换行
          </span>
          {hasResponse && (
            <button
              onClick={() => {
                setMessages([]);
                setStreamText('');
                streamTextRef.current = '';
                setHasResponse(false);
                setError(null);
                setIsLoading(false);
                debouncedResize(WINDOW_SIZE.CHAT.collapsed);
              }}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              清空对话
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
