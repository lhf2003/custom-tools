import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

export type ResolvedTheme = 'dark' | 'light';

/** localStorage 缓存键：与 index.html 的防闪屏内联脚本共享 */
export const THEME_MODE_CACHE_KEY = 'flowhub-theme-mode';

/** 系统主题媒体查询（WebView2 原生支持 prefers-color-scheme） */
function systemQuery(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

/** 把用户配置的 theme 模式解析为实际应用的主题 */
function resolveTheme(mode: string): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemQuery().matches ? 'dark' : 'light';
}

/**
 * 主题控制器（无渲染）：
 * - 启动时（loadSettings 完成后）应用已保存的主题，避免主题闪烁
 * - theme=system 时监听系统主题变化实时跟随；深/浅固定模式移除监听
 */
export function ThemeController() {
  const theme = useSettingsStore((s) => s.theme);
  const isLoading = useSettingsStore((s) => s.isLoading);

  useEffect(() => {
    if (isLoading) return; // 等 loadSettings 完成后一次性应用，防止默认值闪烁
    document.documentElement.dataset.theme = resolveTheme(theme);
    // 缓存模式供 index.html 内联脚本在下次启动的 React 挂载前预读，消除首帧闪屏
    localStorage.setItem(THEME_MODE_CACHE_KEY, theme);

    if (theme !== 'system') return;
    const mq = systemQuery();
    const onChange = () => {
      document.documentElement.dataset.theme = resolveTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, isLoading]);

  return null;
}
