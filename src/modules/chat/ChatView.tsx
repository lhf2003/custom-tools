import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  X,
  Copy,
  Check,
  Sparkles,
  Languages,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useLlmProviderStore } from '@/stores/llmProviderStore';
import { invoke } from '@tauri-apps/api/core';
import { debouncedResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type ChatMode = 'chat' | 'translate';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatHistoryMessage {
  id: number;
  role: 'user' | 'assistant';
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
    icon: React.ElementType;
    tagColor: string;
    focusBorder: string;
    system: string;
  }
> = {
  chat: {
    label: '贾维斯',
    placeholder: '聊点什么？你的数据他也知道…',
    icon: Sparkles,
    tagColor: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
    focusBorder: 'border-indigo-500/50',
    // 闲聊走贾维斯 agent 通道（claude CLI + MCP 数据工具），系统提示由后端 persona 体系组装
    system: '',
  },
  translate: {
    label: '翻译',
    placeholder: '输入需要翻译的文本...',
    icon: Languages,
    tagColor: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    focusBorder: 'border-emerald-500/50',
    system:
      '你是专业翻译。请直接给出译文，不要添加任何解释或前言。如果输入是中文，译为英文；如果是其他语言，译为中文。',
  },
};

const MODE_ORDER: ChatMode[] = ['chat', 'translate'];

/** 距底部该像素范围内视为「贴底」：贴底时流式输出自动跟随，用户上翻超出后暂停跟随 */
const STICK_TO_BOTTOM_PX = 48;

/** 把助手文本切成正文段与内心独白段（<aside>…</aside>）。
 *  未闭合的 <aside> 按「到末尾」处理——流式途中标记尚未到达时样式不断裂。 */
function splitAsides(text: string): { aside: boolean; text: string }[] {
  const parts: { aside: boolean; text: string }[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf('<aside>');
    if (start === -1) {
      parts.push({ aside: false, text: rest });
      break;
    }
    if (start > 0) parts.push({ aside: false, text: rest.slice(0, start) });
    const end = rest.indexOf('</aside>', start + 7);
    if (end === -1) {
      parts.push({ aside: true, text: rest.slice(start + 7) });
      break;
    }
    parts.push({ aside: true, text: rest.slice(start + 7, end) });
    rest = rest.slice(end + 8);
  }
  return parts.filter((p) => p.text.length > 0);
}

/** 助手消息渲染：正文走 Markdown，独白段（心声）渲染为灰小斜体 */
function AssistantContent({ text }: { text: string }) {
  return (
    <>
      {splitAsides(text).map((p, i) =>
        p.aside ? (
          <div
            key={i}
            className="my-1.5 pl-3 border-l-2 border-white/10 text-white/35 text-xs italic whitespace-pre-wrap"
          >
            {p.text}
          </div>
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </ReactMarkdown>
        ),
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// ChatView
// ─────────────────────────────────────────────

export function ChatView() {
  const { setActiveView, chatPrefill, setChatPrefill } = useAppStore();
  const { sceneConfigs } = useLlmProviderStore();

  const [mode, setMode] = useState<ChatMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasResponse, setHasResponse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  // 贾维斯 agent 的工具活动提示（「贾维斯在翻数据…」）
  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamTextRef = useRef('');
  const responseBodyRef = useRef<HTMLDivElement>(null);
  const isCancelledRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  // 用户是否贴在内容区底部（决定流式输出时是否自动跟随滚动）
  const stickToBottomRef = useRef(true);

  // Consume companion prefill: wrap raw error content into an analysis prompt
  useEffect(() => {
    if (chatPrefill) {
      setInput(`请分析以下错误日志的原因和解决方案：\n\n${chatPrefill}`);
      setChatPrefill(null);
      setMode('chat');
      // 等视图切换渲染完成后聚焦
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [chatPrefill, setChatPrefill]);

  // keep ref in sync with state (used inside event callbacks)
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // ── Mount: resize window + focus + restore session ─────────────────
  useEffect(() => {
    debouncedResize(WINDOW_SIZE.CHAT.collapsed, WINDOW_SIZE.CHAT.width);
    textareaRef.current?.focus();

    const restoreSession = async () => {
      try {
        const latest = await invoke<number | null>('get_latest_session', { mode: 'chat' });
        if (latest !== null) {
          const msgs = await invoke<ChatHistoryMessage[]>('get_session_messages', {
            sessionId: latest,
          });
          if (msgs.length > 0) {
            const systemMsg: ChatMessage = { role: 'system', content: MODES['chat'].system };
            const restored: ChatMessage[] = msgs.map((m) => ({
              role: m.role,
              content: m.content,
            }));
            setMessages([systemMsg, ...restored]);
            setHasResponse(true);
          }
          setSessionId(latest);
        } else {
          const id = await invoke<number>('create_chat_session', { mode: 'chat' });
          setSessionId(id);
        }
      } catch (e) {
        console.error('Failed to restore session:', e);
      }
    };

    restoreSession();
  }, []);

  // ── Expand window when first response arrives ─────────────────────
  useEffect(() => {
    if (hasResponse) {
      debouncedResize(WINDOW_SIZE.CHAT.expanded, WINDOW_SIZE.CHAT.width);
    }
  }, [hasResponse]);

  // ── Auto-scroll content area during streaming ─────────────────────
  // 只在贴底时跟随流式输出；用户上翻后暂停跟随，回到底部自动恢复
  useEffect(() => {
    const el = responseBodyRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamText, messages]);

  const handleResponseScroll = useCallback(() => {
    const el = responseBodyRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
  }, []);

  // ── Tauri event listeners ─────────────────────────────────────────
  // 聊天消息落库后触发记忆提取防抖（后端 10 分钟静默期后提炼用户事实）
  const pokeRecall = () => {
    invoke('jarvis_recall_poke').catch(() => {});
  };

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
      const u2 = await listen<void>('llm:done', async () => {
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

        // 持久化 assistant 消息
        const sid = sessionIdRef.current;
        if (sid !== null && finalText) {
          try {
            await invoke('save_chat_message', {
              sessionId: sid,
              role: 'assistant',
              content: finalText,
            });
          } catch (e) {
            console.error('Failed to save assistant message:', e);
          }
        }
        pokeRecall();
      });
      const u3 = await listen<string>('llm:error', (event) => {
        isCancelledRef.current = false;
        setError(event.payload);
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
      });

      // 贾维斯 agent 通道（claude CLI 流式协议）
      const u4 = await listen<string>('jarvis:chunk', (event) => {
        if (isCancelledRef.current) return;
        setStreamText((prev) => {
          const next = prev + event.payload;
          streamTextRef.current = next;
          return next;
        });
      });
      const u5 = await listen<number>('jarvis:done', async () => {
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
        setAgentStatus(null);

        const sid = sessionIdRef.current;
        if (sid !== null && finalText) {
          try {
            await invoke('save_chat_message', {
              sessionId: sid,
              role: 'assistant',
              content: finalText,
            });
          } catch (e) {
            console.error('Failed to save assistant message:', e);
          }
        }
        pokeRecall();
      });
      const u6 = await listen<string>('jarvis:error', (event) => {
        isCancelledRef.current = false;
        setAgentStatus(null);
        setError(event.payload);
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
      });
      const u7 = await listen<string>('jarvis:status', (event) => {
        if (!isCancelledRef.current) setAgentStatus(event.payload);
      });

      if (!active) {
        u1(); u2(); u3(); u4(); u5(); u6(); u7();
        return;
      }
      unlistenFns = [u1, u2, u3, u4, u5, u6, u7];
    };

    setupListeners();
    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);


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
    stickToBottomRef.current = true;
    setIsLoading(true);
    setHasResponse(true);
    setError(null);
    setCopied(false);

    // 持久化 user 消息
    const sid = sessionIdRef.current;
    if (sid !== null) {
      try {
        await invoke('save_chat_message', {
          sessionId: sid,
          role: 'user',
          content: input.trim(),
        });
      } catch (e) {
        console.error('Failed to save user message:', e);
      }
    }
    // 记忆提取只看闲聊通道，工具型模式（翻译等）不触发
    if (mode === 'chat') pokeRecall();

    try {
      if (mode === 'chat') {
        setAgentStatus(null);
        const agentAvailable = await invoke<boolean>('jarvis_agent_available');
        if (agentAvailable) {
          // 贾维斯 agent 通道：claude CLI + MCP 数据工具，流式事件 jarvis:*
          await invoke('jarvis_chat_send', { text: userMessage.content });
        } else {
          // Claude Code 未开启：回退场景模型流式（陪伴绑定模型），
          // 系统提示走 persona 体系（无数据工具版）
          const system = await invoke<string>('jarvis_chat_system', {
            withTools: false,
          });
          const sceneMessages = [
            { role: 'system' as const, content: system },
            ...newMessages.filter((m) => m.role !== 'system'),
          ];
          const sceneConfig = sceneConfigs['chat'];
          await invoke('call_llm_stream_by_scene', {
            scene: 'chat',
            messages: sceneMessages,
            thinkingMode: sceneConfig?.thinking_mode ?? false,
          });
        }
      } else {
        // 工具型通道：场景模型流式
        const sceneConfig = sceneConfigs[mode];
        const thinkingMode = sceneConfig?.thinking_mode ?? false;
        await invoke('call_llm_stream_by_scene', {
          scene: mode,
          messages: newMessages,
          thinkingMode,
        });
      }
    } catch (err) {
      setIsLoading(false);
      setError(typeof err === 'string' ? err : '发送失败，请检查 AI 模型设置');
    }
  }, [input, isLoading, messages, mode, sceneConfigs]);

  // ── Cycle mode ────────────────────────────────────────────────────
  const cycleMode = useCallback(() => {
    setMode((prev) => {
      const idx = MODE_ORDER.indexOf(prev);
      return MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    });
  }, []);

  // ── Restore session when mode changes ────────────────────────────
  useEffect(() => {
    const restoreModeSession = async () => {
      // 切换会话后内容整体替换，重新贴底
      stickToBottomRef.current = true;
      try {
        const latest = await invoke<number | null>('get_latest_session', { mode });
        if (latest !== null) {
          const msgs = await invoke<ChatHistoryMessage[]>('get_session_messages', {
            sessionId: latest,
          });
          if (msgs.length > 0) {
            const systemMsg: ChatMessage = { role: 'system', content: MODES[mode].system };
            const restored: ChatMessage[] = msgs.map((m) => ({
              role: m.role,
              content: m.content,
            }));
            setMessages([systemMsg, ...restored]);
            setHasResponse(true);
          } else {
            setMessages([]);
            setHasResponse(false);
          }
          setSessionId(latest);
        } else {
          const id = await invoke<number>('create_chat_session', { mode });
          setSessionId(id);
          setMessages([]);
          setHasResponse(false);
        }
        setStreamText('');
        streamTextRef.current = '';
        setError(null);
      } catch (e) {
        console.error('Failed to restore mode session:', e);
      }
    };

    restoreModeSession();
  }, [mode]);

  // ── Cancel streaming ──────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    isCancelledRef.current = true;
    setIsLoading(false);
    setStreamText('');
    streamTextRef.current = '';
    setAgentStatus(null);
    if (mode === 'chat') {
      try {
        await invoke('jarvis_chat_cancel');
      } catch (e) {
        console.error('Failed to cancel jarvis chat:', e);
      }
    }
  }, [mode]);

  // ── Copy response ─────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1);
    const content = lastAssistant?.content ?? streamText;
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [messages, streamText]);

  // ── Clear conversation — create new session ────────────────────────
  const handleClear = useCallback(async () => {
    isCancelledRef.current = true;
    setMessages([]);
    setStreamText('');
    streamTextRef.current = '';
    stickToBottomRef.current = true;
    setHasResponse(false);
    setError(null);
    setIsLoading(false);
    setAgentStatus(null);
    debouncedResize(WINDOW_SIZE.CHAT.collapsed, WINDOW_SIZE.CHAT.width);

    // 贾维斯通道：同时清掉 claude 侧会话上下文
    if (mode === 'chat') {
      try {
        await invoke('jarvis_chat_reset');
      } catch (e) {
        console.error('Failed to reset jarvis session:', e);
      }
    }

    try {
      const id = await invoke<number>('create_chat_session', { mode });
      setSessionId(id);
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  }, [mode]);

  // ── Keyboard handler ──────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) setActiveView('launcher');
        else cycleMode();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === 'Escape' && isLoading) {
        handleCancel();
      }
    },
    [handleSend, cycleMode, handleCancel, isLoading, setActiveView],
  );

  // ── Computed ──────────────────────────────────────────────────────
  const modeConfig = MODES[mode];
  const ModeIcon = modeConfig.icon;
  const visibleMessages = messages.filter((m) => m.role !== 'system');
  const showCursor = isLoading && streamText.length > 0;
  const statusText = isLoading
    ? (agentStatus ?? (streamText.length > 0 ? '正在输出...' : '正在思考...'))
    : error
      ? '发生错误'
      : '生成完成';

  return (
    <div className="w-full h-full flex flex-col select-none bg-transparent">
      {/* ── Input area (single-row) ──────────────────────────────── */}
      <div className="px-3 py-2 shrink-0" data-tauri-drag-region>
        <div className="flex items-center gap-2 px-3 py-2">
          <ModeIcon className="w-4 h-4 text-zinc-500 shrink-0" />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={modeConfig.placeholder}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none leading-relaxed self-center"
            style={{ height: '22px' }}
            data-tauri-drag-region={undefined}
          />

          {/* Mode tag */}
          <button
            onClick={cycleMode}
            className={`shrink-0 text-[10px] px-2 py-1 rounded-md border font-medium transition-colors cursor-pointer ${modeConfig.tagColor}`}
            tabIndex={-1}
            aria-label="切换模式"
          >
            {modeConfig.label}
            <span className="ml-1 opacity-40 font-mono text-[10px]">Tab</span>
          </button>

          {/* Cancel button (only while loading) */}
          {isLoading && (
            <button
              onClick={handleCancel}
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition-all cursor-pointer"
              aria-label="取消生成"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
              input.trim() && !isLoading
                ? 'text-zinc-200 hover:bg-zinc-700/60 cursor-pointer'
                : 'text-zinc-600 cursor-not-allowed'
            }`}
            aria-label="发送消息"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Response panel — expands below input ──────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: hasResponse ? '1fr' : '0fr',
          transition: 'grid-template-rows 300ms ease',
        }}
      >
        <div className="overflow-hidden">
          {/* Status bar */}
          <div className="px-4 py-2 border-t border-zinc-700/30 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {isLoading && (
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
              )}
              <span className="text-xs text-zinc-500">{statusText}</span>
            </div>
            <div className="flex items-center gap-2">
              {!isLoading && visibleMessages.length > 0 && !error && (
                <button
                  onClick={handleCopy}
                  className="flex items-center text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  aria-label="复制回复"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
              {!isLoading && (
                <button
                  onClick={handleClear}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer"
                  aria-label="清空对话"
                >
                  清空
                </button>
              )}
            </div>
          </div>

          {/* Content area */}
          <div
            ref={responseBodyRef}
            onScroll={handleResponseScroll}
            className="px-4 pt-1 pb-4 overflow-y-auto space-y-3"
            style={{ maxHeight: '460px' }}
          >
            {/* Error state */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                <span className="flex-1 text-sm text-red-400">{error}</span>
                <button
                  onClick={() => setError(null)}
                  className="shrink-0 text-red-400 hover:text-red-300 transition-colors"
                  aria-label="关闭错误"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* History messages */}
            {visibleMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'user' ? (
                  <div className="max-w-[80%] px-3 py-2 rounded-xl bg-zinc-700/60 text-sm text-zinc-200 break-words">
                    {msg.content}
                  </div>
                ) : (
                  <div className="max-w-[90%] prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                    <AssistantContent text={msg.content} />
                  </div>
                )}
              </div>
            ))}

            {/* Loading dots (before stream starts) */}
            {isLoading && streamText.length === 0 && (
              <div className="flex items-center gap-1.5 py-2 px-1">
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
            )}

            {/* Streaming assistant response */}
            {streamText.length > 0 && (
              <div className="flex justify-start">
                <div className="max-w-[90%] prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                  <AssistantContent text={streamText} />
                  {showCursor && (
                    <span className="inline-block w-0.5 h-4 bg-zinc-400 animate-pulse ml-0.5 align-middle" />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
