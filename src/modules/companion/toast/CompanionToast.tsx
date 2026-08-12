import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Coffee, Rocket, X, Sparkles, Pin, Sunrise, Music, Zap, FileText, HelpCircle } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { speakText, stopSpeech } from '@/utils/speech';

interface Suggestion {
  id: number;
  suggestion_type: string;
  title: string;
  body: string | null;
  action_payload: string | null;
  status: string;
  created_at: number;
  acted_at: number | null;
}

/** 无操作自动隐藏时间（秒） */
const AUTO_HIDE_SECONDS = 15;

/** 未知应用标注链的弹窗间隔（秒）：相邻两条都是标注提醒时，上一条关闭后藏窗冷却
 *  这么久再弹下一条——给用户留出去设置页填描述的时间，否则第一个标注还没填完，
 *  第二个弹窗就出来抢焦点 */
const ANNOTATION_GAP_SECONDS = 20;

/** 纯提示型（与 Rust suggester::INFO_TYPES 一致）：accept 无后续动作，
 *  推送即落 seen——卡片只展示，不渲染按钮，关闭只是本地隐藏 */
const INFO_TYPES = new Set([
  'long_work_break',
  'daily_digest',
  'daily_report',
  'auto_executed',
  'intent_reminder',
]);

interface TypeMeta {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  /** 仅动作型需要；提示型无按钮，留空 */
  acceptLabel?: string;
}

/** 常规建议的统一色彩：Signal Indigo Light（#818cf8，深色表面实测 5.0:1）。
 *  颜色只承载语义——常规=Indigo、错误=status-error、已毕业执行=status-success；
 *  类型区分交还给图标，不再用色相当装饰 */
const REGULAR_META = {
  iconColor: 'text-app-brand-primary-light',
  iconBg: 'bg-app-brand-primary/15',
} as const;

const TYPE_META: Record<string, TypeMeta> = {
  error_analysis: {
    icon: AlertTriangle,
    iconColor: 'text-app-status-error-text',
    iconBg: 'bg-red-500/15',
    acceptLabel: 'AI 分析',
  },
  long_work_break: {
    icon: Coffee,
    ...REGULAR_META,
  },
  work_suite: {
    icon: Rocket,
    ...REGULAR_META,
    acceptLabel: '一键启动',
  },
  intent_reminder: {
    icon: Pin,
    ...REGULAR_META,
  },
  daily_digest: {
    icon: Sunrise,
    ...REGULAR_META,
  },
  daily_report: {
    icon: FileText,
    ...REGULAR_META,
  },
  agent_insight: {
    icon: Sparkles,
    ...REGULAR_META,
    acceptLabel: '知道了',
  },
  context_routine: {
    icon: Music,
    ...REGULAR_META,
    acceptLabel: '打开',
  },
  auto_executed: {
    icon: Zap,
    iconColor: 'text-app-status-success',
    iconBg: 'bg-emerald-500/15',
  },
  app_unknown: {
    icon: HelpCircle,
    ...REGULAR_META,
    acceptLabel: '去标注',
  },
};

const DEFAULT_META: TypeMeta = {
  icon: Sparkles,
  ...REGULAR_META,
  acceptLabel: '知道了',
};

/** 动作型建议（启动应用/AI 分析）：Enter 不直达，防打字中误触——
 *  误接受会启动应用并污染毕业制投票数据，必须鼠标点击确认 */
const ACTION_TYPES = new Set(['work_suite', 'context_routine', 'error_analysis', 'app_unknown']);

