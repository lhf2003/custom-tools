import { useState } from 'react';
import {
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
} from 'lucide-react';

export interface DateRangeApply {
  /** 快捷预设 key；自定义为 null */
  preset: string | null;
  /** unix 秒 */
  since: number;
  /** unix 秒，开区间终点 */
  until: number;
  /** 结束时间跟随当前时刻（查询时实时取 now） */
  followNow: boolean;
}

interface DateRangePickerProps {
  preset: string | null;
  since: number;
  until: number;
  followNow: boolean;
  onApply: (value: DateRangeApply) => void;
  className?: string;
}

const PRESETS = [
  { key: 'today', chip: '当天', label: '当天' },
  { key: '1d', chip: '1d', label: '昨日' },
  { key: '7d', chip: '7d', label: '近 7 天' },
  { key: '14d', chip: '14d', label: '近 14 天' },
  { key: '30d', chip: '30d', label: '近 30 天' },
] as const;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function startOfDayTs(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return Math.floor(x.getTime() / 1000);
}

function pad2(v: number): string {
  return String(v).padStart(2, '0');
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function fmtTimeHM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** HH:mm → [时, 分]；非法返回 null */
function parseTime(text: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Math.min(Number(m[1]), 23);
  const min = Math.min(Number(m[2]), 59);
  return [h, min];
}

/** 预设 → 起止（until 为开区间终点；1d = 昨日全天） */
function presetRange(key: string): { since: number; until: number; followNow: boolean } {
  const now = Math.floor(Date.now() / 1000);
  const today0 = startOfDayTs(new Date());
  switch (key) {
    case '1d':
      return { since: today0 - 86400, until: today0, followNow: false };
    case '7d':
      return { since: today0 - 6 * 86400, until: now, followNow: true };
    case '14d':
      return { since: today0 - 13 * 86400, until: now, followNow: true };
    case '30d':
      return { since: today0 - 29 * 86400, until: now, followNow: true };
    default:
      return { since: today0, until: now, followNow: true };
  }
}

/** 月历 42 格（周日起） */
function gridDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

interface Draft {
  preset: string | null;
  startDate: Date;
  startTime: string;
  endDate: Date;
  endTime: string;
  followNow: boolean;
  activeField: 'start' | 'end';
  viewYear: number;
  viewMonth: number;
}

/**
 * 时间范围选择器：触发按钮 + 弹层（预设 chips / 起止时间卡片 / 月历 /
 * 结束跟随当前时刻 / 确定取消）。弹层内为草稿态，确定后才回传。
 */
export function DateRangePicker({
  preset,
  since,
  until,
  followNow,
  onApply,
  className = '',
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const openPicker = () => {
    const start = new Date(since * 1000);
    // until 是开区间终点：自定义时显示要回退一分钟；跟随当前时刻则显示此刻
    const end = followNow ? new Date() : new Date((until - 60) * 1000);
    setDraft({
      preset,
      startDate: start,
      startTime: fmtTimeHM(start),
      endDate: end,
      endTime: fmtTimeHM(end),
      followNow,
      activeField: 'start',
      viewYear: start.getFullYear(),
      viewMonth: start.getMonth(),
    });
    setIsOpen(true);
  };

  const close = () => {
    setIsOpen(false);
    setDraft(null);
  };

  const patch = (p: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...p } : prev));
  };

  const applyPreset = (key: string) => {
    const r = presetRange(key);
    const start = new Date(r.since * 1000);
    const end = new Date(r.until * 1000);
    patch({
      preset: key,
      startDate: start,
      startTime: fmtTimeHM(start),
      endDate: end,
      endTime: fmtTimeHM(end),
      followNow: r.followNow,
      viewYear: start.getFullYear(),
      viewMonth: start.getMonth(),
    });
  };

  const pickDay = (day: Date) => {
    if (!draft) return;
    const dayTs = startOfDayTs(day);
    if (draft.activeField === 'start') {
      const next: Partial<Draft> = { preset: null, startDate: day };
      if (dayTs > startOfDayTs(draft.endDate)) next.endDate = day;
      patch(next);
    } else {
      const next: Partial<Draft> = { preset: null, endDate: day, followNow: false };
      if (dayTs < startOfDayTs(draft.startDate)) next.startDate = day;
      patch(next);
    }
  };

  const shiftMonth = (delta: number) => {
    if (!draft) return;
    const m = draft.viewMonth + delta;
    patch({
      viewYear: draft.viewYear + Math.floor(m / 12),
      viewMonth: ((m % 12) + 12) % 12,
    });
  };

  const apply = () => {
    if (!draft) return;
    const [sh, sm] = parseTime(draft.startTime) ?? [0, 0];
    const finalSince = startOfDayTs(draft.startDate) + sh * 3600 + sm * 60;
    let finalUntil: number;
    if (draft.followNow) {
      finalUntil = Math.floor(Date.now() / 1000);
    } else {
      const [eh, em] = parseTime(draft.endTime) ?? [23, 59];
      // 所选分钟包含在内 → 开区间终点 +60s
      finalUntil = startOfDayTs(draft.endDate) + eh * 3600 + em * 60 + 60;
    }
    if (finalUntil <= finalSince) finalUntil = finalSince + 60;
    onApply({
      preset: draft.preset,
      since: finalSince,
      until: finalUntil,
      followNow: draft.followNow,
    });
    close();
  };

  // 触发按钮文案：预设名或自定义区间
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label;
  const fmtShort = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const triggerLabel =
    presetLabel ??
    `${fmtShort(since)} - ${followNow ? '至今' : fmtShort(Math.max(until - 60, since))}`;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => (isOpen ? close() : openPicker())}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-all duration-200 ease-out cursor-pointer
          bg-app-bg-tertiary border-app-border text-app-text-primary hover:border-app-border-emphasis
          ${isOpen ? 'border-app-status-info ring-2 ring-app-status-info/20' : ''}`}
      >
        <Calendar size={14} className="text-app-text-tertiary" />
        <span>{triggerLabel}</span>
        <ChevronDown
          size={14}
          className={`text-app-text-tertiary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && draft && (
        <>
          {/* 点击遮罩关闭（草稿丢弃，与取消等价） */}
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full mt-1 z-50 w-[560px] rounded-xl border border-app-border-emphasis bg-app-bg-elevated shadow-xl shadow-black/50 p-3 animate-slide-up">
            {/* 预设 */}
            <div className="flex gap-1.5 mb-3">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className={`px-3 py-1 rounded-lg text-xs border transition-all cursor-pointer ${
                    draft.preset === p.key
                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                      : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'
                  }`}
                >
                  {p.chip}
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              {/* 左列：起止时间 + 选项 + 动作 */}
              <div className="w-[218px] flex-shrink-0 flex flex-col gap-2">
                <p className="text-xs text-app-text-tertiary">支持日期与时间</p>

                {(['start', 'end'] as const).map((field) => {
                  const isStart = field === 'start';
                  const active = draft.activeField === field;
                  const disabled = !isStart && draft.followNow;
                  return (
                    <div
                      key={field}
                      onClick={() => !disabled && patch({ activeField: field })}
                      className={`rounded-lg border px-3 py-2 transition-colors ${
                        disabled
                          ? 'border-white/5 opacity-50'
                          : active
                            ? 'border-app-status-info cursor-pointer'
                            : 'border-white/10 hover:border-white/20 cursor-pointer'
                      }`}
                    >
                      <div className="text-xs text-app-text-tertiary mb-1">
                        {isStart ? '开始时间' : '结束时间'}
                      </div>
                      <div className="flex items-center gap-1.5 text-sm text-app-text-primary">
                        <span className="tabular-nums">
                          {fmtDate(isStart ? draft.startDate : draft.endDate)}
                        </span>
                        <Calendar size={13} className="text-app-text-tertiary" />
                        {disabled ? (
                          <span className="tabular-nums text-app-text-tertiary">
                            {draft.endTime}
                          </span>
                        ) : (
                          <input
                            value={isStart ? draft.startTime : draft.endTime}
                            onChange={(e) =>
                              patch(
                                isStart
                                  ? { startTime: e.target.value, preset: null }
                                  : { endTime: e.target.value, preset: null },
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                            placeholder="HH:mm"
                            className="w-14 bg-transparent text-center tabular-nums outline-none border-b border-transparent focus:border-app-status-info placeholder:text-app-text-placeholder"
                          />
                        )}
                        <Clock size={13} className="text-app-text-tertiary" />
                      </div>
                    </div>
                  );
                })}

                <label className="flex items-center gap-2 text-xs text-app-text-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={draft.followNow}
                    onChange={(e) => patch({ followNow: e.target.checked })}
                    className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                  />
                  结束时间跟随当前时刻
                </label>

                <div className="flex gap-2 mt-auto pt-1">
                  <button
                    onClick={close}
                    className="px-3 py-1.5 rounded-lg text-xs text-app-text-secondary hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    onClick={apply}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
                  >
                    确定
                  </button>
                </div>
              </div>

              {/* 右列：月历 */}
              <div className="flex-1 border-l border-white/5 pl-3">
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => shiftMonth(-1)}
                    className="p-1 rounded-md text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="text-sm text-app-text-primary">
                    {draft.viewYear}年{draft.viewMonth + 1}月
                  </span>
                  <button
                    onClick={() => shiftMonth(1)}
                    className="p-1 rounded-md text-app-text-tertiary hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-7 text-center text-xs text-app-text-tertiary mb-1">
                  {WEEKDAYS.map((w) => (
                    <span key={w} className="py-0.5">
                      {w}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-y-0.5">
                  {gridDays(draft.viewYear, draft.viewMonth).map((day) => {
                    const dayTs = startOfDayTs(day);
                    const startTs = startOfDayTs(draft.startDate);
                    const endTs = draft.followNow
                      ? startOfDayTs(new Date())
                      : startOfDayTs(draft.endDate);
                    const inMonth = day.getMonth() === draft.viewMonth;
                    const isEndpoint = dayTs === startTs || dayTs === endTs;
                    const inRange = dayTs > startTs && dayTs < endTs;
                    const isToday = dayTs === startOfDayTs(new Date());
                    return (
                      <button
                        key={day.getTime()}
                        onClick={() => pickDay(day)}
                        className={`h-7 rounded-md text-xs transition-colors cursor-pointer ${
                          isEndpoint
                            ? 'bg-blue-600 text-white'
                            : inRange
                              ? 'bg-blue-500/15 text-blue-200'
                              : inMonth
                                ? 'text-app-text-secondary hover:bg-white/10'
                                : 'text-app-text-disabled hover:bg-white/5'
                        } ${isToday && !isEndpoint ? 'ring-1 ring-inset ring-blue-500/40' : ''}`}
                      >
                        {day.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
