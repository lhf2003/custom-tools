import { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Settings,
  Eye,
  EyeOff,
  Save,
  TestTube,
  MessageSquare,
  HelpCircle,
  Languages,
  Brain,
  BookHeart,
  FolderOpen,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { useLlmProviderStore, type Provider, type ProviderType, type Model, type Scene, type SceneConfig } from '@/stores/llmProviderStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Toggle } from '../components/SettingsPrimitives';
import { CustomSelect, type SelectGroup } from '../components/CustomSelect';

// Provider type options
const PROVIDER_TYPES: { value: ProviderType; label: string; baseUrl: string; apiKeyRequired: boolean }[] = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyRequired: true },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKeyRequired: true },
  { value: 'bailian', label: '百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyRequired: true },
  { value: 'ollama', label: 'Ollama 本地', baseUrl: 'http://localhost:11434', apiKeyRequired: false },
  { value: 'custom', label: '自定义', baseUrl: '', apiKeyRequired: true },
];

// Scene labels
const SCENE_LABELS: Record<Scene, { label: string; icon: typeof MessageSquare; description: string }> = {
  chat: { label: '闲聊', icon: MessageSquare, description: '日常对话场景' },
  qa: { label: '问答', icon: HelpCircle, description: '知识问答场景' },
  translate: { label: '翻译', icon: Languages, description: '翻译场景' },
  companion: { label: '陪伴', icon: Bot, description: '陪伴功能（模式挖掘、意图解析）' },
  memory_extraction: { label: '记忆提取', icon: Brain, description: '聊天记忆提炼（缺省跟随陪伴场景）' },
  diary: { label: '情感日记', icon: BookHeart, description: '贾维斯的私有日记（缺省跟随陪伴场景）' },
};

// Connection status badge
const getConnectionStatusBadge = (status: string) => {
  switch (status) {
    case 'connected':
      return { icon: CheckCircle, className: 'text-green-400', label: '已连接' };
    case 'error':
      return { icon: XCircle, className: 'text-red-400', label: '错误' };
    case 'disconnected':
      return { icon: AlertCircle, className: 'text-yellow-400', label: '断开' };
    default:
      return { icon: AlertCircle, className: 'text-gray-400', label: '未知' };
  }
};

