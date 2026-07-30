import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from 'lucide-react';
import {
  useStatsStore,
  type CallLogRow,
  type ObserveFilter,
  type SourceStatRow,
} from '@/stores/statsStore';
import { CustomSelect } from '../../components/CustomSelect';
import { DateRangePicker, type DateRangeApply } from '../../components/DateRangePicker';
import {
  fmtCost,
  fmtDuration,
  fmtTime,
  fmtTokens,
  sourceLabel,
} from './format';

type SortKey = 'calls' | 'tokens' | 'duration' | 'cost';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const MAIN_GRID = 'grid-cols-[20px_1fr_64px_110px_80px_90px]';
const DETAIL_GRID = 'grid-cols-[1fr_84px_84px_64px_64px_80px_104px]';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface ExpandedState {
  loading: boolean;
  logs: CallLogRow[];
  error: string | null;
}

export function LlmObserveSection() {
  const {
    observeOptions,
    observability,
    observabilityLoading,
    loadObserveOptions,
    loadObservability,
    loadCallLogs,
  } = useStatsStore();

  const [preset, setPreset] = useState<string | null>('today');
  const [source, setSource] = useState('');
  const [model, setModel] = useState('');
  const [since, setSince] = useState(startOfToday);
  const [until, setUntil] = useState(nowSeconds);
  const [followNow, setFollowNow] = useState(true);
  const [sort, setSort] = useState<SortState>({ key: 'calls', dir: 'desc' });
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({});

  useEffect(() => {
    loadObserveOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次调用实时组装筛选条件：followNow 时 until 取此刻，保证「跟随当前时刻」
  const buildFilter = (sourceOverride?: string): ObserveFilter => ({
    source: sourceOverride ?? (source || null),
    model: model || null,
    since,
    until: followNow ? nowSeconds() : until,
  });

  // 筛选变更 → 重新拉取（400ms 防抖），同时收合已展开的明细——旧条件下的日志不应残留
  useEffect(() => {
    setExpanded({});
    const timer = setTimeout(() => loadObservability(buildFilter()), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, model, since, until, followNow]);

  const handleRangeApply = (v: DateRangeApply) => {
    setPreset(v.preset);
    setSince(v.since);
    setUntil(v.until);
    setFollowNow(v.followNow);
  };

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'desc' },
    );
  };

  const sortedRows = useMemo(() => {
    const rows = [...(observability?.rows ?? [])];
    const valueOf = (r: SourceStatRow): number => {
      switch (sort.key) {
        case 'calls':
          return r.calls;
        case 'tokens':
          return r.input_tokens + r.output_tokens;
        case 'duration':
          return r.total_duration_ms;
        case 'cost':
          return r.cost_usd;
      }
    };
    rows.sort((a, b) =>
      sort.dir === 'asc' ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a),
    );
    return rows;
  }, [observability, sort]);

  const toggleExpand = async (rowSource: string) => {
    if (expanded[rowSource]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[rowSource];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({
      ...prev,
      [rowSource]: { loading: true, logs: [], error: null },
    }));
    try {
      const logs = await loadCallLogs(buildFilter(rowSource), 50);
      setExpanded((prev) => ({
        ...prev,
        [rowSource]: { loading: false, logs, error: null },
      }));
    } catch (err) {
      setExpanded((prev) => ({
        ...prev,
        [rowSource]: { loading: false, logs: [], error: String(err) },
      }));
    }
  };

  const sourceOptions = [
    { value: '', label: '全部来源' },
    ...(observeOptions?.sources ?? []).map((s) => ({ value: s, label: sourceLabel(s) })),
  ];
  const modelGroups = [
    { options: [{ value: '', label: '全部模型' }] },
    ...(observeOptions?.model_groups ?? []).map((g) => ({
      label: g.provider,
      options: g.models,
    })),
  ];

  const summary = observability?.summary;

  const sortHeader = (label: string, key: SortKey) => (
    <button
      onClick={() => toggleSort(key)}
      className={`flex items-center justify-end gap-0.5 w-full transition-colors cursor-pointer ${
        sort.key === key ? 'text-white/70' : 'text-white/30 hover:text-white/50'
      }`}
    >
      {label}
      {sort.key === key ? (
        sort.dir === 'asc' ? (
          <ArrowUp size={11} />
        ) : (
          <ArrowDown size={11} />
        )
      ) : (
        <ArrowUpDown size={11} className="opacity-60" />
      )}
    </button>
  );

  return (
    <section>
      <div className="mb-3">
        <h3 className="text-sm font-medium text-white/90">模型调用观测</h3>
        <p className="text-xs text-white/40 mt-0.5">
          各功能的 LLM 调用次数、token、耗时与成本
        </p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        {/* 过滤栏 */}
        <div className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center gap-2">
          <CustomSelect
            value={source}
            options={sourceOptions}
            onChange={setSource}
            placeholder="全部来源"
            className="w-32"
            menuClassName="w-44"
          />
          <CustomSelect
            value={model}
            groups={modelGroups}
            onChange={setModel}
            placeholder="全部模型"
            className="w-36"
            menuClassName="w-56"
          />
          <DateRangePicker
            preset={preset}
            since={since}
            until={until}
            followNow={followNow}
            onApply={handleRangeApply}
            className="ml-auto"
          />
        </div>

        {/* 数据看板 */}
        <div className="flex divide-x divide-white/5 border-b border-white/10">
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-white/40">token 总计</div>
            <div className="text-base font-semibold text-white/90 tabular-nums mt-0.5">
              {summary ? fmtTokens(summary.total_tokens) : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-white/40">模型调用</div>
            <div className="text-base font-semibold text-white/90 tabular-nums mt-0.5">
              {summary ? summary.model_calls : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-white/40">工具调用</div>
            <div className="text-base font-semibold text-white/90 tabular-nums mt-0.5">
              {summary ? summary.tool_calls : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-white/40">调用错误</div>
            <div
              className={`text-base font-semibold tabular-nums mt-0.5 ${
                summary && summary.errors > 0 ? 'text-red-400' : 'text-white/90'
              }`}
            >
              {summary ? summary.errors : '—'}
            </div>
          </div>
        </div>

        {/* 调用观测表 */}
        <div
          className={`px-4 py-3 transition-opacity duration-150 ${
            observabilityLoading ? 'opacity-50' : ''
          }`}
        >
          {sortedRows.length === 0 ? (
            <p className="text-white/30 text-xs py-2">
              该筛选条件下还没有调用记录
            </p>
          ) : (
            <div className="space-y-1">
              <div className={`grid ${MAIN_GRID} gap-2 px-2 text-white/30 text-xs items-center`}>
                <span />
                <span>来源</span>
                {sortHeader('次数', 'calls')}
                {sortHeader('token 入/出', 'tokens')}
                {sortHeader('总耗时', 'duration')}
                {sortHeader('成本', 'cost')}
              </div>
              {sortedRows.map((row) => {
                const state = expanded[row.source];
                return (
                  <div key={row.source}>
                    <button
                      onClick={() => toggleExpand(row.source)}
                      className={`w-full grid ${MAIN_GRID} gap-2 items-center px-2 py-1.5 rounded-lg text-xs text-left transition-colors cursor-pointer ${
                        state ? 'bg-white/[0.06]' : 'bg-white/[0.03] hover:bg-white/[0.06]'
                      }`}
                    >
                      <ChevronRight
                        size={12}
                        className={`text-white/40 transition-transform duration-150 ${
                          state ? 'rotate-90' : ''
                        }`}
                      />
                      <span className="text-white/70">{sourceLabel(row.source)}</span>
                      <span className="text-right text-white/60 tabular-nums">
                        {row.calls}
                        {row.errors > 0 && (
                          <span className="text-red-400 ml-1">({row.errors}错)</span>
                        )}
                      </span>
                      <span className="text-right text-white/50 tabular-nums">
                        {fmtTokens(row.input_tokens)}/{fmtTokens(row.output_tokens)}
                      </span>
                      <span className="text-right text-white/50 tabular-nums">
                        {fmtDuration(row.total_duration_ms)}
                      </span>
                      <span className="text-right text-white/60 tabular-nums">
                        {fmtCost(row.cost_usd)}
                      </span>
                    </button>

                    {state && (
                      <div className="ml-6 mt-1 mb-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                        {state.loading ? (
                          <p className="text-white/30 text-xs py-1.5">正在加载调用日志…</p>
                        ) : state.error ? (
                          <p className="text-red-400/80 text-xs py-1.5">
                            加载失败：{state.error}
                          </p>
                        ) : state.logs.length === 0 ? (
                          <p className="text-white/30 text-xs py-1.5">没有调用日志</p>
                        ) : (
                          <div className="space-y-0.5">
                            <div
                              className={`grid ${DETAIL_GRID} gap-2 text-white/25 text-xs py-0.5`}
                            >
                              <span>模型名称</span>
                              <span className="text-right">输入(未命中)</span>
                              <span className="text-right">输入(命中)</span>
                              <span className="text-right">输出</span>
                              <span className="text-right">耗时</span>
                              <span className="text-right">成本</span>
                              <span className="text-right">时间</span>
                            </div>
                            {state.logs.map((logRow) => (
                              <div key={logRow.id}>
                                <div
                                  className={`grid ${DETAIL_GRID} gap-2 items-center text-xs py-1 border-t border-white/5 ${
                                    logRow.status === 'error' ? 'text-red-400/80' : ''
                                  }`}
                                >
                                  <span className="text-white/60 truncate">
                                    {logRow.model ??
                                      (logRow.channel === 'claude_code'
                                        ? 'Claude Code CLI'
                                        : '—')}
                                  </span>
                                  <span className="text-right text-white/50 tabular-nums">
                                    {fmtTokens(
                                      Math.max(
                                        logRow.input_tokens - logRow.cached_input_tokens,
                                        0,
                                      ),
                                    )}
                                  </span>
                                  <span className="text-right text-white/50 tabular-nums">
                                    {fmtTokens(logRow.cached_input_tokens)}
                                  </span>
                                  <span className="text-right text-white/50 tabular-nums">
                                    {fmtTokens(logRow.output_tokens)}
                                  </span>
                                  <span className="text-right text-white/50 tabular-nums">
                                    {fmtDuration(logRow.duration_ms)}
                                  </span>
                                  <span className="text-right text-white/60 tabular-nums">
                                    {fmtCost(logRow.cost_usd)}
                                  </span>
                                  <span className="text-right text-white/40 tabular-nums">
                                    {fmtTime(logRow.created_at)}
                                  </span>
                                </div>
                                {logRow.status === 'error' && logRow.error && (
                                  <p className="text-red-400/60 text-xs pb-1 truncate">
                                    {logRow.error}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-white/25 text-xs mt-2.5">
            成本 = token × 模型单价（在「AI 模型」页配置）；流式调用（翻译/问答）暂不计
            token；Claude Code 通道的工具调用数不可观测，记 0。
          </p>
        </div>
      </div>
    </section>
  );
}
