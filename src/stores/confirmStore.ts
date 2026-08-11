import { create } from 'zustand';
import type { ReactNode } from 'react';

/**
 * 全局确认弹窗 store。
 *
 * 背景：Tauri 无边框透明窗口的 WebView2 中，原生 `window.confirm()` 不可用
 * （返回 falsy/抛错，点击后静默短路）。所有危险操作确认统一走这里，
 * 由 App 根渲染的 ConfirmDialogHost 呈现自定义弹窗，决策以 Promise 回传，
 * 调用方保持 `const ok = await confirmDialog(...)` 的直读语义。
 */
export interface ConfirmRequest {
  /** 弹窗标题（默认「操作确认」） */
  title?: string;
  /** 主内容（纯文本/JSX 均可，换行自动保留） */
  message: ReactNode;
  /** 次要说明（弱化字号显示，如「此操作不可恢复」） */
  detail?: ReactNode;
  /** 确认按钮文案（默认「确认」） */
  confirmLabel?: string;
  /** 取消按钮文案（默认「取消」） */
  cancelLabel?: string;
  /** 危险操作：确认按钮红色（删除/清空/重置/卸载类） */
  danger?: boolean;
}

type PendingRequest = ConfirmRequest & { resolve: (ok: boolean) => void };

interface ConfirmState {
  request: PendingRequest | null;
}

export const useConfirmStore = create<ConfirmState>(() => ({ request: null }));

/** 发起确认请求，返回用户决策（true = 确认） */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    // 同窗口同时只允许一个确认弹窗：新请求顶掉旧请求，旧请求视为取消
    useConfirmStore.getState().request?.resolve(false);
    useConfirmStore.setState({ request: { ...req, resolve } });
  });
}

/** 结算当前请求并关闭弹窗（确认/取消/ESC/遮罩点击统一入口） */
export function settleConfirm(result: boolean) {
  const { request } = useConfirmStore.getState();
  if (!request) return;
  request.resolve(result);
  useConfirmStore.setState({ request: null });
}
