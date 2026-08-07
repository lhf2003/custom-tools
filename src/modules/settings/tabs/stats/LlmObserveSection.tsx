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
const DETAIL_GRID = 'grid-cols-[1fr_76px_64px_44px_52px_68px_88px]';

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
          return r.cost_cny;
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
        sort.key === key ? 'text-app-text-secondary' : 'text-app-text-disabled hover:text-app-text-tertiary'
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
      <div className="px-3 mb-1.5">
        <h3 className="text-xs font-semibold text-app-text-tertiary">模型调用观测</h3>
      </div>

      <div className="rounded-xl border border-app-border-subtle bg-app-bg-secondary overflow-hidden">
        {/* 过滤栏 */}
        <div className="px-4 py-3 border-b border-app-border-subtle flex flex-wrap items-center gap-2">
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
        <div className="flex divide-x divide-app-border-subtle border-b border-app-border-subtle">
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-app-text-tertiary">token 总计</div>
            <div className="text-base font-semibold text-app-text-primary tabular-nums mt-0.5">
              {summary ? fmtTokens(summary.total_tokens) : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-app-text-tertiary">模型调用</div>
            <div className="text-base font-semibold text-app-text-primary tabular-nums mt-0.5">
              {summary ? summary.model_calls : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-app-text-tertiary">工具调用</div>
            <div className="text-base font-semibold text-app-text-primary tabular-nums mt-0.5">
              {summary ? summary.tool_calls : '—'}
            </div>
          </div>
          <div className="flex-1 px-4 py-3">
            <div className="text-xs text-app-text-tertiary">调用错误</div>
            <div
              className={`text-base font-semibold tabular-nums mt-0.5 ${
                summary && summary.errors > 0 ? 'text-app-status-error-text' : 'text-app-text-primary'
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
            <p className="text-app-text-disabled text-xs py-2">
              该筛选条件下还没有调用记录
            </p>
          ) : (
            <div className="space-y-1">
              <div className={`grid ${MAIN_GRID} gap-2 px-2 text-app-text-disabled text-xs items-center`}>
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
                        state ? 'bg-app-alpha-white-10' : 'bg-app-alpha-white-5 hover:bg-app-alpha-white-10'
                      }`}
                    >
                      <ChevronRight
                        size={12}
                        className={`text-app-text-tertiary transition-transform duration-150 ${
                          state ? 'rotate-90' : ''
                        }`}
                      />
                      <span className="text-app-text-secondary">{sourceLabel(row.source)}</span>
                      <span className="text-right text-app-text-secondary tabular-nums">
                        {row.calls}
                        {row.errors > 0 && (
                          <span className="text-app-status-error-text ml-1">({row.errors}错)</span>
                        )}
                      </span>
                      <span className="text-right text-app-text-tertiary tabular-nums">
                        {fmtTokens(row.input_tokens)}/{fmtTokens(row.output_tokens)}
                      </span>
                      <span className="text-right text-app-text-tertiary tabular-nums">
                        {fmtDuration(row.total_duration_ms)}
                      </span>
                      <span className="text-right text-app-text-secondary tabular-nums">
                        {fmtCost(row.cost_cny)}
                      </span>
                    </button>

                    {state && (
                      <div className="mt-1 mb-2 rounded-lg border border-app-border-subtle bg-app-bg-secondary px-3 py-2">
                        {state.loading ? (
                          <p className="text-app-text-disabled text-xs py-1.5">正在加载调用日志…</p>
                        ) : state.error ? (
                          <p className="text-app-status-error-text text-xs py-1.5">
                            加载失败：{state.error}
                          </p>
                        ) : state.logs.length === 0 ? (
                          <p className="text-app-text-disabled text-xs py-1.5">没有调用日志</p>
                        ) : (
                          <div className="space-y-0.5">
                            <div
                              className={`grid ${DETAIL_GRID} gap-2 text-app-text-disabled text-xs py-0.5`}
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
                                  className={`grid ${DETAIL_GRID} gap-2 items-center text-xs py-1 border-t border-app-border-subtle ${
                                    logRow.status === 'error' ? 'text-app-status-error-text' : ''
                                  }`}
                                >
                                  <span className="text-app-text-secondary truncate">
                                    {logRow.model ??
                                      (logRow.channel === 'claude_code'
                                        ? 'Claude Code CLI'
                                        : '—')}
                                  </span>
                                  <span className="text-right text-app-text-tertiary tabular-nums">
                                    {fmtTokens(
                                      Math.max(
                                        logRow.input_tokens - logRow.cached_input_tokens,
                                        0,
                                      ),
                                    )}
                                  </span>
                                  <span className="text-right text-app-text-tertiary tabular-nums">
                                    {fmtTokens(logRow.cached_input_tokens)}
                                  </span>
                                  <span className="text-right text-app-text-tertiary tabular-nums">
                                    {fmtTokens(logRow.output_tokens)}
                                  </span>
                                  <span className="text-right text-app-text-tertiary tabular-nums">
                                    {fmtDuration(logRow.duration_ms)}
                                  </span>
                                  <span className="text-right text-app-text-secondary tabular-nums">
                                    {fmtCost(logRow.cost_cny)}
                                  </span>
                                  <span className="text-right text-app-text-tertiary tabular-nums">
                                    {fmtTime(logRow.created_at)}
                                  </span>
                                </div>
                                {logRow.status === 'error' && logRow.error && (
                                  <p className="text-app-status-error-text text-xs pb-1 truncate">
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
          <p className="text-app-text-disabled text-xs mt-2.5">
            成本 = token × 模型单价（人民币，在本页模型单价中配置）；Claude Code 通道为订阅制，
            不计成本；流式调用（翻译/问答）暂不计 token；Claude Code 通道的工具调用数不可观测，记 0。
          </p>
        </div>
      </div>
    </section>
  );
}
