import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  Plus,
  X,
  Check,
  History,
  MousePointerClick,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { debouncedResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { A2uiSurface } from './a2ui/A2uiSurface';
import { parseActionMessage } from './a2ui/action';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type ChatMode = 'chat';

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

/** 顶栏标题：首条用户消息单行截断（A2UI 操作回传显示胶囊文案，不显示协议 JSON）；
 *  空会话显示「新会话」 */
function sessionTitleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '新会话';
  const action = parseActionMessage(first.content);
  const raw = action ? `点击了「${action.label}」` : first.content;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine;
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
    system: string;
  }
> = {
  chat: {
    label: '贾维斯',
    placeholder: '聊点什么？你的数据他也知道…',
    // 闲聊走贾维斯 agent 通道（claude CLI + MCP 数据工具），系统提示由后端 persona 体系组装
    system: '',
  },
};

/** 距底部该像素范围内视为「贴底」：贴底时流式输出自动跟随，用户上翻超出后暂停跟随 */
const STICK_TO_BOTTOM_PX = 48;

/** 把助手文本切成正文段与内心独白段（<aside>…</aside>）。
 *  未闭合的 <aside> 按「到末尾」处理——流式途中标记尚未到达时样式不断裂。
 *  代码围栏（```）内的 <aside> 是字面量，跳过不解析——模型在示例代码里
 *  写 <aside> 时正文不能被劫持成灰色斜体。 */
function splitAsides(text: string): { aside: boolean; text: string }[] {
  const parts: { aside: boolean; text: string }[] = [];
  let current: { aside: boolean; text: string } | null = null;
  let inCode = false;
  const flush = () => {
    if (current && current.text.length > 0) parts.push(current);
    current = null;
  };
  const emit = (chunk: string, aside: boolean) => {
    if (chunk.length === 0) return;
    if (!current) {
      current = { aside, text: chunk };
      return;
    }
    if (current.aside === aside) {
      current.text += chunk;
      return;
    }
    flush();
    current = { aside, text: chunk };
  };
  for (const rawLine of text.split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inCode = !inCode;
      emit(rawLine + '\n', false);
      continue;
    }
    if (inCode) {
      emit(rawLine + '\n', false);
      continue;
    }
    let rest = rawLine;
    let isAside = false;
    while (rest.length > 0) {
      const tag = isAside ? '</aside>' : '<aside>';
      const idx = rest.indexOf(tag);
      if (idx === -1) {
        emit(rest + '\n', isAside);
        break;
      }
      if (idx > 0) emit(rest.slice(0, idx), isAside);
      rest = rest.slice(idx + tag.length);
      isAside = !isAside;
    }
  }
  flush();
  return parts;
}

/** a2ui 消息的稳定渲染 key：surfaceId 不变，增量合并（数组长度变化）时不重挂载 */
function surfaceKey(content: string): string {
  try {
    return (JSON.parse(content) as { surfaceId?: string }).surfaceId ?? content;
  } catch {
    return content;
  }
}

