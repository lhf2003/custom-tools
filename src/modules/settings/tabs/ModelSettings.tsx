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
} from 'lucide-react';
import { useLlmProviderStore, type Provider, type ProviderType, type Model, type Scene } from '@/stores/llmProviderStore';

// Custom Select Component
interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
}

function CustomSelect({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  icon,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownPosition, setDropdownPosition] = useState<'top' | 'bottom'>('bottom');
  const [dropdownMaxHeight, setDropdownMaxHeight] = useState(192);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) {
      const selectedIndex = options.findIndex((opt) => opt.value === value);
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [isOpen, options, value]);

  // Calculate dropdown position based on available space
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const itemHeight = 36; // Estimated height per option
      const padding = 8; // py-1 = 4px * 2
      const estimatedHeight = Math.min(options.length * itemHeight + padding, 192);

      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;

      // If space below is insufficient and space above is sufficient, expand upward
      if (spaceBelow < estimatedHeight && spaceAbove > estimatedHeight) {
        setDropdownPosition('top');
        setDropdownMaxHeight(Math.min(spaceAbove - 16, 192));
      } else {
        setDropdownPosition('bottom');
        setDropdownMaxHeight(Math.min(spaceBelow - 16, 192));
      }
    }
  }, [isOpen, options.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0) {
          onChange(options[highlightedIndex].value);
          setIsOpen(false);
        } else {
          setIsOpen(!isOpen);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex((prev) =>
            prev < options.length - 1 ? prev + 1 : prev
          );
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        }
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
    >
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm
          border transition-all duration-200 ease-out
          ${disabled
            ? 'bg-zinc-800/50 border-zinc-700/50 text-white/30 cursor-not-allowed'
            : 'bg-gradient-to-b from-zinc-800 to-zinc-900 border-zinc-700 text-white/90 hover:border-violet-500/50 hover:shadow-lg hover:shadow-violet-500/10 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 cursor-pointer'
          }
          ${isOpen ? 'border-violet-500 ring-2 ring-violet-500/20' : ''}
        `}
      >
        {icon && <span className="text-white/50">{icon}</span>}
        <span className={`flex-1 text-left truncate ${!selectedOption ? 'text-white/40' : ''}`}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`text-white/50 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown Menu */}
      <div
        ref={listRef}
        style={{ maxHeight: dropdownMaxHeight }}
        className={`
          absolute z-50 w-full py-1 rounded-lg
          bg-gradient-to-b from-zinc-800 to-zinc-900
          border border-zinc-700 shadow-xl shadow-black/50
          transition-all duration-200 ease-out
          ${dropdownPosition === 'top'
            ? 'bottom-full mb-1 origin-bottom'
            : 'top-full mt-1 origin-top'
          }
          ${isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 pointer-events-none'}
          ${dropdownPosition === 'top' && !isOpen ? 'translate-y-2' : ''}
          ${dropdownPosition === 'bottom' && !isOpen ? '-translate-y-2' : ''}
        `}
      >
        <div className="overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-600 scrollbar-track-transparent h-full">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-white/40 text-sm text-center">暂无选项</div>
          ) : (
            options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                disabled={option.disabled}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`
                  w-full px-3 py-2 text-left text-sm transition-colors duration-150
                  ${option.disabled
                    ? 'text-white/30 cursor-not-allowed'
                    : 'text-white/80 hover:text-white hover:bg-violet-500/20 cursor-pointer'
                  }
                  ${value === option.value ? 'bg-violet-500/10 text-violet-300' : ''}
                  ${highlightedIndex === index && !option.disabled ? 'bg-violet-500/20' : ''}
                `}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Provider type options
const PROVIDER_TYPES: { value: ProviderType; label: string; baseUrl: string; apiKeyRequired: boolean }[] = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyRequired: true },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKeyRequired: true },
  { value: 'bailian', label: '百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyRequired: true },
  { value: 'ollama', label: 'Ollama 本地', baseUrl: 'http://localhost:11434', apiKeyRequired: false },
  { value: 'custom', label: '自定义', baseUrl: '', apiKeyRequired: true },
];

// Scene labels
const SCENE_LABELS: Record<Scene, { label: string; icon: typeof MessageSquare; description: string }> = {
  chat: { label: '闲聊', icon: MessageSquare, description: '日常对话场景' },
  qa: { label: '问答', icon: HelpCircle, description: '知识问答场景' },
  translate: { label: '翻译', icon: Languages, description: '翻译场景' },
};

