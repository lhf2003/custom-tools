// A2uiSurface 容器：从持久化负载重建 surface，持有双向绑定的本地数据模型，
// 提供渲染上下文；event 型按钮 action 组装成「用户操作」消息回传给聊天链路，
// invoke 型 action 直接调用 Tauri command（绕过 LLM，白名单由后端校验）。

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatActionMessage } from './action';
import { resolveDynamic } from './functions';
import { resolvePointer, setPointerImmutable } from './pointer';
import { A2uiContext, RenderComponent } from './render';
import { buildSurface } from './surface';
import { useToastStore } from '@/stores/toastStore';
import type { SurfacePayload } from './types';

interface A2uiSurfaceProps {
  /** chat_messages(content_type='a2ui') 的 content（SurfacePayload JSON） */
  payloadJson: string;
  /** action 回传：组装好的用户操作文本，走正常发送链路 */
  onAction: (text: string) => void;
}

export function A2uiSurface({ payloadJson, onAction }: A2uiSurfaceProps) {
  const { addToast } = useToastStore();
  const surface = useMemo(() => {
    try {
      return buildSurface(JSON.parse(payloadJson) as SurfacePayload);
    } catch (e) {
      console.error('[a2ui] 无法解析 surface 负载:', e);
      return null;
    }
  }, [payloadJson]);

  // 本地数据模型：双向绑定的真值源。初始为服务端数据模型
  const [data, setData] = useState<unknown>(surface?.dataModel);
  // 增量更新（同一 surface 追加消息）时以服务端数据重建——
  // 取舍：未提交的表单编辑会被重置；增量更新通常紧随创建，用户还来不及填
  useEffect(() => {
    setData(surface?.dataModel);
  }, [surface]);

  if (!surface || !surface.created || surface.deleted || !surface.components.root) {
    return null;
  }

  const ctxValue = {
    surface,
    data,
    setValue: (absPath: string, value: unknown) =>
      setData((prev: unknown) => setPointerImmutable(prev, absPath, value)),
    dispatchAction: (name: string, contextSpec?: Record<string, unknown>, label?: string) => {
      const evalCtx = { resolvePath: (p: string) => resolvePointer(data, p) };
      const resolved: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(contextSpec ?? {})) {
        resolved[k] = resolveDynamic(spec, evalCtx);
      }
      onAction(formatActionMessage(label, name, resolved, data, surface.sendDataModel));
    },
    dispatchInvoke: (command: string, args?: Record<string, unknown>) =>
      invoke(command, args).catch((err: unknown) => {
        // invoke 型 action 绕过 LLM 语义层，失败没有回传通道——toast 兜底反馈
        addToast({
          type: 'error',
          title: '操作失败',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }),
  };

  return (
    <A2uiContext.Provider value={ctxValue}>
      <div className="text-sm" data-surface-id={surface.surfaceId}>
        <RenderComponent id="root" />
      </div>
    </A2uiContext.Provider>
  );
}
