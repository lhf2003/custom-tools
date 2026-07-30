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
  History,
  MousePointerClick,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useLlmProviderStore } from '@/stores/llmProviderStore';
import { invoke } from '@tauri-apps/api/core';
import { debouncedResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { A2uiSurface } from './a2ui/A2uiSurface';
import { parseActionMessage } from './a2ui/action';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type ChatMode = 'chat' | 'translate';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** a2ui = A2UI 界面卡片（content 为 SurfacePayload JSON）；缺省 markdown */
  contentType?: 'markdown' | 'a2ui';
}

interface ChatHistoryMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  content_type: string;
}

interface ChatSessionSummary {
  id: number;
  preview: string;
  updated_at: string;
}

/** 摘要单行化并截断（历史列表条目用） */
function previewText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
}

/**
 * 合并一条 a2ui 消息进消息列表：同一 surfaceId 的多次 render_ui 调用
 * （创建 → 增量更新 → 删除）合并为一个气泡，消息数组按序追加（重放语义）。
 */
function mergeA2uiRow(list: ChatMessage[], content: string): ChatMessage[] {
  let payload: { surfaceId?: string; messages?: unknown[] };
  try {
    payload = JSON.parse(content);
  } catch {
    return list;
  }
  if (!payload.surfaceId || !Array.isArray(payload.messages)) return list;
  const idx = list.findIndex((m) => {
    if (m.contentType !== 'a2ui') return false;
    try {
      return JSON.parse(m.content).surfaceId === payload.surfaceId;
    } catch {
      return false;
    }
  });
  if (idx === -1) {
    return [...list, { role: 'assistant' as const, content, contentType: 'a2ui' as const }];
  }
  const prev = JSON.parse(list[idx].content) as { messages: unknown[] };
  const merged = JSON.stringify({
    ...prev,
    messages: [...prev.messages, ...(payload.messages as unknown[])],
  });
  return list.map((m, i) => (i === idx ? { ...m, content: merged } : m));
}

