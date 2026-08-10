import { useEffect, useRef, useState } from 'react';
import { Bot, Brain, Check, ChevronDown } from 'lucide-react';
import { useLlmProviderStore } from '@/stores/llmProviderStore';

/** 思考等级 → 中文标签（与设置页强度档位一致） */
const EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '极致',
};

/**
 * 聊天页头部模型/思考选择器（新会话按钮左侧）：两个独立按钮。
 * - 模型按钮：展开按提供商分组的模型下拉，选中即切换 chat 场景模型
 * - 思考按钮：展开「关闭 + 三个思考等级」（等级按提供商能力提供），选中即改思考模式
 * 数据与设置页「模型 → 场景模型配置」共用 llmProviderStore，改动即时落库。
 */
export function ModelSelector() {
  const {
    providers,
    models,
    sceneConfigs,
    loadProviders,
    loadSceneConfigs,
    loadModels,
    setSceneModel,
    setSceneThinkingMode,
  } = useLlmProviderStore();

  const [openPanel, setOpenPanel] = useState<'model' | 'thinking' | null>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; right: number } | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const thinkingBtnRef = useRef<HTMLButtonElement>(null);

  // 挂载时懒加载：providers / chat 场景配置 / 已启用提供商的模型列表
  useEffect(() => {
    const init = async () => {
      const state = useLlmProviderStore.getState();
      if (state.providers.length === 0) await state.loadProviders();
      if (!state.sceneConfigs.chat) await state.loadSceneConfigs();
      const { providers: ps, models: ms, loadModels: lm } = useLlmProviderStore.getState();
      for (const p of ps.filter((x) => x.is_active)) {
        if (!ms[p.id]) await lm(p.id);
      }
    };
    init();
  }, []);

  const config = sceneConfigs.chat;
  const provider = providers.find((p) => p.id === config?.provider_id);
  const model =
    config && provider
      ? (models[provider.id] ?? []).find((m) => m.model_id === config.model_id)
      : undefined;

  // 思考等级按提供商能力提供（与设置页一致）：DeepSeek 官方仅低/高/极致，
  // OpenAI 系低/中/高；百炼/Ollama 无此参数（思考下拉只剩「关闭」）
  const effortOptions =
    provider?.provider_type === 'deepseek'
      ? [
          { value: 'low', label: '低' },
          { value: 'high', label: '高' },
          { value: 'max', label: '极致' },
        ]
      : provider?.provider_type === 'openai' || provider?.provider_type === 'custom'
        ? [
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' },
          ]
        : [];

  /** 按提供商分组的模型列表（含已配置时的清除入口） */
  const modelGroups = [
    ...(config?.provider_id ? [{ label: null, options: [{ value: '__clear__', name: '清除配置' }] }] : []),
    ...providers
      .filter((p) => p.is_active)
      .map((p) => ({
        label: p.label,
        options: (models[p.id] ?? [])
          .filter((m) => m.is_active)
          .map((m) => ({ value: `${p.id}:${m.model_id}`, name: m.name })),
      })),
  ];
  const totalModelOptions = modelGroups.reduce((n, g) => n + g.options.length, 0);

  const handleModelChange = async (value: string) => {
    const currentConfig = sceneConfigs.chat;
    if (value === '__clear__') {
      await setSceneModel('chat', 0, '', currentConfig?.thinking_mode ?? false, currentConfig?.reasoning_effort ?? 'medium');
      return;
    }
    const [providerIdStr, ...rest] = value.split(':');
    const providerId = parseInt(providerIdStr);
    const modelId = rest.join(':');
    if (Number.isNaN(providerId) || !modelId) return;
    // 选中了未加载的提供商时先取模型列表，避免切换后配置悬空
    if (!models[providerId]) {
      try {
        await loadModels(providerId);
      } catch {
        // 加载失败由下拉空态兜底，不阻断切换
      }
    }
    await setSceneModel('chat', providerId, modelId, currentConfig?.thinking_mode ?? false, currentConfig?.reasoning_effort ?? 'medium');
    setOpenPanel(null);
  };

  const handleEffortChange = async (value: string) => {
    if (value === '__off__') {
      await setSceneThinkingMode('chat', false);
    } else if (config?.provider_id && config.model_id) {
      // 选等级：一次性落库（思考开 + 该等级），保留当前模型
      await setSceneModel('chat', config.provider_id, config.model_id, true, value);
    }
    setOpenPanel(null);
  };

  const openPanelAt = (panel: 'model' | 'thinking') => {
    const ref = panel === 'model' ? modelBtnRef : thinkingBtnRef;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setMenuBox({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpenPanel(panel);
  };

  const togglePanel = (panel: 'model' | 'thinking') => {
    if (openPanel === panel) {
      setOpenPanel(null);
    } else {
      openPanelAt(panel);
    }
  };

  const thinkingLabel = config?.thinking_mode
    ? EFFORT_LABELS[config.reasoning_effort] ?? config.reasoning_effort
    : '关闭';

  const isCurrentEffort = (value: string) =>
    value === '__off__'
      ? !config?.thinking_mode
      : !!config?.thinking_mode && config.reasoning_effort === value;

  const isCurrentModel = (value: string) =>
    config?.provider_id ? value === `${config.provider_id}:${config.model_id}` : false;

  const menuStyle = {
    top: menuBox?.top,
    right: menuBox?.right,
    WebkitBackdropFilter: 'blur(20px)',
    backdropFilter: 'blur(20px)',
  } as React.CSSProperties;

  return (
    <>
      {/* 点击外部关闭（fixed 遮罩 z-40，低于面板） */}
      {openPanel && <div className="fixed inset-0 z-40" onClick={() => setOpenPanel(null)} data-tauri-drag-region={undefined} />}

      {/* 模型按钮：模型名（未配置时提示） */}
      <button
        ref={modelBtnRef}
        onClick={() => togglePanel('model')}
        className={`shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs transition-all cursor-pointer ${
          openPanel === 'model'
            ? 'bg-white/10 text-zinc-100'
            : 'text-zinc-300 hover:bg-white/10 hover:text-zinc-100'
        }`}
        data-tauri-drag-region={undefined}
        aria-label="选择模型"
      >
        <Bot size={13} className={model ? 'text-zinc-400' : 'text-zinc-500'} />
        <span className={`max-w-[120px] truncate ${model ? '' : 'text-zinc-500'}`}>
          {model ? model.name : '未配置模型'}
        </span>
        <ChevronDown
          size={13}
          className={`text-zinc-500 transition-transform duration-150 ${openPanel === 'model' ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 思考按钮：当前状态（关闭 / 等级）；未配置模型时禁用 */}
      <button
        ref={thinkingBtnRef}
        onClick={() => togglePanel('thinking')}
        disabled={!config?.provider_id}
        className={`shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          openPanel === 'thinking'
            ? 'bg-white/10 text-zinc-100'
            : 'text-zinc-300 hover:bg-white/10 hover:text-zinc-100'
        }`}
        data-tauri-drag-region={undefined}
        aria-label="选择思考模式"
      >
        <Brain size={13} className="text-zinc-400" />
        <span>思考 {thinkingLabel}</span>
        <ChevronDown
          size={13}
          className={`text-zinc-500 transition-transform duration-150 ${openPanel === 'thinking' ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 模型面板：按提供商分组的模型列表，点击即选即关 */}
      {openPanel === 'model' && menuBox && (
        <div
          className="fixed z-50 min-w-[200px] max-w-[260px] max-h-[300px] overflow-y-auto rounded-xl border border-app-border bg-app-bg-primary/80 shadow-lg p-1.5 animate-in fade-in duration-150"
          style={menuStyle}
          data-tauri-drag-region={undefined}
        >
          {totalModelOptions === 0 ? (
            <div className="px-2.5 py-3 text-center text-xs text-app-text-tertiary">暂无可用模型</div>
          ) : (
            modelGroups.map((group, gi) => (
              <div key={group.label ?? `g${gi}`}>
                {group.label && (
                  <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-app-text-tertiary">
                    {group.label}
                  </div>
                )}
                {group.options.map((opt) => {
                  const current = isCurrentModel(opt.value);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => handleModelChange(opt.value)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                        current
                          ? 'text-app-brand-primary bg-app-bg-hover'
                          : 'text-zinc-300 hover:bg-white/10 hover:text-zinc-100'
                      }`}
                    >
                      <span className="truncate">{opt.name}</span>
                      {current && <Check size={12} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}

      {/* 思考面板：关闭 + 思考等级，点击即选即关 */}
      {openPanel === 'thinking' && menuBox && (
        <div
          className="fixed z-50 min-w-[140px] rounded-xl border border-app-border bg-app-bg-primary/80 shadow-lg p-1.5 animate-in fade-in duration-150"
          style={menuStyle}
          data-tauri-drag-region={undefined}
        >
          {[{ value: '__off__', label: '关闭' }, ...effortOptions].map((opt) => {
            const current = isCurrentEffort(opt.value);
            return (
              <button
                key={opt.value}
                onClick={() => handleEffortChange(opt.value)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                  current
                    ? 'text-app-brand-primary bg-app-bg-hover'
                    : 'text-zinc-300 hover:bg-white/10 hover:text-zinc-100'
                }`}
              >
                <span>{opt.label}</span>
                {current && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
