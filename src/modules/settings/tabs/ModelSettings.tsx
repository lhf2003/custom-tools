import { useState, useEffect } from 'react';
import {
  Bot,
  Plus,
  Trash2,
  RefreshCw,
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
  RotateCcw,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { useLlmProviderStore, type Provider, type ProviderType, type Model, type Scene } from '@/stores/llmProviderStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';
import { CustomSelect, type SelectGroup } from '../components/CustomSelect';
import { LlmObserveSection } from './stats/LlmObserveSection';

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
  companion: { label: '陪伴', icon: Bot, description: '模式挖掘、意图解析' },
  memory_extraction: { label: '记忆提取', icon: Brain, description: '聊天记忆提炼' },
  diary: { label: '情感日记', icon: BookHeart, description: '贾维斯的私有日记' },
};

// 连接状态徽章：圆点 + 文字范式（与设置页其它状态徽章一致）
const getConnectionStatusBadge = (status: string): { dotClass: string; label: string } => {
  switch (status) {
    case 'connected':
      return { dotClass: 'bg-app-status-success', label: '已连接' };
    case 'error':
      return { dotClass: 'bg-app-status-error', label: '错误' };
    case 'disconnected':
      return { dotClass: 'bg-app-status-warning', label: '断开' };
    default:
      return { dotClass: 'bg-app-text-disabled', label: '未知' };
  }
};

// 表单输入框统一类（设置页规范：tertiary 底 + subtle 边框 + focus 提亮）
const inputClass =
  'bg-app-bg-tertiary text-app-text-primary text-sm rounded-lg px-3 py-2 outline-none border border-app-border-subtle focus:border-app-border-emphasis transition-colors placeholder:text-app-text-placeholder';

