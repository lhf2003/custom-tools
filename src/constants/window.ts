/**
 * Window size constants for every view that calls `resize_window`.
 *
 * Sources:
 *   LauncherView  – height toggles between 200 (collapsed) and 600 (expanded)
 *   ClipboardView – height: 500   (invoke call on mount)
 *   PasswordView  – height: 550, width: 920
 *   SettingsView  – height: 500   (FIXED_HEIGHT local constant)
 *   EverythingView– height: 500   (invoke call on mount)
 *   MarkdownView  – height: 600   (MARKDOWN_WINDOW_HEIGHT in module constants)
 *   JsonFormatter – height: 560
 */
export const WINDOW_SIZE = {
  LAUNCHER: {
    /** Height when the launcher grid is collapsed (default). */
    collapsed: 200,
    /** Height when the launcher grid is expanded to show all recent apps. */
    expanded: 600,
  },
  CLIPBOARD: {
    height: 500,
  },
  PASSWORD: {
    height: 550,
    width: 920,
  },
  SETTINGS: {
    height: 500,
  },
  EVERYTHING: {
    height: 500,
  },
  MARKDOWN: {
    height: 600,
  },
  JSON_FORMATTER: {
    height: 560,
  },
  CHAT: {
    /** Height when only the input box is visible (collapsed). */
    collapsed: 160,
    /** Height when a response is displayed (expanded). */
    expanded: 560,
  },
} as const;
