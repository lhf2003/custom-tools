import { useEffect, useRef, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  Copy,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  Square,
  Volume2,
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
import { ModelSelector } from './ModelSelector';
import { useVoiceInput } from './useVoiceInput';
import { speakMarkdown, stopSpeech } from '@/utils/speech';
import {
  buildRichContent,
  classifyFileName,
  compressImage,
  IMAGE_EXTS,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  readTextFile,
  richDisplayText,
  TEXT_EXTS,
  type PendingAttachment,
} from './attachments';
import {
  PendingChips,
  UserRichBubble,
  VisionGateDialog,
  type VisionCandidate,
} from './RichMessageView';
import { useLlmProviderStore } from '@/stores/llmProviderStore';
import { useSettingsStore } from '@/stores/settingsStore';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type ChatMode = 'chat';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** a2ui = A2UI 界面卡片（content 为 SurfacePayload JSON）；
   *  rich = 附件消息（content 为附件 JSON，协议见 attachments.ts）；缺省 markdown */
  contentType?: 'markdown' | 'a2ui' | 'rich';
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

/** 摘要单行化并截断（历史列表条目用）；rich 会话的首条消息是附件 JSON，降级为引用标签 */
function previewText(text: string): string {
  const richText = richDisplayText(text);
  const oneLine = (richText ?? text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
}

/** 顶栏标题：首条用户消息单行截断（A2UI 操作回传显示胶囊文案，不显示协议 JSON）；
 *  空会话显示「新会话」 */
function sessionTitleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '新会话';
  const action = parseActionMessage(first.content);
  const richText = first.contentType === 'rich' ? richDisplayText(first.content) : null;
  const raw = action ? `点击了「${action.label}」` : (richText ?? first.content);
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

/** 历史行 → 渲染消息：a2ui 行按 surfaceId 合并，rich 行带类型分发附件渲染，其余原样 */
function historyRowsToMessages(rows: ChatHistoryMessage[]): ChatMessage[] {
  let out: ChatMessage[] = [];
  for (const m of rows) {
    if (m.content_type === 'a2ui') {
      out = mergeA2uiRow(out, m.content);
    } else if (m.content_type === 'rich') {
      out.push({ role: m.role, content: m.content, contentType: 'rich' });
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
    // 闲聊走贾维斯场景模型通道（tool-use 循环 + 数据工具），系统提示由后端 persona 体系组装
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
 *  rich 附件消息走图片网格 + 文件卡片，其余为普通气泡；
 *  均开放文本选择（根容器 select-none，气泡单独放开） */
function UserMessageBubble({
  content,
  contentType,
}: {
  content: string;
  contentType?: ChatMessage['contentType'];
}) {
  const action = parseActionMessage(content);
  if (action) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-700/40 border border-zinc-600/40 text-xs text-zinc-400 select-text">
        <MousePointerClick className="w-3 h-3 shrink-0" />
        点击了「{action.label}」
      </div>
    );
  }
  if (contentType === 'rich') {
    return <UserRichBubble content={content} />;
  }
  return (
    <div className="max-w-[80%] px-3 py-2 rounded-xl bg-white/10 text-sm text-zinc-100 break-words select-text">
      {content}
    </div>
  );
}

// ─────────────────────────────────────────────
// ChatView
// ─────────────────────────────────────────────

export function ChatView() {
  const { setActiveView, chatPrefill } = useAppStore();

  const [mode, setMode] = useState<ChatMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 待发附件（rich 消息）：图片已压缩落盘持相对路径，文本文件 inline 持内容
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 视觉门槛对话框：非空 = 待处理文件被拦截（含图片但当前模型未标视觉）
  const [visionGateFiles, setVisionGateFiles] = useState<File[] | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 系统文件选择器进行中标记：选择器打开会夺走主窗口焦点，
  // 期间必须用 set_blur_hold 顶住 hide-on-blur，否则窗口在选择中途消失
  const pickingFileRef = useRef(false);
  // attachments 的同步镜像：文件处理循环里闭包旧值会让数量上限失真
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // 语音输入：转写文本追加进草稿（待确认后手动发送），错误走统一 error 条
  const voiceInput = useVoiceInput({
    onTranscribed: useCallback((text: string) => {
      setInput((prev) => prev + text);
      textareaRef.current?.focus();
    }, []),
    onError: useCallback((message: string) => setError(message), []),
  });

  // 消息重播：正在播报的消息下标（Rust 播完/被打断广播 moss:tts:done 清态）
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  // 复制反馈：成功勾/失败叉，1.5s 自动复位（按钮即反馈，不弹 toast）
  const [copyFeedback, setCopyFeedback] = useState<{ idx: number; ok: boolean } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

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

  const responseBodyRef = useRef<HTMLDivElement>(null);
  const isCancelledRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  // 用户是否贴在内容区底部（决定流式输出时是否自动跟随滚动）
  const stickToBottomRef = useRef(true);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);

  // Consume prefill 的 effect 在 handleSend 定义之后
  // （autoSend 直发要用代发通道，受声明顺序约束）

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

    // 视图切换会卸载本组件：后端若仍在生成，isLoading 已随卸载丢失，
    // 取消按钮随之消失（生成却停不下来）。挂载时向后端要一次在飞状态恢复。
    void invoke<boolean>('jarvis_chat_is_generating')
      .then((generating) => {
        if (generating) setIsLoading(true);
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

  // ── Tauri event listeners ─────────────────────────────────────────
  // 聊天消息落库后触发记忆提取防抖（后端 10 分钟静默期后提炼用户事实）
  const pokeRecall = () => {
    invoke('jarvis_recall_poke').catch(() => {});
  };

  // 失败兜底回复：请求出错时追加一条不占库的占位 assistant 消息——
  // 没有它，消息流停在用户气泡上，重试按钮（挂最后一条非卡片回复）无处显示。
  // 占位不入库：重试的 truncate 对它空转，重发后由真实回复顶替；
  // 用户不重试直接继续聊，它留在本次屏幕会话里做失败痕迹，恢复历史即消失。
  const appendFailurePlaceholder = (err: string) => {
    const brief = err.length > 200 ? err.slice(0, 200) + '…' : err;
    setMessages((prev) => [
      ...prev,
      { role: 'assistant' as const, content: `⚠️ 请求失败：${brief}\n\n可点下方重试按钮重新发送。` },
    ]);
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
        // 语音播报回复全文（开关/Key/设备在 Rust 端裁决，失败静默）
        void speakMarkdown(finalText).catch(() => {});
        pokeRecall();
      });
      const u3 = await listen<string>('llm:error', (event) => {
        // 先读后复位：用户主动取消后姗姗来迟的 error 不该出兜底占位
        const wasCancelled = isCancelledRef.current;
        isCancelledRef.current = false;
        setError(event.payload);
        setCancelled(false);
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
        if (!wasCancelled) appendFailurePlaceholder(event.payload);
      });

      // 贾维斯场景通道（流式事件契约 jarvis:start/status/chunk/done/error）
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
        // 语音播报回复全文（开关/Key/设备在 Rust 端裁决，失败静默）
        void speakMarkdown(finalText).catch(() => {});
        pokeRecall();
      });
      const u6 = await listen<string>('jarvis:error', (event) => {
        // 先读后复位：用户主动取消后姗姗来迟的 error 不该出兜底占位
        const wasCancelled = isCancelledRef.current;
        isCancelledRef.current = false;
        setAgentStatus(null);
        setError(event.payload);
        setCancelled(false);
        setIsLoading(false);
        setStreamText('');
        streamTextRef.current = '';
        if (!wasCancelled) appendFailurePlaceholder(event.payload);
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
      // TTS 播完/被打断（interrupt 或收流自然结束都会广播）：清掉消息重播的播放态
      const u10 = await listen<void>('moss:tts:done', () => {
        setPlayingIdx(null);
      });
      if (!active) {
        u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); u9(); u10();
        return;
      }
      unlistenFns = [u1, u2, u3, u4, u5, u6, u7, u8, u9, u10];
    };

    setupListeners();
    return () => {
      active = false;
      unlistenFns.forEach((fn) => fn());
    };
  }, []);


  // ── Send message ──────────────────────────────────────────────────
  // overrideText：A2UI 卡片 action 回传时直接代发的文本（不经过输入框）
  // ── 附件（发送文件）─────────────────────────────────────────────
  // 视觉门槛：附件含图片时要求当前 chat 场景模型已标 supports_vision，
  // 未标立即拦截（附件不进待发区），弹窗给「一键切换 / 去设置标记」两条路。
  // 文本文件无此门槛（读内容拼进消息，任何模型都能看）。
  const currentVisionState = (): { ok: boolean; modelName: string | null } => {
    const { sceneConfigs, models } = useLlmProviderStore.getState();
    const cfg = sceneConfigs.chat;
    if (!cfg) return { ok: false, modelName: null };
    const m = (models[cfg.provider_id] ?? []).find((x) => x.model_id === cfg.model_id);
    return { ok: m?.supports_vision === true, modelName: m?.name ?? cfg.model_id };
  };

  const collectVisionCandidates = (): VisionCandidate[] => {
    const { providers, models } = useLlmProviderStore.getState();
    return providers
      .filter((p) => p.is_active)
      .flatMap((p) =>
        (models[p.id] ?? [])
          .filter((m) => m.is_active && m.supports_vision)
          .map((m) => ({
            providerId: p.id,
            modelId: m.model_id,
            name: m.name,
            providerLabel: p.label,
          })),
      );
  };

  /** 追加待发附件（updater 内截断：多文件循环里 ref 同步滞后于真实状态，
   *  数量上限必须以 updater 的 prev 为准，否则一次多选可突破上限） */
  const pushAttachment = (item: PendingAttachment) => {
    setAttachments((prev) =>
      prev.length >= MAX_ATTACHMENTS ? prev : [...prev, item],
    );
  };

  const addOneFile = async (file: File) => {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(`一次最多带 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const cls = classifyFileName(file.name);
    if (cls === 'unsupported') {
      setError(`不支持的文件类型：${file.name}`);
      return;
    }
    const sid = sessionIdRef.current;
    if (sid === null) {
      setError('会话未就绪，请稍候再试');
      return;
    }
    if (cls === 'image') {
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`图片过大（上限 10MB）：${file.name}`);
        return;
      }
      try {
        const compressed = await compressImage(file);
        const relPath = await invoke<string>('save_chat_image', {
          sessionId: sid,
          bytes: compressed.bytes,
          ext: compressed.ext,
        });
        setAttachments((prev) =>
          prev.length >= MAX_ATTACHMENTS
            ? prev
            : [...prev, { kind: 'image', relPath, dataUrl: compressed.dataUrl }],
        );
      } catch (e) {
        setError(typeof e === 'string' ? e : '图片处理失败');
      }
      return;
    }
    if (file.size > MAX_TEXT_BYTES) {
      setError(`文件过大（上限 64KB）：${file.name}`);
      return;
    }
    try {
      const content = await readTextFile(file);
      pushAttachment({ kind: 'file', name: file.name, content });
    } catch {
      setError(`读取文件失败：${file.name}`);
    }
  };

  /** 打开文件选择器：先挂失焦挂起（选择器会抢焦点触发 hide-on-blur），
   *  选择器关闭（选中/取消）后焦点回主窗口，focus 监听里统一释放 */
  const openFilePicker = async () => {
    pickingFileRef.current = true;
    await invoke('set_blur_hold', { hold: true }).catch(() => {});
    // 兜底：极端情况 focus 事件丢失时，hide-on-blur 不应被永久挂起
    setTimeout(() => {
      if (pickingFileRef.current) {
        pickingFileRef.current = false;
        invoke('set_blur_hold', { hold: false }).catch(() => {});
      }
    }, 5 * 60 * 1000);
    fileInputRef.current?.click();
  };

  // 焦点回主窗口 = 选择器已关闭：释放失焦挂起（选中与取消都会走到）
  useEffect(() => {
    const onFocus = () => {
      if (!pickingFileRef.current) return;
      pickingFileRef.current = false;
      invoke('set_blur_hold', { hold: false }).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  /** 文件选择/粘贴统一入口：含图片先过视觉门槛，被拦的文件存进对话框待切换后续传 */
  const addFiles = async (files: File[]) => {
    const hasImage = files.some((f) => classifyFileName(f.name) === 'image');
    if (hasImage) {
      // 视觉判定依赖 store 数据：窗口刚开就点发送文件时 chat 场景配置/模型
      // 列表可能尚未懒加载完，先确保加载再判，否则把视觉模型误判成不支持
      const store = useLlmProviderStore.getState();
      if (!store.sceneConfigs.chat) {
        await store.loadSceneConfigs().catch(() => {});
      }
      const cfg = useLlmProviderStore.getState().sceneConfigs.chat;
      if (cfg && !useLlmProviderStore.getState().models[cfg.provider_id]) {
        await useLlmProviderStore.getState().loadModels(cfg.provider_id).catch(() => {});
      }
      if (!currentVisionState().ok) {
        setVisionGateFiles(files);
        return;
      }
    }
    for (const file of files) {
      await addOneFile(file);
    }
  };

  const handleVisionSwitch = async (c: VisionCandidate) => {
    const store = useLlmProviderStore.getState();
    const cfg = store.sceneConfigs.chat;
    await store.setSceneModel(
      'chat',
      c.providerId,
      c.modelId,
      cfg?.thinking_mode ?? false,
      cfg?.reasoning_effort ?? 'medium',
    );
    const pending = visionGateFiles ?? [];
    setVisionGateFiles(null);
    await addFiles(pending);
  };

  const handleVisionGoSettings = () => {
    useSettingsStore.getState().setPendingTab('model');
    setActiveView('settings');
    setVisionGateFiles(null);
  };

  const handleSend = useCallback(async (overrideText?: string) => {
    const content = (typeof overrideText === 'string' ? overrideText : input).trim();
    // 代发（预填/A2UI 回传）不携带待发附件；手动发送允许纯附件消息
    const withAttachments = typeof overrideText !== 'string' && attachments.length > 0;
    // 贾维斯通道在飞时允许继续发送（后端 FIFO 排队）；工具型模式保持单飞拦截
    if ((!content && !withAttachments) || (isLoading && mode !== 'chat')) return;
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
          content: userMessage.content,
          contentType: userMessage.contentType ?? null,
        });
      } catch (e) {
        console.error('Failed to save user message:', e);
      }
    }
    // 记忆提取只看闲聊通道，工具型模式（翻译等）不触发
    if (mode === 'chat') pokeRecall();

    try {
      setAgentStatus(null);
      // 场景模型通道：tool-use 循环在后端，流式事件 jarvis:status / chunk / done / error
      const sid = sessionIdRef.current;
      if (sid === null) throw new Error('会话未就绪，请稍候再试');
      await invoke('jarvis_chat_send_scene', { sessionId: sid, text: userMessage.content });
      // 发送已被后端接管，清空待发附件（失败保留，用户可重发）
      setAttachments([]);
    } catch (err) {
      setIsLoading(false);
      setError(typeof err === 'string' ? err : '发送失败，请检查 AI 模型设置');
    }
  }, [input, isLoading, messages, mode, attachments]);

  // Consume prefill: 原文填入输入框（companion 错误分析 / 剪贴板「发送给AI」共用通道，
  // 包装文案由发送方组装）;autoSend(语音输入)走代发通道直接发送,不进草稿。
  // 消费走 consumeChatPrefill 原子取走——本 effect 在 StrictMode/热重挂载下会二次执行,
  // 第二次拿到 null 直接跳过;若分步「读 getState + setChatPrefill(null)」,第二次会用
  // 渲染闭包里的旧 chatPrefill + 已被清空的 autoSend 标记把代发误判成预填
  useEffect(() => {
    if (!chatPrefill) return;
    const claimed = useAppStore.getState().consumeChatPrefill();
    if (!claimed) return;
    setMode('chat');
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
    stopSpeech();
    isCancelledRef.current = true;
    setCancelled(true);
    setIsLoading(false);
    setStreamText('');
    streamTextRef.current = '';
    setAgentStatus(null);
    if (mode === 'chat') {
      try {
        await invoke('jarvis_chat_cancel_scene');
      } catch (e) {
        console.error('Failed to cancel jarvis chat:', e);
      }
    }
  }, [mode]);

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
        const systemMsg: ChatMessage = { role: 'system', content: MODES[mode].system };
        setMessages([systemMsg, ...historyRowsToMessages(msgs)]);
        setHasResponse(msgs.length > 0);
        setSessionId(id);
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
          <ModelSelector />
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
              <UserMessageBubble content={msg.content} contentType={msg.contentType} />
            ) : msg.contentType === 'a2ui' ? (
              <div className="max-w-[90%] w-full">
                <A2uiSurface
                  payloadJson={msg.content}
                  onAction={(text) => handleSend(text)}
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
                    onClick={() => handleCopyMessage(idx, msg.content)}
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
                      onClick={handleRetry}
                      className="w-6 h-6 rounded-md flex items-center justify-center transition-all cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-white/10"
                      aria-label="重新生成回复"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* 重播入口:播报中常亮方块,再点即停 */}
                  <button
                    type="button"
                    onClick={() => handleSpeakMessage(idx, msg.content)}
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
      <div className="px-3 py-2.5 shrink-0 border-t border-app-border">
        {/* 待发附件 chips：图片缩略图 / 文件卡片，hover 出 × 逐个移除 */}
        {attachments.length > 0 && (
          <PendingChips
            attachments={attachments}
            onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
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
            disabled={(!input.trim() && attachments.length === 0) || (isLoading && mode !== 'chat')}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              (input.trim() || attachments.length > 0) && (!isLoading || mode === 'chat')
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
          onClose={() => setVisionGateFiles(null)}
        />
      )}

      {/* ── Session history dropdown (fixed 定位，不受布局裁剪影响) ── */}
      {historyOpen && (
        <div
          ref={historyPanelRef}
          tabIndex={-1}
          role="listbox"
          aria-label="会话历史"
          onKeyDown={handleHistoryKeyDown}
          className={`fixed z-50 w-80 max-h-80 overflow-y-auto rounded-xl border border-app-border bg-app-bg-primary/80 shadow-lg outline-none transition-all duration-150 ease-out motion-reduce:transition-none ${
            historyVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
          }`}
          style={{
            top: historyPos.top,
            right: historyPos.right,
            WebkitBackdropFilter: 'blur(20px)',
            backdropFilter: 'blur(20px)',
          }}
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
            <ul className="p-1.5">
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
                    className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-150 ease-out ${
                      i === historyIdx ? 'bg-app-bg-hover' : ''
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
