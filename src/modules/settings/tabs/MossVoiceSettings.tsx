import { useState, useEffect, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { SettingGroup, SettingRow, Toggle } from '../components/SettingsPrimitives';

// 表单输入框统一类（设置页规范：tertiary 底 + subtle 边框 + focus 提亮；与 ModelSettings 同款）
const inputClass =
  'bg-app-bg-tertiary text-app-text-primary text-sm rounded-lg px-3 py-2 outline-none border border-app-border-subtle focus:border-app-border-emphasis transition-colors placeholder:text-app-text-placeholder';

interface MossVoiceSettingsProps {
  onBack: () => void;
}

/**
 * 语音服务二级页（模型 tab →「语音服务」组入口行进入）：
 * Moss API Key（语音输入转写 + 播报共用）与语音播报（开关/音色/语速）。
 * Key 加密存后端，此处只读写「是否已配置」。
 */
export function MossVoiceSettings({ onBack }: MossVoiceSettingsProps) {
  const { addToast } = useToastStore();

  const [mossKey, setMossKey] = useState('');
  const [mossConfigured, setMossConfigured] = useState(false);
  const [showMossKey, setShowMossKey] = useState(false);
  const [mossSaving, setMossSaving] = useState(false);
  // 语音播报开关(默认开)与音色 ID(空 = 后端默认音色)
  const [mossTtsEnabled, setMossTtsEnabled] = useState(true);
  const [mossVoiceId, setMossVoiceId] = useState('');
  // 播报语速(0.25~4,默认 1)
  const [mossSpeed, setMossSpeed] = useState(1);

  useEffect(() => {
    invoke<boolean>('moss_key_status')
      .then(setMossConfigured)
      .catch(() => {});
    invoke<string | null>('get_setting', { key: 'moss_tts_enabled' })
      .then((v) => setMossTtsEnabled(v !== 'false'))
      .catch(() => {});
    invoke<string | null>('get_setting', { key: 'moss_voice_id' })
      .then((v) => setMossVoiceId(v ?? ''))
      .catch(() => {});
    invoke<string | null>('get_setting', { key: 'moss_tts_speed' })
      .then((v) => {
        const n = Number(v);
        if (v !== null && Number.isFinite(n)) {
          setMossSpeed(Math.min(4, Math.max(0.25, n)));
        }
      })
      .catch(() => {});
  }, []);

  const handleSaveMossKey = async () => {
    const key = mossKey.trim();
    if (!key || mossSaving) return;
    setMossSaving(true);
    try {
      await invoke('moss_set_api_key', { key });
      setMossConfigured(true);
      setMossKey('');
      addToast({ type: 'success', title: 'Moss API Key 已保存' });
    } catch (err) {
      addToast({ type: 'error', title: '保存失败', message: String(err) });
    } finally {
      setMossSaving(false);
    }
  };

  const handleClearMossKey = async () => {
    try {
      await invoke('moss_set_api_key', { key: '' });
      setMossConfigured(false);
      addToast({ type: 'success', title: 'Moss API Key 已清除' });
    } catch (err) {
      addToast({ type: 'error', title: '清除失败', message: String(err) });
    }
  };

  const handleToggleMossTts = async (enabled: boolean) => {
    setMossTtsEnabled(enabled);
    try {
      await invoke('set_setting', {
        key: 'moss_tts_enabled',
        value: enabled ? 'true' : 'false',
      });
    } catch (err) {
      setMossTtsEnabled(!enabled);
      addToast({ type: 'error', title: '播报开关保存失败', message: String(err) });
    }
  };

  const handleSaveMossVoiceId = async () => {
    try {
      await invoke('set_setting', { key: 'moss_voice_id', value: mossVoiceId.trim() });
      addToast({ type: 'success', title: '音色 ID 已保存' });
    } catch (err) {
      addToast({ type: 'error', title: '音色 ID 保存失败', message: String(err) });
    }
  };

  // 语速滑杆:onChange 即写库(Rust 每次播报现读,下一条即生效)
  const handleMossSpeedChange = (v: number) => {
    setMossSpeed(v);
    invoke('set_setting', { key: 'moss_tts_speed', value: String(v) }).catch(() => {});
  };

  const handleOpenMossPlatform = async () => {
    try {
      await invoke('open_external_url', { url: 'https://platform.mosi.cn/' });
    } catch (err) {
      addToast({ type: 'error', title: '打开链接失败', message: String(err) });
    }
  };

  return (
    <div>
      {/* 头部：返回 + 标题 + Key 配置状态徽章（圆点 + 文字范式） */}
      <div className="flex items-center gap-2 px-1 pb-3">
        <button
          onClick={onBack}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
          aria-label="返回"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="text-white/90 text-sm font-medium">语音服务</h2>
        <span className="flex items-center gap-1.5 text-xs text-app-text-tertiary">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              mossConfigured ? 'bg-app-status-success' : 'bg-app-text-disabled'
            }`}
          />
          {mossConfigured ? 'API Key 已配置' : 'API Key 未配置'}
        </span>
      </div>

      {/* API Key：独立整页后输入区不再挤在行内，全宽舒展排布 */}
      <SettingGroup title="Moss API Key">
        <div className="px-3 py-3">
          <p className="text-app-text-tertiary text-xs leading-relaxed mb-2.5">
            用于聊天语音输入（录音转文字）与回复语音播报。在{' '}
            <button
              type="button"
              onClick={handleOpenMossPlatform}
              className="inline-flex items-center gap-0.5 text-app-status-info hover:underline underline-offset-2 transition-colors cursor-pointer"
            >
              platform.mosi.cn
              <ExternalLink size={11} />
            </button>{' '}
            控制台创建
          </p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <input
                type={showMossKey ? 'text' : 'password'}
                value={mossKey}
                onChange={(e) => setMossKey(e.target.value)}
                placeholder={mossConfigured ? '已保存，输入新 Key 覆盖' : '粘贴 Moss API Key'}
                className={`w-full ${inputClass} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowMossKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-app-text-tertiary hover:text-app-text-primary cursor-pointer"
                aria-label={showMossKey ? '隐藏密钥' : '显示密钥'}
              >
                {showMossKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <button
              type="button"
              onClick={handleSaveMossKey}
              disabled={!mossKey.trim() || mossSaving}
              className={`px-3 py-2 rounded-lg text-sm transition-colors flex-shrink-0 ${
                mossKey.trim() && !mossSaving
                  ? 'bg-app-status-info text-white hover:bg-app-status-info-deep cursor-pointer'
                  : 'bg-app-bg-hover text-app-text-tertiary cursor-not-allowed'
              }`}
            >
              {mossSaving ? '保存中…' : '保存'}
            </button>
            {mossConfigured && (
              <button
                type="button"
                onClick={handleClearMossKey}
                className="px-3 py-2 rounded-lg text-sm text-app-text-tertiary hover:text-red-400 hover:bg-app-bg-hover transition-colors cursor-pointer flex-shrink-0"
              >
                清除
              </button>
            )}
          </div>
        </div>
      </SettingGroup>

      <SettingGroup title="语音播报">
        <SettingRow
          title="自动语音播报"
          description="陪伴弹窗出现、聊天回复完成时自动朗读；新播报自动打断旧播报。"
        >
          <Toggle enabled={mossTtsEnabled} onToggle={handleToggleMossTts} />
        </SettingRow>

        <SettingRow title="音色 ID" description="Mossland 音色库卡片上点复制图标获取">
          <input
            type="text"
            value={mossVoiceId}
            onChange={(e) => setMossVoiceId(e.target.value)}
            placeholder="91d06f93-c5dc-52a8-92d6-335008306e95"
            className={`w-64 ${inputClass} font-mono`}
          />
          <button
            type="button"
            onClick={handleSaveMossVoiceId}
            className="px-3 py-2 rounded-lg text-sm bg-app-bg-hover text-app-text-secondary hover:text-app-text-primary transition-colors cursor-pointer"
          >
            保存
          </button>
        </SettingRow>

        <SettingRow title="播报语速" description="支持 0.25x ~ 4x 范围，对下一条播报即时生效">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.25}
              value={mossSpeed}
              onChange={(e) => handleMossSpeedChange(Number(e.target.value))}
              className="w-40"
              style={
                { '--range-fill': `${((mossSpeed - 0.25) / 3.75) * 100}%` } as CSSProperties
              }
              aria-label="播报语速"
              aria-valuetext={`${mossSpeed}x`}
            />
            <span className="range-readout w-10 text-xs text-app-text-secondary tabular-nums text-right transition-colors duration-150">
              {Number(mossSpeed.toFixed(2))}x
            </span>
          </div>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