/** 历史行 → 渲染消息：a2ui 行按 surfaceId 合并，其余原样 */
function historyRowsToMessages(rows: ChatHistoryMessage[]): ChatMessage[] {
  let out: ChatMessage[] = [];
  for (const m of rows) {
    if (m.content_type === 'a2ui') {
      out = mergeA2uiRow(out, m.content);
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** chat 表时间列为本地时间（datetime('now','localtime')），按本地解析转相对时间 */
function formatRelativeTime(localTime: string): string {
  const t = new Date(localTime.replace(' ', 'T'));
  if (Number.isNaN(t.getTime())) return '';
  const diffMin = Math.floor((Date.now() - t.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return `${t.getMonth() + 1}月${t.getDate()}日`;
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

/** 用户消息气泡：界面操作回传渲染为紧凑胶囊（协议 JSON 不上屏，落库原文不变），
 *  其余为普通气泡 */
function UserMessageBubble({ content }: { content: string }) {
  const action = parseActionMessage(content);
  if (action) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-700/40 border border-zinc-600/40 text-xs text-zinc-400">
        <MousePointerClick className="w-3 h-3 shrink-0" />
        点击了「{action.label}」
      </div>
    );
  }
  return (
    <div className="max-w-[80%] px-3 py-2 rounded-xl bg-zinc-700/60 text-sm text-zinc-200 break-words">
      {content}
    </div>
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
  // 会话历史浮层
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const [historyPos, setHistoryPos] = useState({ top: 0, right: 0 });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamTextRef = useRef('');
  const responseBodyRef = useRef<HTMLDivElement>(null);
  const isCancelledRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  // 用户是否贴在内容区底部（决定流式输出时是否自动跟随滚动）
  const stickToBottomRef = useRef(true);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);

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
            setMessages([systemMsg, ...historyRowsToMessages(msgs)]);
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
        // ref 同步更新（真值源）：state updater 是异步的，chunk 与 done
        // 背靠背到达时 done 会读到旧 ref，把回复弄丢（空消息+不落库）
        streamTextRef.current += event.payload;
        setStreamText(streamTextRef.current);
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
        // 同 llm:chunk：ref 必须同步累加，否则 done 读不到（场景回退通道
        // 非流式，chunk 与 done 仅差 1ms，必现此坑）
        streamTextRef.current += event.payload;
        setStreamText(streamTextRef.current);
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
      // 新一轮回复开始（首条与队列续发统一信号）：复位流式状态
      const u8 = await listen<void>('jarvis:start', () => {
        setIsLoading(true);
        setError(null);
        setStreamText('');
        streamTextRef.current = '';
      });
      // A2UI 界面卡片（render_ui 工具，tool 循环中途到达）：同 surface 合并为一个气泡。
      // 落库由后端在 emit 时完成（前端 done 落库的只是文字回复）
      const u9 = await listen<{ sessionId: number; surfaceId: string; messages: unknown[] }>(
        'jarvis:surface',
        (event) => {
          if (isCancelledRef.current) return;
          if (event.payload.sessionId !== sessionIdRef.current) return;
          setMessages((prev) =>
            mergeA2uiRow(prev, JSON.stringify(event.payload)),
          );
        },
      );

      if (!active) {
        u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); u9();
        return;
      }
      unlistenFns = [u1, u2, u3, u4, u5, u6, u7, u8, u9];
    };

    setupListeners();
    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);


  // ── Send message ──────────────────────────────────────────────────
  // overrideText：A2UI 卡片 action 回传时直接代发的文本（不经过输入框）
  const handleSend = useCallback(async (overrideText?: string) => {
    const content = (typeof overrideText === 'string' ? overrideText : input).trim();
    // 贾维斯通道在飞时允许继续发送（后端 FIFO 排队）；工具型模式保持单飞拦截
    if (!content || (isLoading && mode !== 'chat')) return;
    // 复位取消标记：清空/取消/切换会话会置 true，若不复位，
    // 本轮回复的 chunk 会被监听器全部丢弃，最终消息既不回显也不入库
    isCancelledRef.current = false;

    const userMessage: ChatMessage = { role: 'user', content };
    const systemMessage: ChatMessage = {
      role: 'system',
      content: MODES[mode].system,
    };
    const newMessages =
      messages.length === 0
        ? [systemMessage, userMessage]
        : [...messages, userMessage];

    setMessages(newMessages);
    // 代发不碰输入框草稿；手动发送才清空
    if (typeof overrideText !== 'string') setInput('');
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
          content,
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
          // Claude Code 未开启：场景模型回退通道（tool-use 循环在后端，
          // 事件契约与 agent 通道一致：jarvis:status / chunk / done / error）
          const sid = sessionIdRef.current;
          if (sid === null) throw new Error('会话未就绪，请稍候再试');
          await invoke('jarvis_chat_send_scene', { sessionId: sid, text: userMessage.content });
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
      // 切换会话后内容整体替换，重新贴底；历史浮层随模式切换关闭
      stickToBottomRef.current = true;
      setHistoryOpen(false);
      try {
        const latest = await invoke<number | null>('get_latest_session', { mode });
        if (latest !== null) {
          const msgs = await invoke<ChatHistoryMessage[]>('get_session_messages', {
            sessionId: latest,
          });
          if (msgs.length > 0) {
            const systemMsg: ChatMessage = { role: 'system', content: MODES[mode].system };
            setMessages([systemMsg, ...historyRowsToMessages(msgs)]);
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
    // 复制最近一条文字回复（a2ui 卡片是协议 JSON，不是给人读的文本）
    const lastAssistant = messages
      .filter((m) => m.role === 'assistant' && m.contentType !== 'a2ui')
      .at(-1);
    const content = lastAssistant?.content ?? streamText;
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [messages, streamText]);

  // ── New session ──────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    setHistoryOpen(false);
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

  // ── Session history dropdown ──────────────────────────────────────
  const toggleHistory = useCallback(async () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    const rect = historyBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setHistoryPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setHistoryOpen(true);
    setHistoryIdx(0);
    setHistoryLoading(true);
    try {
      const list = await invoke<ChatSessionSummary[]>('list_chat_sessions', { mode });
      setSessions(list);
    } catch (e) {
      console.error('Failed to list sessions:', e);
      setSessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyOpen, mode]);

  const switchSession = useCallback(
    async (id: number) => {
      if (id === sessionIdRef.current) {
        setHistoryOpen(false);
        return;
      }
      setHistoryOpen(false);
      // 停掉在飞流式，整体替换内容
      isCancelledRef.current = true;
      setIsLoading(false);
      setStreamText('');
      streamTextRef.current = '';
      setAgentStatus(null);
      setError(null);
      stickToBottomRef.current = true;
      try {
        const msgs = await invoke<ChatHistoryMessage[]>('get_session_messages', {
          sessionId: id,
        });
        const systemMsg: ChatMessage = { role: 'system', content: MODES[mode].system };
        setMessages([systemMsg, ...historyRowsToMessages(msgs)]);
        setHasResponse(msgs.length > 0);
        setSessionId(id);
        // 贾维斯 agent 上下文无法随历史会话复原，按新话题重置
        if (mode === 'chat') {
          await invoke('jarvis_chat_reset').catch(() => {});
        }
      } catch (e) {
        console.error('Failed to switch session:', e);
        setError('切换会话失败');
      }
    },
    [mode],
  );

  const deleteSession = useCallback(
    async (id: number) => {
      // 乐观移除，失败仅记日志（下次打开浮层会重新拉取对齐）
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setHistoryIdx(0);
      try {
        await invoke('delete_chat_session', { sessionId: id });
      } catch (e) {
        console.error('Failed to delete session:', e);
      }
      if (id === sessionIdRef.current) {
        handleNewSession();
      }
    },
    [handleNewSession],
  );

  const handleHistoryKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setHistoryOpen(false);
        return;
      }
      if (sessions.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHistoryIdx((i) => Math.min(i + 1, sessions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHistoryIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const s = sessions[historyIdx];
        if (s) switchSession(s.id);
      }
    },
    [sessions, historyIdx, switchSession],
  );

  // 浮层开合动效（reduced-motion 由 motion-reduce 变体降级）
  useEffect(() => {
    if (historyOpen) {
      const raf = requestAnimationFrame(() => setHistoryVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setHistoryVisible(false);
  }, [historyOpen]);

  // 打开后聚焦面板以接收键盘导航
  useEffect(() => {
    if (historyOpen && !historyLoading) historyPanelRef.current?.focus();
  }, [historyOpen, historyLoading]);

  // 点击浮层外部关闭
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (historyPanelRef.current?.contains(t) || historyBtnRef.current?.contains(t)) return;
      setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [historyOpen]);

  // 键盘导航时保持高亮条目可见
  useEffect(() => {
    if (!historyOpen) return;
    historyPanelRef.current
      ?.querySelectorAll('li')
      [historyIdx]?.scrollIntoView({ block: 'nearest' });
  }, [historyIdx, historyOpen]);

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

          {/* Send button（贾维斯通道在飞时可排队发送） */}
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || (isLoading && mode !== 'chat')}
            className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
              input.trim() && (!isLoading || mode === 'chat')
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
      {/* flex-1 + minmax(0,1fr)：面板跟随窗口拉伸，内容区高度不再写死 */}
      <div
        className="flex-1 min-h-0"
        style={{
          display: 'grid',
          gridTemplateRows: hasResponse ? 'minmax(0, 1fr)' : '0fr',
          transition: 'grid-template-rows 300ms ease',
        }}
      >
        <div className="overflow-hidden h-full flex flex-col">
          {/* Status bar */}
          <div className="px-4 py-2 border-t border-zinc-700/30 flex items-center justify-between shrink-0">
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
                <>
                  <button
                    onClick={handleNewSession}
                    className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer"
                    aria-label="开启新会话"
                  >
                    新会话
                  </button>
                  <button
                    ref={historyBtnRef}
                    onClick={toggleHistory}
                    className={`flex items-center transition-colors cursor-pointer ${
                      historyOpen ? 'text-zinc-300' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                    aria-label="会话历史"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Content area：弹性占满窗口剩余高度，随手动拉伸变化 */}
          <div
            ref={responseBodyRef}
            onScroll={handleResponseScroll}
            className="px-4 pt-1 pb-4 overflow-y-auto space-y-3 flex-1 min-h-0"
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
                  <UserMessageBubble content={msg.content} />
                ) : msg.contentType === 'a2ui' ? (
                  <div className="max-w-[90%] w-full">
                    <A2uiSurface
                      payloadJson={msg.content}
                      onAction={(text) => handleSend(text)}
                    />
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

      {/* ── Session history dropdown (fixed，绕开外层 overflow-hidden 裁剪) ── */}
      {historyOpen && (
        <div
          ref={historyPanelRef}
          tabIndex={-1}
          onKeyDown={handleHistoryKeyDown}
          className={`fixed z-50 w-80 max-h-80 overflow-y-auto rounded-lg border border-zinc-700/60 bg-zinc-800 shadow-xl shadow-black/40 outline-none transition-all duration-150 ease-out motion-reduce:transition-none ${
            historyVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
          }`}
          style={{ top: historyPos.top, right: historyPos.right }}
        >
          {historyLoading ? (
            <div className="p-3 space-y-2">
              <div className="h-4 rounded bg-zinc-700/60 animate-pulse" />
              <div className="h-4 rounded bg-zinc-700/40 animate-pulse w-3/4" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-zinc-500">
              还没有历史会话
            </div>
          ) : (
            <ul className="py-1">
              {sessions.map((s, i) => (
                <li key={s.id}>
                  <div
                    role="button"
                    tabIndex={-1}
                    onClick={() => switchSession(s.id)}
                    onMouseEnter={() => setHistoryIdx(i)}
                    className={`group relative flex items-center gap-2 px-3 py-2 cursor-pointer ${
                      i === historyIdx ? 'bg-white/5' : ''
                    }`}
                  >
                    {s.id === sessionId && (
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                    )}
                    <span className="flex-1 truncate text-xs text-zinc-300">
                      {previewText(s.preview)}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-500 group-hover:invisible">
                      {formatRelativeTime(s.updated_at)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                      className="absolute right-2 hidden group-hover:flex w-5 h-5 items-center justify-center rounded text-zinc-500 hover:text-red-400 hover:bg-white/10 cursor-pointer"
                      aria-label="删除会话"
                      tabIndex={-1}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
