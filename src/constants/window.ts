/**
 * Window size constants for every view that calls `resize_window`.
 */
export const WINDOW_SIZE = {
  LAUNCHER: {
    /** Height when the launcher grid is collapsed (default). */
    collapsed: 210,
    /** Height when the launcher grid is expanded to show all recent apps. */
    expanded: 600,
    /** Default width for the launcher view (matches resize_window backend default). */
    width: 820,
  },
  /** Unified dimensions for all tool views - consistent visual experience */
  CLIPBOARD: {
    height: 600,
    width: 820,
  },
  PASSWORD: {
    height: 600,
    width: 820,
  },
  SETTINGS: {
    height: 600,
    width: 820,
  },
  EVERYTHING: {
    height: 600,
    width: 820,
  },
  MARKDOWN: {
    height: 600,
    width: 820,
  },
  JSON_FORMATTER: {
    height: 600,
    width: 820,
  },
  CHAT: {
    /** Height when only the input box is visible. */
    collapsed: 62,
    /** Height when a response is displayed below the input. */
    expanded: 600,
    /** Default width for the chat view. */
    width: 820,
  },
} as const;
