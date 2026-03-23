import { useState } from 'react';
import { Palette } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingCard } from '../components/SettingCard';

const THEME_LABEL_MAP: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

const THEME_VALUE_MAP: Record<string, string> = {
  '浅色': 'light',
  '深色': 'dark',
  '跟随系统': 'system',
};

export function AppearanceSettings() {
  const { theme, window_opacity, setSetting } = useSettingsStore();
  const activeTheme = THEME_LABEL_MAP[theme] ?? '跟随系统';

  const handleThemeChange = (label: string) => {
    setSetting('theme', THEME_VALUE_MAP[label] ?? 'system');
  };

  const opacityPercent = Math.round(window_opacity * 100);
  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSetting('window_opacity', parseInt(e.target.value, 10) / 100);
  };

  // TODO: 连接到 settingsStore 持久化（store 暂无 window_border_radius 字段）
  const [borderRadius, setBorderRadius] = useState(16);

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/30 to-purple-600/20 flex items-center justify-center">
          <Palette size={20} className="text-purple-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">外观设置</h2>
          <p className="text-white/40 text-xs">个性化您的界面</p>
        </div>
        <span className="ml-auto px-2 py-1 text-[11px] text-white/60 bg-white/10 rounded-md border border-white/10">
          敬请期待
        </span>
      </div>

      <div className="space-y-3">
        <SettingCard title="主题" description="选择您喜欢的界面风格">
          <div className="flex gap-2">
            {['浅色', '深色', '跟随系统'].map((label) => (
              <button
                key={label}
                onClick={() => handleThemeChange(label)}
                className={`px-4 py-2 rounded-lg text-sm transition-all duration-200 cursor-pointer ${
                  activeTheme === label
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                    : 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingCard>

        <SettingCard title="窗口透明度" description="调整窗口背景透明程度">
          <div className="flex items-center gap-3">
            <span className="text-white/40 text-xs">0%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={opacityPercent}
              onChange={handleOpacityChange}
              className="w-32 accent-blue-500 cursor-pointer"
            />
            <span className="text-white/40 text-xs">100%</span>
          </div>
        </SettingCard>

        <SettingCard title="窗口圆角" description="调整窗口边框圆角大小">
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-3 opacity-40">
              <span className="text-white/40 text-xs">0px</span>
              <input
                type="range"
                min="0"
                max="24"
                value={borderRadius}
                onChange={(e) => setBorderRadius(parseInt(e.target.value, 10))}
                className="w-32 accent-blue-500 cursor-not-allowed"
                disabled
              />
              <span className="text-white/40 text-xs">24px</span>
            </div>
            <span className="text-white/30 text-xs">暂未开放</span>
          </div>
        </SettingCard>
      </div>
    </>
  );
}