// 小号输入框（模型单价等行内紧凑输入）
const smallInputClass =
  'bg-app-bg-tertiary text-app-text-secondary text-xs rounded px-1.5 py-1 outline-none border border-app-border-subtle focus:border-app-border-emphasis transition-colors placeholder:text-app-text-placeholder';

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

  // 提供商行内编辑/添加表单（模态 → 行内：添加时插列表顶部，编辑时替换展开区）
  const renderProviderForm = () => (
    <div className="px-4 py-4 bg-app-bg-tertiary">
      <div className="space-y-3">
        {/* Provider Type（仅新建时可选） */}
        {!editingProvider && (
          <div>
            <label className="block text-app-text-tertiary text-xs mb-2">提供商类型</label>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => handleProviderTypeChange(type.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-all cursor-pointer ${
                    formData.providerType === type.value
                      ? 'bg-app-bg-elevated text-app-text-primary border-app-border-emphasis font-medium'
                      : 'bg-transparent text-app-text-tertiary border-app-border-subtle hover:bg-app-bg-hover hover:text-app-text-secondary'
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
            <label className="block text-app-text-tertiary text-xs mb-1.5">名称 (唯一标识)</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="如: openai-main"
              disabled={!!editingProvider}
              className={`w-full ${inputClass} disabled:opacity-50`}
            />
          </div>
          <div>
            <label className="block text-app-text-tertiary text-xs mb-1.5">显示名称</label>
            <input
              type="text"
              value={formData.label}
              onChange={(e) => setFormData((prev) => ({ ...prev, label: e.target.value }))}
              placeholder="如: OpenAI 主账号"
              className={`w-full ${inputClass}`}
            />
          </div>
        </div>

        {/* Base URL */}
        <div>
          <label className="block text-app-text-tertiary text-xs mb-1.5">API 基础地址</label>
          <input
            type="text"
            value={formData.baseUrl}
            onChange={(e) => setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))}
            placeholder="https://api.openai.com/v1"
            className={`w-full ${inputClass}`}
          />
          <p className="text-app-text-disabled text-xs mt-1">
            OpenAI 兼容填 /v1 结尾（DeepSeek 填 https://api.deepseek.com）；Ollama 填 http://localhost:11434
          </p>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-app-text-tertiary text-xs mb-1.5">
            API Key
            {!PROVIDER_TYPES.find((t) => t.value === formData.providerType)?.apiKeyRequired && (
              <span className="ml-1.5 text-[10px] text-app-status-success">(可选)</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={formData.apiKey}
              onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={editingProvider ? '留空表示不修改' : 'sk-...'}
              className={`w-full ${inputClass} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
            >
              {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleSaveProvider}
            disabled={!isFormValid}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-app-status-info text-white text-sm font-medium hover:bg-app-status-info-deep transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Save size={14} />
            保存
          </button>
          <button
            onClick={handleCancelForm}
            className="px-4 py-2 rounded-lg bg-app-bg-tertiary text-app-text-secondary text-sm border border-app-border-subtle hover:bg-app-bg-hover hover:text-app-text-primary transition-all cursor-pointer"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Harness 工具：Claude Code 开关 + 展开配置 */}
      <SettingGroup title="Harness 工具">
        <SettingRow
          title="Claude Code"
          description="开启后，支持 Claude Code 的功能（如陪伴）将由本地 Claude Code 执行"
        >
          <Toggle enabled={claude_code_enabled} onToggle={setClaudeCodeEnabled} />
        </SettingRow>

        {claude_code_enabled && (
          <>
            <SettingRow
              title="CLI 路径"
              description={
                binPathWarning ? (
                  <span className="text-app-status-warning-text">
                    ⚠ {binPathWarning}（路径已保存，但 Claude Code 功能可能不可用）
                  </span>
                ) : (
                  'claude CLI 可执行文件路径，默认从 PATH 查找'
                )
              }
            >
              <input
                type="text"
                value={binPathInput}
                onChange={(e) => setBinPathInput(e.target.value)}
                onBlur={async () => {
                  const warning = await setClaudeCodeBinPath(binPathInput.trim() || 'claude');
                  setBinPathWarning(warning ?? null);
                }}
                placeholder="claude"
                className={`w-72 ${inputClass}`}
              />
            </SettingRow>

            <SettingRow title="工作目录" description="">
              <input
                type="text"
                value={workDirInput}
                onChange={(e) => setWorkDirInput(e.target.value)}
                onBlur={() => setClaudeCodeWorkDir(workDirInput.trim())}
                placeholder={`%APPDATA%\\com.flowhub.app\\companion-agent`}
                className={`w-72 ${inputClass}`}
              />
              <button
                onClick={browseWorkDir}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-app-alpha-white-5 text-app-text-tertiary text-xs border border-app-border-subtle hover:bg-app-alpha-white-10 hover:text-app-text-primary transition-colors cursor-pointer"
              >
                <FolderOpen size={14} />
                <span>浏览</span>
              </button>
              <Tooltip content="恢复默认" placement="top">
                <button
                  onClick={() => setClaudeCodeWorkDir('')}
                  className="p-2 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {/* Provider List */}
      <SettingGroup
        title="提供商列表"
        actions={
          <button
            onClick={handleStartAdd}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:bg-app-bg-hover hover:text-app-text-primary transition-colors cursor-pointer"
          >
            <Plus size={14} />
            添加提供商
          </button>
        }
      >
        {/* 添加表单（行内展开于列表顶部） */}
        {isAddingProvider && renderProviderForm()}

        {isLoading ? (
          <p className="px-3 py-6 text-center text-app-text-disabled text-sm">加载中...</p>
        ) : providers.length === 0 ? (
          <p className="px-3 py-6 text-center text-app-text-disabled text-sm">
            暂无提供商，点击上方按钮添加
          </p>
        ) : (
          providers.map((provider) => {
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
            const badge = getConnectionStatusBadge(provider.connection_status);
            const isExpanded = expandedProvider === provider.id;
            return (
              <div key={provider.id} className="group">
                {/* Provider Header（可折叠行：ToolsSettings 分组头范式） */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => handleToggleExpand(provider.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleToggleExpand(provider.id);
                    }
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-app-bg-hover transition-colors cursor-pointer"
                >
                  <ChevronRight
                    size={14}
                    className={`text-app-text-tertiary transition-transform duration-150 ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="text-app-text-primary text-sm font-medium truncate">
                      {provider.label}
                    </div>
                    <div className="text-app-text-tertiary text-xs truncate">{provider.base_url}</div>
                  </div>

                  {/* 连接状态徽章（圆点 + 文字） */}
                  <span className="flex items-center gap-1.5 text-xs text-app-text-tertiary flex-shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${badge.dotClass}`} />
                    {badge.label}
                  </span>

                  {/* Actions（hover 显现；各按钮自带 stopPropagation） */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Tooltip content="编辑" placement="top">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(provider);
                        }}
                        className="p-1.5 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer"
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
                        className="p-1.5 rounded-lg text-app-text-tertiary hover:text-app-status-success hover:bg-app-bg-hover transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <TestTube
                          size={14}
                          className={testingProvider === provider.id ? 'animate-pulse' : ''}
                        />
                      </button>
                    </Tooltip>
                    <Tooltip content="删除" placement="top">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProvider(provider.id);
                        }}
                        className="p-1.5 rounded-lg text-app-text-tertiary hover:text-app-status-error-text hover:bg-app-bg-hover transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* 编辑表单（行内替换展开区） */}
                {editingProvider?.id === provider.id ? (
                  renderProviderForm()
                ) : (
                  isExpanded && (
                    <div className="px-3 pb-3 pl-9">
                      {/* 展开区头部：可用模型 + 筛选 + 刷新 */}
                      <div className="flex items-center justify-between py-1.5 gap-2">
                        <span className="text-app-text-tertiary text-xs whitespace-nowrap">
                          可用模型
                          {providerModels && (
                            <span className="text-app-text-disabled">
                              （{modelQuery ? `${visibleModels?.length ?? 0}/` : ''}
                              {providerModels.length}）
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
                              className="w-32 bg-app-bg-tertiary text-app-text-secondary text-xs rounded px-2 py-1 outline-none border border-app-border-subtle focus:border-app-border-emphasis transition-colors placeholder:text-app-text-placeholder"
                            />
                          )}
                          <button
                            onClick={() => handleRefreshModels(provider.id)}
                            disabled={refreshingProvider === provider.id}
                            className="flex items-center gap-1 text-app-text-tertiary hover:text-app-text-primary text-xs transition-colors cursor-pointer disabled:opacity-50"
                          >
                            <RefreshCw
                              size={12}
                              className={refreshingProvider === provider.id ? 'animate-spin' : ''}
                            />
                            刷新
                          </button>
                        </div>
                      </div>

                      {/* 模型列表（无铺底行 + hairline 分隔 + hover 微反馈） */}
                      {!providerModels ? (
                        <div className="text-center py-4 text-app-text-disabled text-xs">加载中...</div>
                      ) : providerModels.length === 0 ? (
                        <div className="text-center py-4 text-app-text-disabled text-xs">
                          暂无模型，点击刷新获取
                        </div>
                      ) : visibleModels && visibleModels.length > 0 ? (
                        <div className="divide-y divide-app-border-subtle">
                          {visibleModels.map((model) => (
                            <div
                              key={model.id}
                              className="flex items-center justify-between gap-3 py-2 px-1.5 rounded-lg hover:bg-app-bg-hover transition-colors"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-app-text-secondary text-sm truncate">
                                  {model.name}
                                </div>
                                {model.description && (
                                  <div className="text-app-text-tertiary text-xs truncate">
                                    {model.description}
                                  </div>
                                )}
                              </div>
                              <Tooltip
                                content="单价（人民币/百万 token），成本面板据此估算金额；缓存命中输入按缓存价计（未填则按输入价）；留空只统计 token"
                                wrapperClassName="flex items-center gap-1 mr-1 flex-shrink-0"
                              >
                                <div className="flex items-center gap-1 mr-1 flex-shrink-0">
                                <input
                                  key={`in-${model.id}-${model.input_price_per_m ?? ''}`}
                                  type="text"
                                  inputMode="decimal"
                                  defaultValue={model.input_price_per_m ?? ''}
                                  placeholder="入¥/M"
                                  onBlur={(e) => handlePriceBlur(model, 'input', e.target.value)}
                                  className={`w-14 ${smallInputClass}`}
                                />
                                <input
                                  key={`cin-${model.id}-${model.cached_input_price_per_m ?? ''}`}
                                  type="text"
                                  inputMode="decimal"
                                  defaultValue={model.cached_input_price_per_m ?? ''}
                                  placeholder="缓入¥/M"
                                  onBlur={(e) => handlePriceBlur(model, 'cached_input', e.target.value)}
                                  className={`w-14 ${smallInputClass}`}
                                />
                                <input
                                  key={`out-${model.id}-${model.output_price_per_m ?? ''}`}
                                  type="text"
                                  inputMode="decimal"
                                  defaultValue={model.output_price_per_m ?? ''}
                                  placeholder="出¥/M"
                                  onBlur={(e) => handlePriceBlur(model, 'output', e.target.value)}
                                  className={`w-14 ${smallInputClass}`}
                                />
                                </div>
                              </Tooltip>
                              <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                                <input
                                  type="checkbox"
                                  checked={model.is_active}
                                  onChange={() => handleToggleModelActive(model)}
                                  className="w-4 h-4 rounded accent-[var(--app-brand-primary)]"
                                />
                                <span className="text-app-text-tertiary text-xs">启用</span>
                              </label>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-4 text-app-text-disabled text-xs">
                          无匹配「{modelListFilter.trim()}」的模型
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            );
          })
        )}
      </SettingGroup>

      {/* Scene Configuration */}
      {/* 不带 overflow-hidden：末行（陪伴）的下拉框向下展开时会超出卡片，会被裁掉 */}
      <SettingGroup title="场景模型配置">
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
            <div key={scene} className="flex items-center gap-3 px-3 py-3">
              <SceneIcon size={16} className="text-app-text-tertiary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-app-text-primary text-sm">{SCENE_LABELS[scene].label}</div>
                <div className="text-app-text-tertiary text-xs mt-0.5">
                  {SCENE_LABELS[scene].description}
                </div>
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
                  />
                );
              })()}

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Thinking Mode（规范开关组件；未选模型时禁用） */}
                <span className="text-app-text-tertiary text-xs flex-shrink-0">思考</span>
                <Tooltip content={config?.thinking_mode ? '思考模式已开启' : '思考模式已关闭'} placement="top">
                  <Toggle
                    enabled={config?.thinking_mode ?? false}
                    onToggle={() => setSceneThinkingMode(scene, !config?.thinking_mode)}
                    disabled={!config?.provider_id}
                  />
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
      </SettingGroup>

      {/* 模型调用观测：各功能的 LLM 调用次数、token、耗时与成本 */}
      <LlmObserveSection />
    </>
  );
}
