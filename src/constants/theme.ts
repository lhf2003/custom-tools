/**
 * Application-wide theme color constants.
 *
 * These values appear as inline styles or Tailwind arbitrary-value classes
 * across ClipboardView, PasswordView, MarkdownView, SettingsView,
 * EverythingView, and LauncherView.  Centralising them here ensures a
 * single source of truth and makes future theme changes straightforward.
 */
export const THEME = {
  /** Primary background used by every main view container */
  BG_PRIMARY: '#333333',
  /** Secondary background used by sidebars, cards, and modals */
  BG_SECONDARY: '#2a2a2a',
  /** Tertiary background used by panels, category sidebars, and detail panes */
  BG_TERTIARY: '#2d2d2d',
  /** Default background for secondary/ghost action buttons */
  BTN_BG: '#3a3a3a',
  /** Hover background for secondary/ghost action buttons */
  BTN_BG_HOVER: '#444444',
} as const;
