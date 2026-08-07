import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Coffee, Rocket, X, Sparkles, Pin, Sunrise, Music, Zap, FileText, HelpCircle } from 'lucide-react';

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
    iconColor: 'text-red-400',
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
    iconColor: 'text-emerald-400',
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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [countdown, setCountdown] = useState(AUTO_HIDE_SECONDS);
  const [acting, setActing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const suggestionIdRef = useRef<number | null>(null);

  const hideWindow = useCallback(() => {
    suggestionIdRef.current = null;
    getCurrentWindow()
      .hide()
      .catch((err: unknown) => console.error('Failed to hide toast window:', err));
    setSuggestion(null);
    setActing(false);
  }, []);

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
        hideWindow();
      } else {
        setCountdown(remaining);
      }
    }, 1000);

    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
    };
  }, [suggestion, hideWindow]);

  useEffect(() => {
    const unlisten = listen<Suggestion>('companion:suggestion', (event) => {
      setSuggestion(event.payload);
      setActing(false);
    });
    return () => {
      unlisten.then((fn) => fn()).catch((err: unknown) => {
        console.error('Failed to cleanup companion:suggestion listener:', err);
      });
    };
  }, []);

  const handleAccept = useCallback(async () => {
    if (!suggestion || acting) return;
    setActing(true);
    try {
      await invoke('act_on_companion_suggestion', { id: suggestion.id });
    } catch (err) {
      console.error('Failed to act on suggestion:', err);
    } finally {
      hideWindow();
    }
  }, [suggestion, acting, hideWindow]);

  const handleDismiss = useCallback(async () => {
    if (!suggestion || acting) return;
    setActing(true);
    try {
      await invoke('dismiss_companion_suggestion', { id: suggestion.id });
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    } finally {
      hideWindow();
    }
  }, [suggestion, acting, hideWindow]);

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
          hideWindow();
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
  }, [suggestion, handleAccept, handleDismiss, hideWindow]);

  if (!suggestion) {
    return null;
  }

  const meta = TYPE_META[suggestion.suggestion_type] ?? DEFAULT_META;
  const Icon = meta.icon;
  const isActionType = ACTION_TYPES.has(suggestion.suggestion_type);
  const isInfoType = INFO_TYPES.has(suggestion.suggestion_type);

  return (
    <div className="w-full h-full flex items-stretch justify-stretch bg-transparent">
      <div className="relative flex-1 m-1 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-md shadow-2xl overflow-hidden flex flex-col">
        {/* 标题栏（可拖动） */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 pt-2.5 pb-1 cursor-default"
        >
          <div className={`w-6 h-6 rounded-lg ${meta.iconBg} flex items-center justify-center shrink-0`}>
            <Icon size={14} className={meta.iconColor} />
          </div>
          <div data-tauri-drag-region className="flex-1 text-white text-sm font-medium truncate">
            {suggestion.title}
          </div>
          <button
            onClick={isInfoType ? hideWindow : () => void handleDismiss()}
            className="text-white/40 hover:text-white/80 transition-colors cursor-pointer shrink-0"
            title={isInfoType ? '关闭（Esc）' : '忽略（Esc）'}
          >
            <X size={14} />
          </button>
        </div>

        {/* 正文（提示型去掉了操作区，空间还给正文） */}
        {suggestion.body && (
          <div className="px-3 py-1 flex-1 min-h-0">
            <p
              className={`text-white/60 text-xs leading-relaxed whitespace-pre-wrap ${
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
            <span className="mr-auto text-[10px] font-medium text-white/30 select-none">
              {isActionType ? 'Esc 忽略' : '⏎ 接受 · Esc 忽略'}
            </span>
            <button
              onClick={handleDismiss}
              disabled={acting}
              className="px-3 py-1.5 rounded-lg text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-50"
            >
              忽略
            </button>
            <button
              onClick={handleAccept}
              disabled={acting}
              title={isActionType ? '动作型建议需点击确认（防误触）' : '点击或按 Enter'}
              className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              {acting ? '执行中…' : (meta.acceptLabel ?? '知道了')}
            </button>
          </div>
        )}

        {/* 剩余时间细线（替代倒计时数字，降低催促感）；1s 步进靠 CSS 过渡抹平 */}
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
          <div
            className="h-full bg-white/40 transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ width: `${(countdown / AUTO_HIDE_SECONDS) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
