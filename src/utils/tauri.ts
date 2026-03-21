import { invoke } from '@tauri-apps/api/core';

/**
 * Unified error type for Tauri command invocations.
 * Tauri backend errors are serialized as strings or structured objects.
 */
export type TauriError = string | { message: string; [key: string]: unknown };

/**
 * Detect whether the app is running inside a Tauri shell.
 * In plain browser dev mode, `window.__TAURI__` is undefined.
 */
function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined
  );
}

/**
 * Safely invoke a Tauri backend command.
 *
 * - In the Tauri environment: calls the backend command and returns the result.
 * - In a plain browser (dev mode): logs the attempted call and returns `null`.
 * - On error: logs the error via `console.error` and returns `null`.
 *
 * @param command - The Tauri command name to invoke.
 * @param args    - Optional key/value arguments forwarded to the command.
 * @returns The command result typed as `T`, or `null` on failure / outside Tauri.
 */
export async function safeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauriEnv()) {
    console.log(`[Browser Mode] Would invoke: ${command}`, args);
    return null;
  }

  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.error(`[safeInvoke] Command "${command}" failed:`, error);
    return null;
  }
}

// --- Debounced window resize ---
// 防止频繁视图切换时多个并发 SetWindowPos 导致 DWM Acrylic 合成层与
// WebView2 内容层脱节，出现全屏 Acrylic 而无实际内容的渲染 bug。
// 只保留最后一次 resize 请求，60ms 后执行。
let _resizeTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingHeight: number | null = null;
let _pendingWidth: number | null = null;

export function debouncedResize(height: number, width?: number): void {
  _pendingHeight = height;
  _pendingWidth = width ?? null;

  if (_resizeTimer !== null) {
    clearTimeout(_resizeTimer);
  }

  _resizeTimer = setTimeout(async () => {
    _resizeTimer = null;
    const h = _pendingHeight;
    const w = _pendingWidth;
    _pendingHeight = null;
    _pendingWidth = null;

    if (h === null) return;

    const args: Record<string, unknown> = { height: h };
    if (w !== null) args.width = w;
    await safeInvoke('resize_window', args);
  }, 60);
}
