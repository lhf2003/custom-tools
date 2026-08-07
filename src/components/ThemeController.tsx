import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

export type ResolvedTheme = 'dark' | 'light' | 'orange-sea';
export type ThemeFamily = 'dark' | 'light';

/** localStorage 缓存键：与 index.html / companion-toast.html 的防闪屏内联脚本共享 */
export const THEME_MODE_CACHE_KEY = 'flowhub-theme-mode';

/**
 * 主题注册表：具体主题 → 明暗族。新增主题在此登记一行，
 * 并把对应 token 块写进 index.css（[data-theme='<id>']）。
 * 浅色族的类级覆盖全部挂 [data-theme-family='light']，深色族主题零改动继承。
 * 注意：public/theme-bootstrap.js 的 FAMILY 映射（防闪屏预读）必须同步登记。
 */
const THEME_FAMILY: Record<string, ThemeFamily> = {
  dark: 'dark',
  light: 'light',
  'orange-sea': 'dark',
};
export { THEME_FAMILY };

/** 系统主题媒体查询（WebView2 原生支持 prefers-color-scheme） */
function systemQuery(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

/** 把用户配置的 theme 模式解析为具体主题 + 明暗族 */
function resolveTheme(mode: string): { theme: ResolvedTheme; family: ThemeFamily } {
  const family = THEME_FAMILY[mode];
  if (family) return { theme: mode as ResolvedTheme, family };
  const sys = systemQuery().matches ? 'dark' : 'light';
  return { theme: sys, family: sys };
}

/** 应用主题到 documentElement（data-theme 具体主题 + data-theme-family 明暗族） */
function applyTheme(mode: string): void {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved.theme;
  document.documentElement.dataset.themeFamily = resolved.family;
}

/**
 * 主题控制器（无渲染）：
 * - 启动时（loadSettings 完成后）应用已保存的主题，避免主题闪烁
 * - 应用的同时把模式写入 localStorage，供 index.html 内联脚本在下一次启动的
 *   React 挂载前预读，消除首帧闪屏
 * - theme=system 时监听系统主题变化实时跟随；固定模式移除监听
 */
export function ThemeController() {
  const theme = useSettingsStore((s) => s.theme);
  const isLoading = useSettingsStore((s) => s.isLoading);

  useEffect(() => {
    if (isLoading) return; // 等 loadSettings 完成后一次性应用，防止默认值闪烁
    applyTheme(theme);
    // 缓存模式供 theme-bootstrap.js 在下次启动的 React 挂载前预读，消除首帧闪屏。
    // localStorage 不可用时静默跳过（主题已生效，仅下次首帧无法预读）。
    try {
      localStorage.setItem(THEME_MODE_CACHE_KEY, theme);
    } catch (e) {
      /* 隐私模式等场景忽略 */
    }

    if (theme !== 'system') return;
    const mq = systemQuery();
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, isLoading]);

  return null;
}
