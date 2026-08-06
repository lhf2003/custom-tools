import { PageHeader } from '../components/SettingsPrimitives';

/** 主题预览缩略窗：titlebar 三点 + 侧栏 + 内容行的抽象示意 */
function ThemeMiniPreview({ variant }: { variant: 'dark' | 'light' }) {
  const isDark = variant === 'dark';
  return (
    <div
      className={`w-[200px] rounded-[10px] overflow-hidden border ${
        isDark ? 'border-white/10 bg-app-bg-primary' : 'border-black/10 bg-[#ececee]'
      }`}
    >
      <div className={`h-4 flex items-center gap-[3px] px-1.5 ${isDark ? 'bg-app-bg-secondary' : 'bg-[#dcdce0]'}`}>
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
        <span className="w-[5px] h-[5px] rounded-full bg-white/10" />
      </div>
      <div className="p-2 flex gap-1.5">
        <div className={`w-[38px] h-[52px] rounded ${isDark ? 'bg-app-bg-secondary' : 'bg-[#dcdce0]'}`} />
        <div className="flex-1 flex flex-col gap-[5px]">
          <div className={`h-[7px] rounded-sm w-[70%] ${isDark ? 'bg-app-bg-elevated' : 'bg-[#c6c6cc]'}`} />
          <div className={`h-[7px] rounded-sm ${isDark ? 'bg-app-bg-elevated' : 'bg-[#c6c6cc]'}`} />
          <div className={`h-[7px] rounded-sm w-[55%] ${isDark ? 'bg-app-bg-elevated' : 'bg-[#c6c6cc]'}`} />
          <div className={`h-[7px] rounded-sm w-[80%] ${isDark ? 'bg-app-bg-elevated' : 'bg-[#c6c6cc]'}`} />
        </div>
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  return (
    <>
      <PageHeader title="外观" description="主题、字体与窗口材质" />

      <div className="flex gap-5 mb-5 px-3">
        <div>
          <ThemeMiniPreview variant="dark" />
          <div className="flex items-center gap-2 pt-2 text-xs text-app-text-tertiary">
            深色
            <span className="text-[10px] font-semibold text-app-status-success">当前</span>
          </div>
        </div>
        <div className="opacity-50 cursor-not-allowed" aria-disabled>
          <ThemeMiniPreview variant="light" />
          <div className="flex items-center gap-2 pt-2 text-xs text-app-text-tertiary">
            浅色
            <span className="text-[10px] font-semibold text-app-status-warning bg-app-status-warning/10 px-1.5 py-0.5 rounded">
              即将推出
            </span>
          </div>
        </div>
      </div>

      <p className="px-3 text-xs text-app-text-tertiary leading-relaxed flex items-start gap-2">
        <span className="text-[10px] font-semibold text-app-status-warning bg-app-status-warning/10 px-1.5 py-0.5 rounded flex-shrink-0 mt-px">
          即将推出
        </span>
        主题切换、字体与窗口材质（Mica / Acrylic）配置正在规划中，将随后续版本提供。
      </p>
    </>
  );
}
