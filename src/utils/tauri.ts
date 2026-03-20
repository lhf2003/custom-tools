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