export default function CompanionToast() {
  // 展示队列：分析轮可能连发多条建议（如多个未知应用），逐条展示、关闭后出队下一条。
  // queueRef 是同步真值源——emit 追加与 advance 出队落在同一宏任务时以 ref 为准，
  // 不丢新到的建议；queue 只是它的渲染镜像
  const queueRef = useRef<Suggestion[]>([]);
  const [queue, setQueue] = useState<Suggestion[]>([]);
  // 标注冷却期：上一条未知应用标注关闭后，藏窗冷却再放行队列里的下一条标注
  const [cooldown, setCooldown] = useState(false);
  const suggestion = cooldown ? null : (queue[0] ?? null);
  const [countdown, setCountdown] = useState(AUTO_HIDE_SECONDS);
  const [acting, setActing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const suggestionIdRef = useRef<number | null>(null);
  const cooldownTimerRef = useRef<number | null>(null);

  // 仅隐藏窗口，队列保留
  const hideWindow = useCallback(() => {
    suggestionIdRef.current = null;
    getCurrentWindow()
      .hide()
      .catch((err: unknown) => console.error('Failed to hide toast window:', err));
    setActing(false);
  }, []);

  // 出队当前条：队列还有下一条则自动展示（suggestion 变化 → 回执 effect → 重新 show），
  // 队列已空则隐藏窗口；相邻两条都是未知应用标注时先藏窗冷却，到点再放行下一条
  const advance = useCallback(() => {
    // 卡片关闭即停播（下一条若存在，它的播报会自然接管）
    stopSpeech();
    // 新卡片复位操作态；冷却期不允许旧倒计时残留（否则到点会再触发一次 advance）
    setActing(false);
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const closed = queueRef.current[0];
    queueRef.current = queueRef.current.slice(1);
    setQueue(queueRef.current);
    const next = queueRef.current[0];

    if (closed?.suggestion_type === 'app_unknown' && next?.suggestion_type === 'app_unknown') {
      hideWindow();
      setCooldown(true);
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = window.setTimeout(() => {
        cooldownTimerRef.current = null;
        setCooldown(false);
      }, ANNOTATION_GAP_SECONDS * 1000);
      return;
    }
    if (!next) hideWindow();
  }, [hideWindow]);

  // 倒计时：到 0 仅隐藏窗口，不改变建议状态（用户可在设置页稍后处理）
  useEffect(() => {
    if (!suggestion) return;

    suggestionIdRef.current = suggestion.id;
    setCountdown(AUTO_HIDE_SECONDS);
    const startedAt = Date.now();
    const id = suggestion.id;

    timerRef.current = window.setInterval(() => {
      // 期间来了新建议则本次倒计时作废
      if (suggestionIdRef.current !== id) return;
      const remaining = AUTO_HIDE_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
      if (remaining <= 0) {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current);
        }
        setCountdown(0);
        advance();
      } else {
        setCountdown(remaining);
      }
    }, 1000);

    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
    };
  }, [suggestion, advance]);

  useEffect(() => {
    const unlisten = listen<Suggestion>('companion:suggestion', (event) => {
      // 队列尾部追加；多条连发（如多个未知应用）逐条展示
      queueRef.current = [...queueRef.current, event.payload];
      setQueue(queueRef.current);
      setActing(false);
    });
    // 本窗口是启动时预创建的隐藏窗口，页面异步加载可能晚于首次 emit
    //（Tauri 事件即发即丢）：挂载后补拉待展示建议队列兜底，否则透明窗会永久滞留
    invoke<Suggestion[]>('get_pending_companion_toast')
      .then((pending) => {
        if (pending.length > 0) {
          queueRef.current = [...queueRef.current, ...pending];
          setQueue(queueRef.current);
          setActing(false);
        }
      })
      .catch((err: unknown) => console.error('Failed to fetch pending suggestions:', err));
    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup companion:suggestion listener:', err);
      });
    };
  }, []);

  // 卸载兜底：清掉标注冷却定时器（toast 窗口随应用生命周期，正常不卸载）
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current !== null) window.clearTimeout(cooldownTimerRef.current);
    };
  }, []);

  // 渲染完成回执：双 rAF 确保卡片已实际绘制，Rust 收到回执后才定位 + show——
  // 透明窗口若先 show 后渲染，首帧全透明会定格/闪帧
  useEffect(() => {
    if (!suggestion) return;
    // 语音播报：卡片出现即开口（开关/Key/设备在 Rust 端裁决，失败静默）
    void speakText(
      suggestion.body ? `${suggestion.title}。${suggestion.body}` : suggestion.title,
    ).catch(() => {});
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          invoke('companion_toast_ready').catch((err: unknown) =>
            console.error('Failed to signal toast ready:', err),
          );
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [suggestion]);

  const handleAccept = useCallback(async () => {
    if (!suggestion || acting) return;
    setActing(true);
    try {
      await invoke('act_on_companion_suggestion', { id: suggestion.id });
    } catch (err) {
      console.error('Failed to act on suggestion:', err);
    } finally {
      advance();
    }
  }, [suggestion, acting, advance]);

  const handleDismiss = useCallback(async () => {
    if (!suggestion || acting) return;
    setActing(true);
    try {
      await invoke('dismiss_companion_suggestion', { id: suggestion.id });
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    } finally {
      advance();
    }
  }, [suggestion, acting, advance]);

  // 键盘快捷键：提示型 Esc/Enter 都只是本地关闭（状态已落 seen，不回传处置）；
  // 动作型 Esc 忽略直达、Enter 仅确认型直达（动作型防误触）。
  // 焦点来自 Rust 端 show 后的 set_focus 尝试，或用户点击窗口
  useEffect(() => {
    if (!suggestion) return;
    const isInfo = INFO_TYPES.has(suggestion.suggestion_type);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInfo) {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          advance();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        void handleDismiss();
      } else if (e.key === 'Enter') {
        if (ACTION_TYPES.has(suggestion.suggestion_type)) return;
        // 按钮已聚焦时交给原生行为，避免双重触发
        if (e.target instanceof HTMLElement && e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        void handleAccept();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [suggestion, handleAccept, handleDismiss, advance]);

  if (!suggestion) {
    return null;
  }

  const meta = TYPE_META[suggestion.suggestion_type] ?? DEFAULT_META;
  const Icon = meta.icon;
  const isActionType = ACTION_TYPES.has(suggestion.suggestion_type);
  const isInfoType = INFO_TYPES.has(suggestion.suggestion_type);

  return (
    <div className="w-full h-full flex items-stretch justify-stretch bg-transparent">
      {/* panel-glass-toast：主题玻璃底色（透明度随全局滑杆）——与划词翻译浮窗同一
          浮窗面板标准；zinc 灰阶在 tailwind 里已重映射为语义 token，不能再作背景，
          且透明窗口下 backdrop-blur 走独立合成路径有渲染风险（TranslateToast 同款无 blur） */}
      <div className="relative flex-1 m-1 rounded-xl border border-app-border-subtle panel-glass-toast shadow-2xl overflow-hidden flex flex-col">
        {/* 标题栏（可拖动） */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 pt-2.5 pb-1 cursor-default"
        >
          <div className={`w-6 h-6 rounded-lg ${meta.iconBg} flex items-center justify-center shrink-0`}>
            <Icon size={14} className={meta.iconColor} />
          </div>
          <div data-tauri-drag-region className="flex-1 text-app-text-primary text-sm font-medium truncate">
            {suggestion.title}
          </div>
          <Tooltip content={isInfoType ? '关闭（Esc）' : '忽略（Esc）'} wrapperClassName="shrink-0">
            <button
              onClick={isInfoType ? advance : () => void handleDismiss()}
              className="text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer shrink-0"
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>

        {/* 正文（提示型去掉了操作区，空间还给正文） */}
        {suggestion.body && (
          <div className="px-3 py-1 flex-1 min-h-0">
            <p
              className={`text-app-text-tertiary text-xs leading-relaxed whitespace-pre-wrap ${
                isInfoType ? 'line-clamp-6' : 'line-clamp-4'
              }`}
            >
              {suggestion.body}
            </p>
          </div>
        )}

        {/* 操作区（仅动作型；提示型看过即终结，无按钮） */}
        {!isInfoType && (
          <div className="flex items-center justify-end gap-2 px-3 pb-2.5 pt-1">
            <span className="mr-auto text-[10px] font-medium text-app-text-placeholder select-none">
              {isActionType ? 'Esc 忽略' : '⏎ 接受 · Esc 忽略'}
            </span>
            <button
              onClick={handleDismiss}
              disabled={acting}
              className="px-3 py-1.5 rounded-lg text-xs text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-pressed transition-colors cursor-pointer disabled:opacity-50"
            >
              忽略
            </button>
            <Tooltip content={isActionType ? '动作型建议需点击确认（防误触）' : '点击或按 Enter'}>
              <button
                onClick={handleAccept}
                disabled={acting}
                className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info hover:bg-app-status-info-deep text-white font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                {acting ? '执行中…' : (meta.acceptLabel ?? '知道了')}
              </button>
            </Tooltip>
          </div>
        )}

        {/* 剩余时间细线（替代倒计时数字，降低催促感）；1s 步进靠 CSS 过渡抹平。
           纱层用 --app-alpha-white-*（随主题翻转：浅色主题自动变黑纱） */}
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--app-alpha-white-5)]">
          <div
            className="h-full bg-[var(--app-alpha-white-50)] transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ width: `${(countdown / AUTO_HIDE_SECONDS) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