// Provider type badge color
const getProviderTypeColor = (type: ProviderType) => {
  switch (type) {
    case 'openai':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'deepseek':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'bailian':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'ollama':
      return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
    case 'custom':
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    default:
      return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
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
    setProviderActive,
    loadModels,
    setModelActive,
    loadSceneConfigs,
    setSceneModel,
    setSceneThinkingMode,
  } = useLlmProviderStore();

  const [expandedProvider, setExpandedProvider] = useState<number | null>(null);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [testingProvider, setTestingProvider] = useState<number | null>(null);
  const [refreshingProvider, setRefreshingProvider] = useState<number | null>(null);

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
    loadProviders();
    loadSceneConfigs();
  }, []);

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
    console.log('[DEBUG] handleSaveProvider called', { formData, editingProvider: !!editingProvider });
    try {
      if (editingProvider) {
        console.log('[DEBUG] Updating existing provider:', editingProvider.id);
        await updateProvider({
          id: editingProvider.id,
          name: formData.name,
          label: formData.label,
          baseUrl: formData.baseUrl,
          apiKey: formData.apiKey || null,
        });
        console.log('[DEBUG] Provider updated successfully');
      } else {
        console.log('[DEBUG] Creating new provider with data:', {
          name: formData.name,
          label: formData.label,
          base_url: formData.baseUrl,
          providerType: formData.providerType,
        });
        await createProvider({
          name: formData.name,
          label: formData.label,
          baseUrl: formData.baseUrl,
          apiKey: formData.apiKey || null,
          providerType: formData.providerType,
        });
        console.log('[DEBUG] Provider created successfully');
      }
      handleCancelForm();
    } catch (err) {
      console.error('[DEBUG] handleSaveProvider error:', err);
      // Error handled in store
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

  // Handle scene model selection
  const handleSceneModelChange = async (scene: Scene, providerId: number, modelId: string) => {
    // Ensure models are loaded before setting scene model
    if (!models[providerId]) {
      await loadModels(providerId);
    }
    const currentConfig = sceneConfigs[scene];
    const thinkingMode = currentConfig?.thinking_mode ?? false;
    await setSceneModel(scene, providerId, modelId, thinkingMode);
  };

  const isFormValid = formData.name && formData.label && formData.baseUrl;

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-violet-600/20 flex items-center justify-center">
          <Bot size={20} className="text-violet-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">AI 模型</h2>
          <p className="text-white/40 text-xs">配置多提供商 LLM 服务</p>
        </div>
      </div>

      <div className="space-y-4">
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
              {providers.map((provider) => (
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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(provider);
                        }}
                        className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
                        title="编辑"
                      >
                        <Settings size={14} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTestConnection(provider.id);
                        }}
                        disabled={testingProvider === provider.id}
                        className="p-1.5 rounded-lg text-white/40 hover:text-green-400 hover:bg-green-500/10 transition-colors cursor-pointer disabled:opacity-50"
                        title="测试连接"
                      >
                        <TestTube size={14} className={testingProvider === provider.id ? 'animate-pulse' : ''} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProvider(provider.id);
                        }}
                        className="p-1.5 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Models List */}
                  {expandedProvider === provider.id && (
                    <div className="px-4 pb-4 bg-black/20">
                      <div className="flex items-center justify-between py-2">
                        <span className="text-white/60 text-xs">可用模型</span>
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

                      {models[provider.id] ? (
                        models[provider.id].length > 0 ? (
                          <div className="space-y-1">
                            {models[provider.id].map((model) => (
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
                            暂无模型，点击刷新获取
                          </div>
                        )
                      ) : (
                        <div className="text-center py-4 text-white/30 text-xs">加载中...</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
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
                    OpenAI 兼容填 /v1 结尾；Ollama 填 http://localhost:11434
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
        <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-white/90 text-sm font-medium">场景模型配置</h3>
            <p className="text-white/40 text-xs mt-0.5">为不同场景选择默认使用的模型</p>
          </div>

          <div className="divide-y divide-white/5">
            {(Object.keys(SCENE_LABELS) as Scene[]).map((scene) => {
              const config = sceneConfigs[scene];
              const SceneIcon = SCENE_LABELS[scene].icon;

              return (
                <div key={scene} className="px-4 py-3 flex items-center gap-4">
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                    <SceneIcon size={16} className="text-white/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white/80 text-sm">{SCENE_LABELS[scene].label}</div>
                    <div className="text-white/40 text-xs">{SCENE_LABELS[scene].description}</div>
                  </div>

                  {/* Provider & Model Select */}
                  <div className="flex items-center gap-2">
                    <CustomSelect
                      value={config?.provider_id?.toString() || ''}
                      options={[
                        { value: '', label: '选择提供商' },
                        ...providers
                          .filter((p) => p.is_active)
                          .map((provider) => ({
                            value: provider.id.toString(),
                            label: provider.label,
                          })),
                      ]}
                      onChange={async (value) => {
                        const providerId = parseInt(value);
                        const currentThinkingMode = config?.thinking_mode ?? false;
                        if (providerId) {
                          let providerModels = models[providerId];
                          if (!providerModels) {
                            providerModels = await loadModels(providerId);
                          }
                          const activeModels = providerModels?.filter((m) => m.is_active);
                          if (activeModels && activeModels.length > 0) {
                            await setSceneModel(scene, providerId, activeModels[0].model_id, currentThinkingMode);
                          } else if (providerModels && providerModels.length > 0) {
                            await setSceneModel(scene, providerId, providerModels[0].model_id, currentThinkingMode);
                          } else {
                            await setSceneModel(scene, providerId, '', currentThinkingMode);
                          }
                        } else {
                          await setSceneModel(scene, 0, '', currentThinkingMode);
                        }
                      }}
                      placeholder="选择提供商"
                      className="w-28"
                    />

                    <CustomSelect
                      value={config?.model_id || ''}
                      options={
                        config?.provider_id && models[config.provider_id]
                          ? [
                              { value: '', label: '选择模型' },
                              ...models[config.provider_id]
                                .filter((m) => m.is_active)
                                .map((model) => ({
                                  value: model.model_id,
                                  label: model.name,
                                })),
                            ]
                          : [{ value: '', label: '选择模型' }]
                      }
                      onChange={(value) => {
                        if (config?.provider_id) {
                          handleSceneModelChange(scene, config.provider_id, value);
                        }
                      }}
                      disabled={!config?.provider_id}
                      placeholder="选择模型"
                      className="w-32"
                    />

                    {/* Thinking Mode Toggle */}
                    <button
                      onClick={() => setSceneThinkingMode(scene, !config?.thinking_mode)}
                      disabled={!config?.provider_id}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                        config?.thinking_mode
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                          : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'
                      }`}
                      title={config?.thinking_mode ? '思考模式已开启' : '思考模式已关闭'}
                    >
                      <Brain size={14} />
                      <span>思考</span>
                    </button>
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
