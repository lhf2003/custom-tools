/**
 * 防主题闪屏引导脚本（index.html / companion-toast.html 共享）
 *
 * React 挂载前在 <head> 同步执行：预读 localStorage 缓存的主题模式，
 * 解析为 data-theme（具体主题）+ data-theme-family（明暗族），消除首帧闪屏。
 *
 * 维护注意：FAMILY 映射与 THEME_MODE_CACHE_KEY 必须与
 * src/components/ThemeController.tsx 的 THEME_FAMILY / THEME_MODE_CACHE_KEY 保持同步——
 * 新增主题时两处都要登记（另见记忆 palette-token-sync-points 的四处清单）。
 * localStorage 不可用时静默回退 system 行为。
 */
(function () {
  try {
    var FAMILY = { dark: 'dark', light: 'light', 'orange-sea': 'dark' };
    var mode = localStorage.getItem('flowhub-theme-mode') || 'system';
    var family = FAMILY[mode];
    var theme = mode;
    if (!family) {
      family = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      theme = family;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeFamily = family;
  } catch (e) {
    /* localStorage 不可用时保持默认深色，由 ThemeController 兜底 */
  }
})();
