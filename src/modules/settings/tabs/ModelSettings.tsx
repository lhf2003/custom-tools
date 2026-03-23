import { useState } from 'react';
import { Bot, Eye, EyeOff, CheckCircle, XCircle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';

interface ProviderPreset {
  label: string;
  baseUrl: string;
  apiKeyRequired: boolean;
  defaultModel: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyRequired: true, defaultModel: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKeyRequired: true, defaultModel: 'deepseek-chat' },
  { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/api/chat', apiKeyRequired: false, defaultModel: 'llama3.2' },
];

const MODEL_PRESETS = [
  { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
  { label: 'GPT-4o', value: 'gpt-4o' },
  { label: 'DeepSeek Chat', value: 'deepseek-chat' },
  { label: 'Claude 3.5 Haiku', value: 'claude-3-5-haiku-20241022' },
  { label: 'Llama 3.2', value: 'llama3.2' },
  { label: 'Qwen 2.5', value: 'qwen2.5' },
  { label: 'Mistral', value: 'mistral' },
];

export function ModelSettings() {
  const { llm_base_url, llm_api_key, llm_model, setLlmBaseUrl, setLlmApiKey, setLlmModel, testLlmConnection } =
    useSettingsStore();

  const [baseUrl, setBaseUrl] = useState(llm_base_url);
  const [apiKey, setApiKey] = useState(llm_api_key);
  const [model, setModel] = useState(llm_model);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const activeProvider = PROVIDER_PRESETS.find((p) => p.baseUrl === baseUrl);

  const applyProvider = (provider: ProviderPreset) => {
    setBaseUrl(provider.baseUrl);
    setModel(provider.defaultModel);
    if (!provider.apiKeyRequired) setApiKey('');
    setTestResult(null);
  };

  const handleSave = async () => {
    await Promise.all([setLlmBaseUrl(baseUrl), setLlmApiKey(apiKey), setLlmModel(model)]);
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    await Promise.all([setLlmBaseUrl(baseUrl), setLlmApiKey(apiKey), setLlmModel(model)]);
    try {
      const reply = await testLlmConnection();
      setTestResult({ ok: true, msg: reply });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-violet-600/20 flex items-center justify-center">
          <Bot size={20} className="text-violet-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">AI 模型</h2>
          <p className="text-white/40 text-xs">配置 OpenAI 兼容的大模型接口</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* 供应商快捷配置 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/90 text-sm font-medium mb-1">快速配置</p>
          <p className="text-white/40 text-xs mb-3">选择服务商后自动填入地址和默认模型</p>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_PRESETS.map((provider) => (
              <button
                key={provider.label}
                onClick={() => applyProvider(provider)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                  activeProvider?.label === provider.label
                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                    : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/80'
                }`}
              >
                {provider.label}
                {!provider.apiKeyRequired && (
                  <span className="ml-1.5 text-[10px] text-green-400/70">无需 Key</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* API 基础地址 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/90 text-sm font-medium mb-1">API 基础地址</p>
          <p className="text-white/40 text-xs mb-3">
            OpenAI 兼容填 <code className="text-white/30">/v1</code> 结尾；Ollama 填完整路径{' '}
            <code className="text-white/30">/api/chat</code>
          </p>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20"
          />
        </div>

        {/* API Key */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-white/90 text-sm font-medium">API Key</p>
            {activeProvider && !activeProvider.apiKeyRequired && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/15 text-green-400 border border-green-500/20">
                可选
              </span>
            )}
          </div>
          <p className="text-white/40 text-xs mb-3">
            {activeProvider && !activeProvider.apiKeyRequired
              ? 'Ollama 等本地模型无需 API Key，留空即可'
              : '密钥仅存储在本地，不会上传至任何服务器'}
          </p>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 pr-10 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20"
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors cursor-pointer"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* 模型名称 */}
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <p className="text-white/90 text-sm font-medium mb-1">模型名称</p>
          <p className="text-white/40 text-xs mb-3">填写具体的模型标识符，或点击下方快捷选择</p>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className="w-full bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 outline-none border border-zinc-700 focus:border-violet-500/60 transition-colors placeholder:text-white/20 mb-3"
          />
          <div className="flex flex-wrap gap-2">
            {MODEL_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setModel(preset.value)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                  model === preset.value
                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                    : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/80'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="px-5 py-2 rounded-lg bg-violet-500 text-white text-sm font-medium hover:bg-violet-600 transition-all duration-200 cursor-pointer"
          >
            保存
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-5 py-2 rounded-lg bg-white/5 text-white/70 text-sm border border-white/10 hover:bg-white/10 hover:text-white transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {testing && (
              <span className="inline-block w-3.5 h-3.5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
            )}
            测试连接
          </button>
        </div>

        {/* 测试结果 */}
        {testResult && (
          <div
            className={`flex items-start gap-3 rounded-xl p-4 border text-sm ${
              testResult.ok
                ? 'bg-green-500/5 border-green-500/30 text-green-300'
                : 'bg-red-500/5 border-red-500/30 text-red-300'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle size={16} className="flex-shrink-0 mt-0.5" />
            ) : (
              <XCircle size={16} className="flex-shrink-0 mt-0.5" />
            )}
            <span className="break-all leading-relaxed">{testResult.msg}</span>
          </div>
        )}
      </div>
    </>
  );
}
