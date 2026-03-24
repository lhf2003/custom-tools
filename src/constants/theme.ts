/**
 * Application-wide theme color constants.
 *
 * These values appear as inline styles or Tailwind arbitrary-value classes
 * across ClipboardView, PasswordView, MarkdownView, SettingsView,
 * EverythingView, and LauncherView.  Centralising them here ensures a
 * single source of truth and makes future theme changes straightforward.
 */
export const THEME = {
  /** Primary background used by every main view container - 使用半透明颜色支持毛玻璃效果 */
  BG_PRIMARY: 'rgba(51, 51, 51, 0.75)',
  /** Secondary background used by sidebars, cards, and modals - 半透明 */
  BG_SECONDARY: 'rgba(42, 42, 42, 0.75)',
  /** Tertiary background used by panels, category sidebars, and detail panes - 半透明 */
  BG_TERTIARY: 'rgba(45, 45, 45, 0.75)',
  /** Default background for secondary/ghost action buttons */
  BTN_BG: '#3a3a3a',
  /** Hover background for secondary/ghost action buttons */
  BTN_BG_HOVER: '#444444',
} as const;