export function ModelSettings() {
  const {
    providers,
    models,
    sceneConfigs,
    isLoading,
    loadProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    testProviderConnection,
    refreshProviderModels,
    loadModels,
    setModelActive,
    setModelPrice,
    loadSceneConfigs,
    setSceneModel,
    setSceneThinkingMode,
    setSceneReasoningEffort,
  } = useLlmProviderStore();

  const [expandedProvider, setExpandedProvider] = useState<number | null>(null);
  // 展开的提供商模型列表筛选词（切换展开项时清空）
  const [modelListFilter, setModelListFilter] = useState('');
  useEffect(() => setModelListFilter(''), [expandedProvider]);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [testingProvider, setTestingProvider] = useState<number | null>(null);
  const [refreshingProvider, setRefreshingProvider] = useState<number | null>(null);

  // Claude Code 全局配置（文本输入本地编辑，onBlur 提交）
  const {
    claude_code_enabled,
    claude_code_bin_path,
    claude_code_work_dir,
    setClaudeCodeEnabled,
    setClaudeCodeBinPath,
    setClaudeCodeWorkDir,
  } = useSettingsStore();
  const [binPathInput, setBinPathInput] = useState(claude_code_bin_path);
  const [binPathWarning, setBinPathWarning] = useState<string | null>(null);
  const [workDirInput, setWorkDirInput] = useState(claude_code_work_dir);
  useEffect(() => setBinPathInput(claude_code_bin_path), [claude_code_bin_path]);
  useEffect(() => setWorkDirInput(claude_code_work_dir), [claude_code_work_dir]);

  const browseWorkDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string') {
        await setClaudeCodeWorkDir(selected);
      }
    } catch (e) {
      console.error('Failed to open directory picker:', e);
    }
  };

  // Form state for new/edit provider
  const [formData, setFormData] = useState({
    name: '',
    label: '',
    providerType: 'openai' as ProviderType,
    baseUrl: '',
    apiKey: '',
  });
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    const initData = async () => {
      await loadProviders();
      await loadSceneConfigs();
      // 场景行模型下拉按提供商分组——加载所有已启用提供商的模型（懒加载会留白组）
      const { providers, models, loadModels } = useLlmProviderStore.getState();
      for (const provider of providers.filter((p) => p.is_active)) {
        if (!models[provider.id]) {
          await loadModels(provider.id);
        }
      }
    };
    initData();
  }, [loadProviders, loadSceneConfigs]);

  // Load models when expanding a provider
  const handleToggleExpand = async (providerId: number) => {
    if (expandedProvider === providerId) {
      setExpandedProvider(null);
    } else {
      setExpandedProvider(providerId);
      if (!models[providerId]) {
        await loadModels(providerId);
      }
    }
  };

  // Start adding new provider
  const handleStartAdd = () => {
    setIsAddingProvider(true);
    setEditingProvider(null);
    setFormData({
      name: '',
      label: '',
      providerType: 'openai',
      baseUrl: PROVIDER_TYPES[0].baseUrl,
      apiKey: '',
    });
  };

  // Start editing provider
  const handleStartEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setIsAddingProvider(false);
    setFormData({
      name: provider.name,
      label: provider.label,
      providerType: provider.provider_type,
      baseUrl: provider.base_url,
      apiKey: '', // API key is encrypted, user needs to re-enter
    });
  };

  // Cancel form
  const handleCancelForm = () => {
    setIsAddingProvider(false);
    setEditingProvider(null);
    setFormData({ name: '', label: '', providerType: 'openai', baseUrl: '', apiKey: '' });
  };

  // Handle provider type change
  const handleProviderTypeChange = (type: ProviderType) => {
    const preset = PROVIDER_TYPES.find((p) => p.value === type);
    setFormData((prev) => ({
      ...prev,
      providerType: type,
      baseUrl: preset?.baseUrl || prev.baseUrl,
    }));
  };

  // Save provider (create or update)
  const handleSaveProvider = async () => {
    try {
      if (editingProvider) {
        await updateProvider({
          id: editingProvider.id,
          name: formData.name,
          label: formData.label,
          baseUrl: formData.baseUrl,
          apiKey: formData.apiKey || null,
        });
      } else {
        await createProvider({
          name: formData.name,
          label: formData.label,
          baseUrl: formData.baseUrl,
          apiKey: formData.apiKey || null,
          providerType: formData.providerType,
        });
      }
      handleCancelForm();
    } catch (err) {
      // 失败必须让用户感知——此前静默 console.error，后端拒绝时用户点保存毫无反馈
      alert(`保存提供商失败: ${err}`);
    }
  };

  // Test connection
  const handleTestConnection = async (providerId: number) => {
    setTestingProvider(providerId);
    try {
      await testProviderConnection(providerId);
    } finally {
      setTestingProvider(null);
    }
  };

  // Refresh models
  const handleRefreshModels = async (providerId: number) => {
    setRefreshingProvider(providerId);
    try {
      await refreshProviderModels(providerId);
    } finally {
      setRefreshingProvider(null);
    }
  };

  // Delete provider
  const handleDeleteProvider = async (providerId: number) => {
    if (confirm('确定要删除此提供商吗？')) {
      await deleteProvider(providerId);
    }
  };

  // Toggle model active state
  const handleToggleModelActive = async (model: Model) => {
    await setModelActive(model.id, !model.is_active);
  };

  // 单价输入（非受控 defaultValue + 失焦提交；空串 = 清除，非法输入不落库）
  const handlePriceBlur = async (model: Model, field: 'input' | 'cached_input' | 'output', raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return;
    const current =
      field === 'input'
        ? model.input_price_per_m
        : field === 'cached_input'
          ? model.cached_input_price_per_m
          : model.output_price_per_m;
    if (value === current) return;
    try {
      await setModelPrice(
        model.id,
        field === 'input' ? value : model.input_price_per_m,
        field === 'output' ? value : model.output_price_per_m,
        field === 'cached_input' ? value : model.cached_input_price_per_m,
      );
    } catch (e) {
      alert(`保存单价失败: ${e}`);
    }
  };

  // Handle scene model selection
  const handleSceneModelChange = async (scene: Scene, providerId: number, modelId: string) => {
    // Ensure models are loaded before setting scene model
    if (!models[providerId]) {
      await loadModels(providerId);
    }
    const currentConfig = sceneConfigs[scene];
    const thinkingMode = currentConfig?.thinking_mode ?? false;
    const reasoningEffort = currentConfig?.reasoning_effort ?? 'medium';
    await setSceneModel(scene, providerId, modelId, thinkingMode, reasoningEffort);
  };

  const isFormValid = formData.name && formData.label && formData.baseUrl;

  return (
    <>
      <div className="space-y-4">
        {/* Claude Code 全局配置 */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-white/90 text-sm font-medium">Claude Code</h3>
              <p className="text-white/40 text-xs mt-0.5">
                开启后，支持 Claude Code 的功能（如陪伴）将由本地 Claude Code 执行
              </p>
            </div>
            <Toggle enabled={claude_code_enabled} onToggle={setClaudeCodeEnabled} />
          </div>

          {claude_code_enabled && (
              <div className="divide-y divide-white/5">
                <div className="px-4 py-3">
                  <label className="block text-white/60 text-xs mb-1.5">CLI 路径</label>
                  <input
                      type="text"
                      value={binPathInput}
                      onChange={(e) => setBinPathInput(e.target.value)}
                      onBlur={async () => {
                        const warning = await setClaudeCodeBinPath(binPathInput.trim() || 'claude');
                        setBinPathWarning(warning ?? null);
                      }}
                      placeholder="claude"
                      className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-white/25 transition-colors placeholder:text-white/20"
                  />
                  {binPathWarning ? (
                      <p className="text-amber-400/80 text-xs mt-1.5">⚠ {binPathWarning}（路径已保存，但 Claude Code 功能可能不可用）</p>
                  ) : (
                      <p className="text-white/30 text-xs mt-1.5">claude CLI 可执行文件路径，默认从 PATH 查找</p>
                  )}
                </div>

                <div className="px-4 py-3">
                  <label className="block text-white/60 text-xs mb-1.5">工作目录</label>
                  <div className="flex items-center gap-2">
                    <input
                        type="text"
                        value={workDirInput}
                        onChange={(e) => setWorkDirInput(e.target.value)}
                        onBlur={() => setClaudeCodeWorkDir(workDirInput.trim())}
                        placeholder="留空使用默认目录"
                        className="flex-1 bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-white/25 transition-colors placeholder:text-white/20"
                    />
                    <button
                        onClick={browseWorkDir}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 text-white/60 text-xs border border-white/10 hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <FolderOpen size={14} />
                      <span>浏览</span>
                    </button>
                    <button
                        onClick={() => setClaudeCodeWorkDir('')}
                        className="px-3 py-2 rounded-lg bg-white/5 text-white/60 text-xs border border-white/10 hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      恢复默认
                    </button>
                  </div>
                  <p className="text-white/30 text-xs mt-1.5">
                    Claude Code 执行任务时的工作目录，留空使用默认目录（应用数据目录/companion-agent）
                  </p>
                </div>
              </div>
          )}
        </div>

        {/* Provider List */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <h3 className="text-white/90 text-sm font-medium">提供商列表</h3>
            <button
              onClick={handleStartAdd}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-300 text-xs border border-violet-500/30 hover:bg-violet-500/30 transition-colors cursor-pointer"
            >
              <Plus size={14} />
              添加提供商
            </button>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-white/40 text-sm">加载中...</div>
          ) : providers.length === 0 ? (
            <div className="p-8 text-center text-white/40 text-sm">
              暂无提供商，点击上方按钮添加
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {providers.map((provider) => {
                const providerModels = models[provider.id];
                const modelQuery = modelListFilter.trim().toLowerCase();
                const visibleModels = providerModels
                  ? modelQuery
                    ? providerModels.filter(
                        (m) =>
                          m.name.toLowerCase().includes(modelQuery) ||
                          m.model_id.toLowerCase().includes(modelQuery),
                      )
                    : providerModels
                  : undefined;
                return (
                <div key={provider.id} className="group">
                  {/* Provider Header */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] cursor-pointer transition-colors"
                    onClick={() => handleToggleExpand(provider.id)}
                  >
                    {expandedProvider === provider.id ? (
                      <ChevronDown size={16} className="text-white/40" />
                    ) : (
                      <ChevronRight size={16} className="text-white/40" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-medium truncate">
                          {provider.label}
                        </span>
                      </div>
                      <div className="text-white/40 text-xs truncate">{provider.base_url}</div>
                    </div>

                    {/* Status Badge */}
                    <div className="flex items-center gap-1.5">
                      {(() => {
                        const status = getConnectionStatusBadge(provider.connection_status);
                        const Icon = status.icon;
                        return (
                          <>
                            <Icon size={14} className={status.className} />
                            <span className={`text-xs ${status.className}`}>{status.label}</span>
                          </>
                        );
                      })()}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip content="编辑" placement="top">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(provider);
                          }}
                          className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          <Settings size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip content="测试连接" placement="top">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTestConnection(provider.id);
                          }}
                          disabled={testingProvider === provider.id}
                          className="p-1.5 rounded-lg text-white/40 hover:text-green-400 hover:bg-green-500/10 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <TestTube size={14} className={testingProvider === provider.id ? 'animate-pulse' : ''} />
                        </button>
                      </Tooltip>
                      <Tooltip content="删除" placement="top">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteProvider(provider.id);
                          }}
                          className="p-1.5 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                        >
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  {/* Expanded Models List */}
                  {expandedProvider === provider.id && (
                    <div className="px-4 pb-4 bg-black/20">
                      <div className="flex items-center justify-between py-2 gap-2">
                        <span className="text-white/60 text-xs whitespace-nowrap">
                          可用模型
                          {providerModels && (
                            <span className="text-white/30">
                              （{modelQuery ? `${visibleModels?.length ?? 0}/` : ''}{providerModels.length}）
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          {providerModels && providerModels.length > 10 && (
                            <input
                              type="text"
                              value={modelListFilter}
                              onChange={(e) => setModelListFilter(e.target.value)}
                              placeholder="筛选模型…"
                              className="w-32 bg-zinc-800 text-white/70 text-xs rounded px-2 py-1 outline-none border border-zinc-700 focus:border-white/25 placeholder:text-white/40"
                            />
                          )}
                          <button
                            onClick={() => handleRefreshModels(provider.id)}
                            disabled={refreshingProvider === provider.id}
                            className="flex items-center gap-1 text-white/40 hover:text-white/70 text-xs transition-colors cursor-pointer disabled:opacity-50"
                          >
                            <RefreshCw
                              size={12}
                              className={refreshingProvider === provider.id ? 'animate-spin' : ''}
                            />
                            刷新
                          </button>
                        </div>
                      </div>

                      {!providerModels ? (
                        <div className="text-center py-4 text-white/30 text-xs">加载中...</div>
                      ) : providerModels.length === 0 ? (
                        <div className="text-center py-4 text-white/30 text-xs">
                          暂无模型，点击刷新获取
                        </div>
                      ) : visibleModels && visibleModels.length > 0 ? (
                          <div className="space-y-1">
                            {visibleModels.map((model) => (
                              <div
                                key={model.id}
                                className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.05] transition-colors"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="text-white/80 text-sm truncate">{model.name}</div>
                                  {model.description && (
                                    <div className="text-white/30 text-xs truncate">
                                      {model.description}
                                    </div>
                                  )}
                                </div>
                                <div
                                  className="flex items-center gap-1 mr-1"
                                  title="单价（人民币/百万 token），成本面板据此估算金额；缓存命中输入按缓存价计（未填则按输入价）；留空只统计 token"
                                >
                                  <input
                                    key={`in-${model.id}-${model.input_price_per_m ?? ''}`}
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={model.input_price_per_m ?? ''}
                                    placeholder="入¥/M"
                                    onBlur={(e) => handlePriceBlur(model, 'input', e.target.value)}
                                    className="w-14 bg-zinc-800 text-white/70 text-xs rounded px-1.5 py-1 outline-none border border-zinc-700 focus:border-white/25 placeholder:text-white/20"
                                  />
                                  <input
                                    key={`cin-${model.id}-${model.cached_input_price_per_m ?? ''}`}
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={model.cached_input_price_per_m ?? ''}
                                    placeholder="缓入¥/M"
                                    onBlur={(e) => handlePriceBlur(model, 'cached_input', e.target.value)}
                                    className="w-14 bg-zinc-800 text-white/70 text-xs rounded px-1.5 py-1 outline-none border border-zinc-700 focus:border-white/25 placeholder:text-white/20"
                                  />
                                  <input
                                    key={`out-${model.id}-${model.output_price_per_m ?? ''}`}
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={model.output_price_per_m ?? ''}
                                    placeholder="出¥/M"
                                    onBlur={(e) => handlePriceBlur(model, 'output', e.target.value)}
                                    className="w-14 bg-zinc-800 text-white/70 text-xs rounded px-1.5 py-1 outline-none border border-zinc-700 focus:border-white/25 placeholder:text-white/20"
                                  />
                                </div>
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={model.is_active}
                                    onChange={() => handleToggleModelActive(model)}
                                    className="w-4 h-4 rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/50"
                                  />
                                  <span className="text-white/50 text-xs">启用</span>
                                </label>
                              </div>
                            ))}
                          </div>
                      ) : (
                        <div className="text-center py-4 text-white/30 text-xs">
                          无匹配「{modelListFilter.trim()}」的模型
                        </div>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add/Edit Provider Modal */}
        {(isAddingProvider || editingProvider) && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-xl p-6 border border-violet-500/30 bg-zinc-900 shadow-2xl">
              <div className="space-y-4">
                {/* Provider Type */}
                {!editingProvider && (
                  <div>
                    <label className="block text-white/60 text-xs mb-2">提供商类型</label>
                    <div className="flex flex-wrap gap-2">
                      {PROVIDER_TYPES.map((type) => (
                        <button
                          key={type.value}
                          onClick={() => handleProviderTypeChange(type.value)}
                          className={`px-3 py-1.5 rounded-lg text-xs border transition-all cursor-pointer ${
                            formData.providerType === type.value
                              ? 'bg-violet-500/20 text-violet-300 border-violet-500/40'
                              : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10'
                          }`}
                        >
                          {type.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Name & Label */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-white/60 text-xs mb-1.5">名称 (唯一标识)</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      placeholder="如: openai-main"
                      disabled={!!editingProvider}
                      className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-white/60 text-xs mb-1.5">显示名称</label>
                    <input
                      type="text"
                      value={formData.label}
                      onChange={(e) => setFormData((prev) => ({ ...prev, label: e.target.value }))}
                      placeholder="如: OpenAI 主账号"
                      className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20"
                    />
                  </div>
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-white/60 text-xs mb-1.5">API 基础地址</label>
                  <input
                    type="text"
                    value={formData.baseUrl}
                    onChange={(e) => setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    placeholder="https://api.openai.com/v1"
                    className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20"
                  />
                  <p className="text-white/30 text-xs mt-1">
                    OpenAI 兼容填 /v1 结尾（DeepSeek 填 https://api.deepseek.com）；Ollama 填 http://localhost:11434
                  </p>
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-white/60 text-xs mb-1.5">
                    API Key
                    {!PROVIDER_TYPES.find((t) => t.value === formData.providerType)?.apiKeyRequired && (
                      <span className="ml-1.5 text-[10px] text-green-400/70">(可选)</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={formData.apiKey}
                      onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
                      placeholder={editingProvider ? '留空表示不修改' : 'sk-...'}
                      className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 pr-10 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20"
                    />
                    <button
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors cursor-pointer"
                    >
                      {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3 pt-3">
                  <button
                    onClick={handleSaveProvider}
                    disabled={!isFormValid}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-500 text-white text-sm font-medium hover:bg-violet-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Save size={14} />
                    保存
                  </button>
                  <button
                    onClick={handleCancelForm}
                    className="px-4 py-2 rounded-lg bg-white/5 text-white/70 text-sm border border-white/10 hover:bg-white/10 hover:text-white transition-all cursor-pointer"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scene Configuration */}
        {/* 不带 overflow-hidden：末行（陪伴）的下拉框向下展开时会超出卡片，会被裁掉 */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-white/90 text-sm font-medium">场景模型配置</h3>
            <p className="text-white/40 text-xs mt-0.5">为不同场景选择默认使用的模型</p>
          </div>

          <div className="divide-y divide-white/5">
            {(Object.keys(SCENE_LABELS) as Scene[]).map((scene) => {
              const config = sceneConfigs[scene];
              const SceneIcon = SCENE_LABELS[scene].icon;
              const sceneProvider = providers.find((p) => p.id === config?.provider_id);
              // 强度档位按提供商能力提供：DeepSeek 官方仅 low/high/max（medium 被映射为 high）；
              // OpenAI 系原生 low/medium/high；百炼/Ollama 无此参数（空选项 + 禁用）
              const effortOptions =
                sceneProvider?.provider_type === 'deepseek'
                  ? [
                      { value: 'low', label: '低' },
                      { value: 'high', label: '高' },
                      { value: 'max', label: '极致' },
                    ]
                  : sceneProvider?.provider_type === 'openai' ||
                    sceneProvider?.provider_type === 'custom'
                    ? [
                        { value: 'low', label: '低' },
                        { value: 'medium', label: '中' },
                        { value: 'high', label: '高' },
                      ]
                    : [];

              return (
                <div key={scene} className="px-4 py-3 flex items-center gap-4">
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                    <SceneIcon size={16} className="text-white/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white/80 text-sm">{SCENE_LABELS[scene].label}</div>
                    <div className="text-white/40 text-xs">{SCENE_LABELS[scene].description}</div>
                  </div>

                  {/* Model Select（按提供商分组，选中即绑定提供商+模型） */}
                  {(() => {
                    const modelGroups: SelectGroup[] = [
                      // 已配置时的清除入口（无组头直出）
                      ...(config?.provider_id
                        ? [{ options: [{ value: '__clear__', label: '清除配置' }] }]
                        : []),
                      ...providers
                        .filter((p) => p.is_active)
                        .map((p) => ({
                          label: p.label,
                          options: (models[p.id] ?? [])
                            .filter((m) => m.is_active)
                            .map((m) => ({
                              value: `${p.id}:${m.model_id}`,
                              label: m.name,
                            })),
                        })),
                    ];
                    const totalModelOptions = modelGroups.reduce(
                      (n, g) => n + g.options.length,
                      0,
                    );
                    return (
                      <CustomSelect
                        value={
                          config?.provider_id
                            ? `${config.provider_id}:${config.model_id}`
                            : ''
                        }
                        groups={modelGroups}
                        onChange={(value) => {
                          if (value === '__clear__') {
                            setSceneModel(
                              scene,
                              0,
                              '',
                              config?.thinking_mode ?? false,
                              config?.reasoning_effort ?? 'medium',
                            );
                            return;
                          }
                          const [providerIdStr, ...rest] = value.split(':');
                          const providerId = parseInt(providerIdStr);
                          const modelId = rest.join(':');
                          if (!Number.isNaN(providerId) && modelId) {
                            handleSceneModelChange(scene, providerId, modelId);
                          }
                        }}
                        disabled={totalModelOptions === 0}
                        placeholder="选择模型"
                        className="w-44"
                        menuClassName="w-80 right-0"
                      />
                    );
                  })()}

                  <div className="flex items-center gap-2">
                    {/* Thinking Mode Toggle */}
                    <Tooltip content={config?.thinking_mode ? '思考模式已开启' : '思考模式已关闭'} placement="top">
                      <button
                        onClick={() => setSceneThinkingMode(scene, !config?.thinking_mode)}
                        disabled={!config?.provider_id}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                          config?.thinking_mode
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                            : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'
                        }`}
                      >
                        <Brain size={14} />
                        <span>思考</span>
                      </button>
                    </Tooltip>

                    {/* 思考强度（按提供商能力提供档位；仅思考开启时可调） */}
                    <CustomSelect
                      value={config?.reasoning_effort ?? 'medium'}
                      options={effortOptions}
                      onChange={(value) => {
                        try {
                          setSceneReasoningEffort(scene, value);
                        } catch (e) {
                          alert(`设置思考强度失败: ${e}`);
                        }
                      }}
                      disabled={
                        !config?.provider_id ||
                        !config?.thinking_mode ||
                        effortOptions.length === 0
                      }
                      placeholder="强度"
                      className="w-20"
                      menuClassName="w-24"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
