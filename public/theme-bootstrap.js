/**
 * 防主题闪屏引导脚本（index.html / companion-toast.html / translate-toast.html 共享）
 *
 * React 挂载前在 <head> 同步执行：预读 localStorage 缓存的主题模式，
 * 解析为 data-theme（具体主题）+ data-theme-family（明暗族），消除首帧闪屏。
 *
 * 维护注意：FAMILY 映射、THEME_MODE_CACHE_KEY、PANEL_ALPHA_CACHE_KEY 必须与
 * src/components/ThemeController.tsx 的 THEME_FAMILY / THEME_MODE_CACHE_KEY /
 * PANEL_ALPHA_CACHE_KEY 保持同步——新增主题时两处都要登记
 * （另见记忆 palette-token-sync-points 的清单）。
 * localStorage 不可用时静默回退 system 行为。
 */
(function () {
  var FAMILY = { dark: 'dark', light: 'light', 'orange-sea': 'dark' };
  var THEME_KEY = 'flowhub-theme-mode';
  var ALPHA_KEY = 'flowhub-panel-alpha';
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function applyThemeMode(mode) {
    var family = FAMILY[mode];
    var theme = mode;
    if (!family) {
      family = mq.matches ? 'dark' : 'light';
      theme = family;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeFamily = family;
  }

  function applyAlpha(raw) {
    // 缺省/非法/越界则不写，交给 CSS 默认 0.72 与 ThemeController 兜底
    // （合法区间同 Rust clamp 0.4~1.0）
    var alpha = parseFloat(raw);
    if (alpha >= 0.4 && alpha <= 1) {
      document.documentElement.style.setProperty('--app-panel-alpha', alpha.toFixed(2));
    }
  }

  try {
    applyThemeMode(localStorage.getItem(THEME_KEY) || 'system');

    // 面板背景不透明度预读：消除非默认值的首帧透明度闪变（ThemeController 应用时缓存）
    applyAlpha(localStorage.getItem(ALPHA_KEY));
  } catch (e) {
    /* localStorage 不可用时保持默认深色，由 ThemeController 兜底 */
  }

  // 跨窗口实时跟随：主窗口 ThemeController 应用主题/透明度时写 localStorage，
  // 同 origin 其余窗口（toast 浮窗等常驻页面）经 storage 事件同步（写入方自身不触发）。
  window.addEventListener('storage', function (e) {
    try {
      if (e.key === THEME_KEY) applyThemeMode(e.newValue || 'system');
      else if (e.key === ALPHA_KEY) applyAlpha(e.newValue);
    } catch (err) {
      /* 忽略 */
    }
  });

  // system 模式下系统主题翻转：主窗口不写 localStorage（模式值未变），各窗口自行跟随
  mq.addEventListener('change', function () {
    try {
      if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyThemeMode('system');
    } catch (e) {
      /* 忽略 */
    }
  });
})();
