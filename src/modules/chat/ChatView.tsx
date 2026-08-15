import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowUp,
  Loader2,
  Mic,
  Plus,
  X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { debouncedResize } from '@/utils/tauri';
import { WINDOW_SIZE } from '@/constants/window';
import { ChatHeader } from './ChatHeader';
import { useVoiceInput } from './useVoiceInput';
import { speakMarkdown, stopSpeech } from '@/utils/speech';
import { buildRichContent, IMAGE_EXTS, TEXT_EXTS } from './attachments';
import { PendingChips, VisionGateDialog } from './RichMessageView';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  historyRowsToMessages,
  sessionTitleOf,
  type ChatHistoryMessage,
  type ChatMessage,
  type ChatSessionSummary,
} from './sessionUtils';
import { MessageList } from './MessageList';
import { useChatStreamEvents } from './useChatStreamEvents';
import { useChatAttachments } from './useChatAttachments';
import { SessionHistoryPanel } from './history/SessionHistoryPanel';

// ─────────────────────────────────────────────
// Mode configuration
// ─────────────────────────────────────────────

const MODE = {
  label: '贾维斯',
  placeholder: '聊点什么？你的数据他也知道…',
  // 闲聊走贾维斯场景模型通道（tool-use 循环 + 数据工具），系统提示由后端 persona 体系组装
  system: '',
} as const;

/** 距底部该像素范围内视为「贴底」：贴底时流式输出自动跟随，用户上翻超出后暂停跟随 */
const STICK_TO_BOTTOM_PX = 48;

// ─────────────────────────────────────────────
// ChatView（编排层：状态 + 会话管理 + 渲染；
// 流式事件在 useChatStreamEvents，附件管线在 useChatAttachments，
// 历史浮层在 history/SessionHistoryPanel）
// ─────────────────────────────────────────────