/** 助手消息渲染：正文走 Markdown，独白段（心声）渲染为灰小斜体 */
function AssistantContent({ text }: { text: string }) {
  return (
    <>
      {splitAsides(text).map((p, i) =>
        p.aside ? (
          <div
            key={i}
            className="my-1.5 pl-3 text-white/45 text-xs italic whitespace-pre-wrap"
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
    <div className="max-w-[80%] px-3 py-2 rounded-xl bg-white/10 text-sm text-zinc-100 break-words">
      {content}
    </div>
  );
}

// ─────────────────────────────────────────────
// ChatView
// ─────────────────────────────────────────────

export function ChatView() {
  const { setActiveView, chatPrefill, setChatPrefill } = useAppStore();

  const [mode, setMode] = useState<ChatMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasResponse, setHasResponse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 取消后终态（副标题「已停止」）；与完成/错误三分，取消不说成「生成完成」
  const [cancelled, setCancelled] = useState(false);
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
  // 会话删除两态确认：armed 后 3s 未确认自动复位
  const [deleteArmedId, setDeleteArmedId] = useState<number | null>(null);
  const deleteTimerRef = useRef<number | null>(null);

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
    // 统一 expanded：有会话显示历史，无会话显示空状态引导
    debouncedResize(WINDOW_SIZE.CHAT.expanded, WINDOW_SIZE.CHAT.width);
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
        setCancelled(false);
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
        setCancelled(false);
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
        setCancelled(false);
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
        setCancelled(false);
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
    setCancelled(false);

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
    } catch (err) {
      setIsLoading(false);
      setError(typeof err === 'string' ? err : '发送失败，请检查 AI 模型设置');
    }
  }, [input, isLoading, messages, mode]);

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
        setCancelled(false);
      } catch (e) {
        console.error('Failed to restore mode session:', e);
      }
    };

    restoreModeSession();
  }, [mode]);

  // ── Cancel streaming ──────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    isCancelledRef.current = true;
    setCancelled(true);
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

  // ── New session ──────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    setHistoryOpen(false);
    // 先取消后端在飞流式，避免旧会话回调继续改状态
    invoke('jarvis_chat_cancel').catch(() => {});
    isCancelledRef.current = true;
    setMessages([]);
    setStreamText('');
    streamTextRef.current = '';
    stickToBottomRef.current = true;
    setHasResponse(false);
    setError(null);
    setCancelled(false);
    setIsLoading(false);
    setAgentStatus(null);
    // 新会话同样展开显示空状态引导（与挂载行为一致）
    debouncedResize(WINDOW_SIZE.CHAT.expanded, WINDOW_SIZE.CHAT.width);

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
      // 先取消后端在飞流式，避免旧会话回调继续改状态
      invoke('jarvis_chat_cancel').catch(() => {});
      // 停掉在飞流式，整体替换内容
      isCancelledRef.current = true;
      setIsLoading(false);
      setStreamText('');
      streamTextRef.current = '';
      setAgentStatus(null);
      setError(null);
      setCancelled(false);
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
      // 乐观移除；失败如实告知（下次打开浮层会重新拉取对齐列表）
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setHistoryIdx(0);
      try {
        await invoke('delete_chat_session', { sessionId: id });
      } catch (e) {
        console.error('Failed to delete session:', e);
        setError('删除会话失败，请重试');
        return;
      }
      if (id === sessionIdRef.current) {
        handleNewSession();
      }
    },
    [handleNewSession],
  );

  // 删除两态确认：第一次点击进入 armed（按钮变红勾），3s 未确认自动复位
  const armDelete = (id: number) => {
    setDeleteArmedId(id);
    if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current);
    deleteTimerRef.current = window.setTimeout(() => {
      setDeleteArmedId((cur) => (cur === id ? null : cur));
    }, 3000);
  };

  const confirmDelete = useCallback(
    (id: number) => {
      if (deleteArmedId === id) {
        if (deleteTimerRef.current) window.clearTimeout(deleteTimerRef.current);
        setDeleteArmedId(null);
        deleteSession(id);
      } else {
        armDelete(id);
      }
    },
    [deleteArmedId, deleteSession],
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
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const s = sessions[historyIdx];
        if (s) confirmDelete(s.id);
      }
    },
    [sessions, historyIdx, switchSession, confirmDelete],
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
    const el = historyPanelRef.current?.querySelectorAll('li')[historyIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [historyIdx, historyOpen]);

  // ── Keyboard handler ──────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        // 保留 Shift+Tab 回启动器；普通 Tab 不再切换模式（翻译已下线）
        e.preventDefault();
        if (e.shiftKey) setActiveView('launcher');
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
    [handleSend, handleCancel, isLoading, setActiveView],
  );

  // ── Computed ──────────────────────────────────────────────────────
  const modeConfig = MODES[mode];
  const visibleMessages = messages.filter((m) => m.role !== 'system');
  const sessionTitle = sessionTitleOf(messages);
  const showCursor = isLoading && streamText.length > 0;
  // 空状态：无历史、无加载、无错误、无流式——显示引导而非空白
  const showEmptyState =
    !hasResponse && !isLoading && !error && streamText.length === 0;

  return (
    <div className="w-full h-full flex flex-col select-none bg-zinc-800/50">
      {/* ── Header：返回 + 会话标题 + 操作组（兼窗口拖拽区） ── */}
      <div className="px-3 py-2 shrink-0 flex items-center gap-2" data-tauri-drag-region>
        <button
          onClick={() => setActiveView('launcher')}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
          aria-label="返回启动器"
          data-tauri-drag-region={undefined}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <span className="flex-1 min-w-0 text-sm font-semibold text-zinc-100 truncate">
          {sessionTitle}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          {!isLoading && (
            <>
              <button
                onClick={handleNewSession}
                className="text-xs px-2 h-7 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="开启新会话"
                data-tauri-drag-region={undefined}
              >
                新会话
              </button>
              <button
                ref={historyBtnRef}
                onClick={toggleHistory}
                className={`flex items-center w-7 h-7 justify-center rounded-md transition-colors cursor-pointer ${
                  historyOpen
                    ? 'text-app-text-primary bg-white/10'
                    : 'text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10'
                }`}
                aria-label="会话历史"
                data-tauri-drag-region={undefined}
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Content area：弹性占满窗口剩余高度 ─────────────────────── */}
      <div
        ref={responseBodyRef}
        onScroll={handleResponseScroll}
        className="px-4 pt-1 pb-4 overflow-y-auto space-y-3 flex-1 min-h-0"
      >
        {/* Empty state：居中 hero——18px/600 主标题（守 18px Ceiling）+ 副标题 + 示例 chip（点击代发） */}
        {showEmptyState && (
          <div className="h-full flex flex-col items-center justify-center gap-3 select-none">
            <span className="text-lg font-semibold text-zinc-100">问我你的电脑</span>
            <span className="text-xs text-app-text-tertiary">
              数据、习惯、剪贴板，他都知道
            </span>
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => handleSend('总结我今天的电脑使用情况')}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:text-zinc-100 hover:bg-white/10 transition-colors cursor-pointer"
              >
                总结我的今天
              </button>
              <button
                onClick={() => handleSend('我最近在忙什么')}
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
            key={msg.contentType === 'a2ui' ? surfaceKey(msg.content) : `${idx}-${msg.role}`}
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
              <div className="max-w-[90%] prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-pre:rounded-lg prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                <AssistantContent text={msg.content} />
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
              <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-pre:rounded-lg prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-a:text-blue-400 prose-strong:text-zinc-200">
                <AssistantContent text={streamText} />
                {showCursor && (
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
      </div>

      {/* ── Input area (bottom) ────────────────────────────────────── */}
      <div className="px-3 py-2.5 shrink-0 border-t border-zinc-700/30">
        <div className="flex items-center gap-2 px-3 py-1.5">
          {/* TODO: 附件/上下文入口占位，逻辑后续加 */}
          <button
            type="button"
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
            aria-label="更多功能"
          >
            <Plus className="w-4 h-4" />
          </button>

          <textarea
            ref={textareaRef}
            id="chat-input"
            aria-label="消息输入框"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={modeConfig.placeholder}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-zinc-200 placeholder-app-text-placeholder outline-none leading-relaxed self-center disabled:opacity-60"
            style={{ height: '26px' }}
          />

          {/* Cancel button (only while loading) */}
          {isLoading && (
            <button
              onClick={handleCancel}
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
              aria-label="取消生成"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* Send button（贾维斯通道在飞时可排队发送） */}
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || (isLoading && mode !== 'chat')}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              input.trim() && (!isLoading || mode === 'chat')
                ? 'text-zinc-200 hover:bg-white/10 cursor-pointer'
                : 'text-zinc-600 cursor-not-allowed'
            }`}
            aria-label="发送消息"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Session history dropdown (fixed 定位，不受布局裁剪影响) ── */}
      {historyOpen && (
        <div
          ref={historyPanelRef}
          tabIndex={-1}
          role="listbox"
          aria-label="会话历史"
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
            <div className="px-3 py-4 text-center text-xs text-app-text-tertiary">
              暂无过往会话
            </div>
          ) : (
            <ul className="py-1">
              {sessions.map((s, i) => (
                <li key={s.id}>
                  <div
                    role="button"
                    tabIndex={-1}
                    onClick={() => switchSession(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        switchSession(s.id);
                      }
                    }}
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
                    {/* 相对时间 hover 时淡出让位删除钮（opacity 过渡，不引起布局跳动） */}
                    <span className="shrink-0 text-[10px] text-app-text-tertiary transition-opacity group-hover:opacity-0">
                      {formatRelativeTime(s.updated_at)}
                    </span>
                    {/* 删除：键盘高亮行（historyIdx）常显，鼠标 hover 显示；两态确认防误触 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        confirmDelete(s.id);
                      }}
                      className={`absolute right-2 w-5 h-5 items-center justify-center rounded transition-all cursor-pointer ${
                        deleteArmedId === s.id
                          ? 'flex text-red-400 hover:bg-white/10'
                          : i === historyIdx
                            ? 'flex text-zinc-400 hover:text-red-400 hover:bg-white/10'
                            : 'hidden group-hover:flex text-zinc-500 hover:text-red-400 hover:bg-white/10'
                      }`}
                      aria-label={deleteArmedId === s.id ? '确认删除会话' : '删除会话'}
                      tabIndex={-1}
                    >
                      {deleteArmedId === s.id ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
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
