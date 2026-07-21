import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Coffee, Rocket, X, Sparkles, Pin, Sunrise, Music, Zap } from 'lucide-react';

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

/** 无操作自动隐藏时间（秒）——仅隐藏，建议在历史中保留可稍后处理 */
const AUTO_HIDE_SECONDS = 15;

interface TypeMeta {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  acceptLabel: string;
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
    acceptLabel: '好的',
  },
  work_suite: {
    icon: Rocket,
    ...REGULAR_META,
    acceptLabel: '一键启动',
  },
  intent: {
    icon: Pin,
    ...REGULAR_META,
    acceptLabel: '完成',
  },
  daily_digest: {
    icon: Sunrise,
    ...REGULAR_META,
    acceptLabel: '知道了',
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
    acceptLabel: '好的',
  },
};

const DEFAULT_META: TypeMeta = {
  icon: Sparkles,
  ...REGULAR_META,
  acceptLabel: '知道了',
};

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

  if (!suggestion) {
    return null;
  }

  const meta = TYPE_META[suggestion.suggestion_type] ?? DEFAULT_META;
  const Icon = meta.icon;

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
            onClick={handleDismiss}
            className="text-white/40 hover:text-white/80 transition-colors cursor-pointer shrink-0"
            title="忽略"
          >
            <X size={14} />
          </button>
        </div>

        {/* 正文 */}
        {suggestion.body && (
          <div className="px-3 py-1 flex-1 min-h-0">
            <p className="text-white/60 text-xs leading-relaxed line-clamp-4 whitespace-pre-wrap">
              {suggestion.body}
            </p>
          </div>
        )}

        {/* 操作区 */}
        <div className="flex items-center justify-end gap-2 px-3 pb-2.5 pt-1">
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
            className="px-3 py-1.5 rounded-lg text-xs bg-blue-500/80 hover:bg-blue-500 text-white font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            {acting ? '执行中…' : meta.acceptLabel}
          </button>
        </div>

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