export function ChatView() {
  const { setActiveView, chatPrefill } = useAppStore();

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
  // 会话历史浮层（条目高亮/两态删除等面板内部状态在 SessionHistoryPanel）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [historyPos, setHistoryPos] = useState({ top: 0, right: 0 });
  // 消息重播：正在播报的消息下标（Rust 播完/被打断广播 moss:tts:done 清态）
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  // 复制反馈：成功勾/失败叉，1.5s 自动复位（按钮即反馈，不弹 toast）
  const [copyFeedback, setCopyFeedback] = useState<{ idx: number; ok: boolean } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamTextRef = useRef('');
  const responseBodyRef = useRef<HTMLDivElement>(null);
  const isCancelledRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  // 用户是否贴在内容区底部（决定流式输出时是否自动跟随滚动）
  const stickToBottomRef = useRef(true);
  const historyBtnRef = useRef<HTMLButtonElement>(null);

  // 卸载时清理复制反馈定时器（防卸载后 setState 与资源滞留）
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // 语音输入：转写文本追加进草稿（待确认后手动发送），错误走统一 error 条
  const voiceInput = useVoiceInput({
    onTranscribed: useCallback((text: string) => {
      setInput((prev) => prev + text);
      textareaRef.current?.focus();
    }, []),
    onError: useCallback((message: string) => setError(message), []),
  });

  /** 复制一条回复原文（markdown 源，含心声标签——与落库口径一致，零解析零失真） */
  const handleCopyMessage = useCallback((idx: number, content: string) => {
    navigator.clipboard.writeText(content).then(
      () => setCopyFeedback({ idx, ok: true }),
      () => setCopyFeedback({ idx, ok: false }),
    );
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyFeedback(null), 1500);
  }, []);

  /** 朗读/停止一条回复:播报中再点即停;新播报后端自动打断旧的 */
  const handleSpeakMessage = useCallback(
    (idx: number, content: string) => {
      if (playingIdx === idx) {
        stopSpeech();
        setPlayingIdx(null);
        return;
      }
      setPlayingIdx(idx);
      void speakMarkdown(content).catch(() => setPlayingIdx(null));
    },
    [playingIdx],
  );

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
            const systemMsg: ChatMessage = { role: 'system', content: MODE.system };
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

    // 视图切换会卸载本组件：后端若仍在生成，isLoading 已随卸载丢失，
    // 取消按钮随之消失（生成却停不下来）。挂载时向后端要一次在飞状态恢复。
    void invoke<boolean>('jarvis_chat_is_generating')
      .then((generating) => {
        if (!generating) return;
        setIsLoading(true);
        // 兜底重查：若 done/error 事件恰好在卸载期间已 emit（监听尚未注册），
        // 之后不会有任何事件来复位加载态——3 秒后重查一次，在飞已复位则自行清掉
        window.setTimeout(async () => {
          const still = await invoke<boolean>('jarvis_chat_is_generating').catch(() => null);
          if (still === false) setIsLoading(false);
        }, 3000);
      })
      .catch(() => {});
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

  // ── 记忆提取 poke ─────────────────────────────────────────────────
  // 聊天消息落库后触发记忆提取防抖（后端 10 分钟静默期后提炼用户事实）
  const pokeRecall = useCallback(() => {
    invoke('jarvis_recall_poke').catch(() => {});
  }, []);

  // 失败兜底回复：请求出错时追加一条不占库的占位 assistant 消息——
  // 没有它，消息流停在用户气泡上，重试按钮（挂最后一条非卡片回复）无处显示。
  // 占位不入库：重试的 truncate 对它空转，重发后由真实回复顶替；
  // 用户不重试直接继续聊，它留在本次屏幕会话里做失败痕迹，恢复历史即消失。
  const appendFailurePlaceholder = useCallback((err: string) => {
    const brief = err.length > 200 ? err.slice(0, 200) + '…' : err;
    setMessages((prev) => [
      ...prev,
      { role: 'assistant' as const, content: `⚠️ 请求失败：${brief}\n\n可点下方重试按钮重新发送。` },
    ]);
  }, []);

  /** 一轮回复收尾（流式事件 hook 回调，llm/jarvis 双通道共用） */
  const handleReplyDone = useCallback(
    async (finalText: string) => {
      // 空回复不追加气泡也不播报（后端无输出即 done 的边界）
      if (finalText) {
        setMessages((prev) => [...prev, { role: 'assistant', content: finalText }]);
      }
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
      // 语音播报回复全文（开关/Key/设备在 Rust 端裁决，失败静默）
      if (finalText) void speakMarkdown(finalText).catch(() => {});
      pokeRecall();
    },
    [pokeRecall],
  );

  /** 流式出错（hook 已置好 error 条）：未取消时补失败占位气泡 */
  const handleReplyError = useCallback(
    (message: string, wasCancelled: boolean) => {
      if (!wasCancelled) appendFailurePlaceholder(message);
    },
    [appendFailurePlaceholder],
  );

  // ── Tauri 流式事件监听（llm/jarvis 双通道 + 取消状态机 + rAF 渲染节流） ──
  useChatStreamEvents({
    isCancelledRef,
    streamTextRef,
    sessionIdRef,
    setStreamText,
    setIsLoading,
    setError,
    setCancelled,
    setAgentStatus,
    setMessages,
    setPlayingIdx,
    onReplyDone: handleReplyDone,
    onReplyError: handleReplyError,
  });

  // ── 附件管线（选择/粘贴 → 视觉门槛 → 压缩落盘/读文本 → 入列） ──
  const {
    attachments,
    fileInputRef,
    visionGateFiles,
    dismissVisionGate,
    addFiles,
    openFilePicker,
    removeAttachment,
    clearAttachments,
    currentVisionState,
    collectVisionCandidates,
    handleVisionSwitch,
  } = useChatAttachments({ sessionIdRef, onError: setError });

  // ── Send message ──────────────────────────────────────────────────
  // overrideText：A2UI 卡片 action 回传时直接代发的文本（不经过输入框）
  const handleSend = useCallback(
    async (overrideText?: string) => {
      const content = (typeof overrideText === 'string' ? overrideText : input).trim();
      // 代发（预填/A2UI 回传）不携带待发附件；手动发送允许纯附件消息
      const withAttachments = typeof overrideText !== 'string' && attachments.length > 0;
      // 贾维斯通道在飞时允许继续发送（后端 FIFO 排队）
      if (!content && !withAttachments) return;
      // 复位取消标记：清空/取消/切换会话会置 true，若不复位，
      // 本轮回复的 chunk 会被监听器全部丢弃，最终消息既不回显也不入库
      isCancelledRef.current = false;
      // 发新消息打断上一条播报（接着念旧回复会很怪）
      stopSpeech();

      // 带附件时 content 统一为 rich JSON——入库与发送用同一串，
      // 后端按 content 比对定位当轮消息（content_type 从库里读）
      const wireContent = withAttachments ? buildRichContent(content, attachments) : content;
      const userMessage: ChatMessage = withAttachments
        ? { role: 'user', content: wireContent, contentType: 'rich' }
        : { role: 'user', content };
      const systemMessage: ChatMessage = {
        role: 'system',
        content: MODE.system,
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
            content: userMessage.content,
            contentType: userMessage.contentType ?? null,
          });
        } catch (e) {
          console.error('Failed to save user message:', e);
        }
      }
      // 发送即触发记忆提取（后端 10 分钟静默期防抖）
      pokeRecall();

      try {
        setAgentStatus(null);
        // 场景模型通道：tool-use 循环在后端，流式事件 jarvis:status / chunk / done / error
        const sid = sessionIdRef.current;
        if (sid === null) throw new Error('会话未就绪，请稍候再试');
        await invoke('jarvis_chat_send_scene', { sessionId: sid, text: userMessage.content });
        // 发送已被后端接管，清空待发附件（失败保留，用户可重发）
        clearAttachments();
      } catch (err) {
        setIsLoading(false);
        setError(typeof err === 'string' ? err : '发送失败，请检查 AI 模型设置');
      }
    },
    [input, messages, attachments, clearAttachments, pokeRecall],
  );

  // Consume prefill: 原文填入输入框（companion 错误分析 / 剪贴板「发送给AI」共用通道，
  // 包装文案由发送方组装）;autoSend(语音输入)走代发通道直接发送,不进草稿。
  // 消费走 consumeChatPrefill 原子取走——本 effect 在 StrictMode/热重挂载下会二次执行,
  // 第二次拿到 null 直接跳过;若分步「读 getState + setChatPrefill(null)」,第二次会用
  // 渲染闭包里的旧 chatPrefill + 已被清空的 autoSend 标记把代发误判成预填
  useEffect(() => {
    if (!chatPrefill) return;
    const claimed = useAppStore.getState().consumeChatPrefill();
    if (!claimed) return;
    if (claimed.autoSend) {
      // 等会话恢复(sessionId 就绪)再代发,否则消息不入库;
      // 2s 轮询上限兜底(restoreSession 总会 setSessionId,含新建分支)
      let tries = 0;
      const trySend = () => {
        if (sessionIdRef.current !== null) {
          void handleSend(claimed.text);
        } else if (++tries < 20) {
          setTimeout(trySend, 100);
        }
      };
      trySend();
      return;
    }
    setInput(claimed.text);
    // 等视图切换渲染完成后聚焦
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [chatPrefill, handleSend]);

  // ── Cancel streaming ──────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    stopSpeech();
    isCancelledRef.current = true;
    setCancelled(true);
    setIsLoading(false);
    setStreamText('');
    streamTextRef.current = '';
    setAgentStatus(null);
    try {
      await invoke('jarvis_chat_cancel_scene');
    } catch (e) {
      console.error('Failed to cancel jarvis chat:', e);
    }
  }, []);

  // ── Retry last turn ───────────────────────────────────────────────
  // 重试 = 删掉该轮 assistant 落库行（含 A2UI 卡片行），用最后一条用户消息
  // 原文重走发送流程；不追加 user 消息、不清输入框草稿。
  const handleRetry = useCallback(async () => {
    if (isLoading) return;
    const sid = sessionIdRef.current;
    if (sid === null) {
      setError('会话未就绪，请稍候再试');
      return;
    }
    // 最后一条用户消息是重试的提示词；其后的所有消息是该轮待删回复
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const text = messages[lastUserIdx].content;
    const removed = messages.slice(lastUserIdx + 1);
    if (removed.length === 0) return;

    stopSpeech();
    setPlayingIdx(null);
    // 复位取消标记（同 handleSend：清空/取消后置过 true，不复位会丢本轮回复）
    isCancelledRef.current = false;

    // 先删库再发送：场景通道发送瞬间就从这个库重建上下文，
    // 顺序反了旧回复会被重新吃进上下文
    try {
      await invoke('truncate_chat_after_last_user', { sessionId: sid });
    } catch (e) {
      console.error('Failed to truncate last turn:', e);
      setError('重试失败：清理旧回复失败');
      return;
    }

    // 乐观移除该轮气泡；发送同步失败时恢复（DB 行已删，恢复仅补 UI，
    // 与库的分叉持续到下一条回复落库——冷角案例，error 条如实告知）
    setMessages(messages.slice(0, lastUserIdx + 1));
    setStreamText('');
    streamTextRef.current = '';
    stickToBottomRef.current = true;
    setIsLoading(true);
    setError(null);
    setCancelled(false);
    setAgentStatus(null);

    try {
      await invoke('jarvis_chat_send_scene', { sessionId: sid, text });
    } catch (err) {
      setMessages((prev) => [...prev, ...removed]);
      setIsLoading(false);
      setError(typeof err === 'string' ? err : '重试失败，请检查 AI 模型设置');
    }
  }, [isLoading, messages]);

  // ── New session ──────────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    setHistoryOpen(false);
    // 先取消后端在飞流式，避免旧会话回调继续改状态
    invoke('jarvis_chat_cancel_scene').catch(() => {});
    stopSpeech();
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

    try {
      const id = await invoke<number>('create_chat_session', { mode: 'chat' });
      setSessionId(id);
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  }, []);

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
    setHistoryLoading(true);
    try {
      const list = await invoke<ChatSessionSummary[]>('list_chat_sessions', { mode: 'chat' });
      setSessions(list);
    } catch (e) {
      console.error('Failed to list sessions:', e);
      setSessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyOpen]);

  const switchSession = useCallback(async (id: number) => {
    if (id === sessionIdRef.current) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(false);
    // 先取消后端在飞流式，避免旧会话回调继续改状态
    invoke('jarvis_chat_cancel_scene').catch(() => {});
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
      const systemMsg: ChatMessage = { role: 'system', content: MODE.system };
      setMessages([systemMsg, ...historyRowsToMessages(msgs)]);
      setHasResponse(msgs.length > 0);
      setSessionId(id);
    } catch (e) {
      console.error('Failed to switch session:', e);
      setError('切换会话失败');
    }
  }, []);

  const deleteSession = useCallback(
    async (id: number) => {
      // 乐观移除；失败如实告知（下次打开浮层会重新拉取对齐列表）
      setSessions((prev) => prev.filter((s) => s.id !== id));
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

  const handleVisionGoSettings = () => {
    useSettingsStore.getState().setPendingTab('model');
    setActiveView('settings');
    dismissVisionGate();
  };

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
  const visibleMessages = messages.filter((m) => m.role !== 'system');
  const sessionTitle = sessionTitleOf(messages);
  // 空状态：无历史、无加载、无错误、无流式——显示引导而非空白
  const showEmptyState =
    !hasResponse && !isLoading && !error && streamText.length === 0;
  // 重试按钮挂载点（visibleMessages 下标）：从尾部扫，撞上用户消息说明最后
  // 一轮尚无回复（出错/取消）不挂；跳过 A2UI 卡片——重试只挂文字气泡，
  // 删除时该轮卡片随「最后一条用户消息之后的所有行」一并清
  let retryTargetIdx = -1;
  if (!isLoading) {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i];
      if (m.role === 'user') break;
      if (m.contentType !== 'a2ui') {
        retryTargetIdx = i;
        break;
      }
    }
  }

  return (
    <div className="w-full h-full flex flex-col select-none panel-glass">
      {/* ── Header：返回 + 会话标题 + 操作组（兼窗口拖拽区） ── */}
      <ChatHeader
        title={sessionTitle}
        isLoading={isLoading}
        historyOpen={historyOpen}
        historyBtnRef={historyBtnRef}
        onBack={() => setActiveView('launcher')}
        onNewSession={handleNewSession}
        onToggleHistory={toggleHistory}
      />

      {/* ── Content area：弹性占满窗口剩余高度 ─────────────────────── */}
      <div
        ref={responseBodyRef}
        onScroll={handleResponseScroll}
        className="px-4 pt-1 pb-4 overflow-y-auto space-y-3 flex-1 min-h-0"
      >
        <MessageList
          messages={visibleMessages}
          streamText={streamText}
          isLoading={isLoading}
          agentStatus={agentStatus}
          error={error}
          cancelled={cancelled}
          showEmptyState={showEmptyState}
          retryTargetIdx={retryTargetIdx}
          playingIdx={playingIdx}
          copyFeedback={copyFeedback}
          onDismissError={() => setError(null)}
          onSendOverride={(text) => handleSend(text)}
          onCopy={handleCopyMessage}
          onRetry={handleRetry}
          onSpeak={handleSpeakMessage}
        />
      </div>

      {/* ── Input area (bottom) ────────────────────────────────────── */}
      <div className="px-3 py-2.5 shrink-0 border-t border-app-border">
        {/* 待发附件 chips：图片缩略图 / 文件卡片，hover 出 × 逐个移除 */}
        {attachments.length > 0 && (
          <PendingChips
            attachments={attachments}
            onRemove={removeAttachment}
          />
        )}
        <div className="flex items-center gap-2 px-3 py-1.5">
          {/* 发送文件入口：隐藏 input 承载系统选择器（File 对象与粘贴管线统一） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={[...IMAGE_EXTS, ...TEXT_EXTS].map((e) => `.${e}`).join(',')}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length > 0) void addFiles(files);
            }}
          />
          <button
            type="button"
            onClick={() => void openFilePicker()}
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
            aria-label="发送文件"
          >
            <Plus className="w-4 h-4" />
          </button>

          <textarea
            ref={textareaRef}
            id="chat-input"
            data-guide="chat-input"
            aria-label="消息输入框"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              // 粘贴截图/文件与选择器共用同一条附件管线；纯文本粘贴走默认行为
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              void addFiles(files);
            }}
            placeholder={MODE.placeholder}
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

          {/* Voice input：点击开始录音、再点停止转写，文本追加进输入框 */}
          <button
            type="button"
            onClick={voiceInput.toggle}
            disabled={voiceInput.state === 'transcribing'}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              voiceInput.state === 'recording'
                ? 'text-red-400 bg-red-400/10 animate-pulse cursor-pointer'
                : voiceInput.state === 'transcribing'
                  ? 'text-zinc-500 cursor-wait'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/10 cursor-pointer'
            }`}
            aria-label={
              voiceInput.state === 'recording'
                ? '停止录音'
                : voiceInput.state === 'transcribing'
                  ? '语音转写中'
                  : '语音输入'
            }
          >
            {voiceInput.state === 'transcribing' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </button>

          {/* Send button（贾维斯通道在飞时可排队发送；纯附件消息也可发） */}
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() && attachments.length === 0}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              input.trim() || attachments.length > 0
                ? 'text-zinc-200 hover:bg-white/10 cursor-pointer'
                : 'text-zinc-600 cursor-not-allowed'
            }`}
            aria-label="发送消息"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 视觉门槛对话框：含图片但当前模型未标视觉时拦截，给一键切换/去设置 */}
      {visionGateFiles !== null && (
        <VisionGateDialog
          candidates={collectVisionCandidates()}
          currentModelName={currentVisionState().modelName}
          onSwitch={(c) => void handleVisionSwitch(c)}
          onGoSettings={handleVisionGoSettings}
          onClose={dismissVisionGate}
        />
      )}

      {/* ── Session history dropdown（fixed 定位，不受布局裁剪影响） ── */}
      {historyOpen && (
        <SessionHistoryPanel
          loading={historyLoading}
          sessions={sessions}
          currentSessionId={sessionId}
          top={historyPos.top}
          right={historyPos.right}
          anchorRef={historyBtnRef}
          onClose={() => setHistoryOpen(false)}
          onSwitch={switchSession}
          onDelete={deleteSession}
        />
      )}
    </div>
  );
}
