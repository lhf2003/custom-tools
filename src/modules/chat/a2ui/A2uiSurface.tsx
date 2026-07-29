// A2uiSurface 容器：从持久化负载重建 surface，持有双向绑定的本地数据模型，
// 提供渲染上下文；按钮 action 组装成「用户操作」消息回传给聊天链路。

import { useEffect, useMemo, useState } from 'react';
import { resolveDynamic } from './functions';
import { resolvePointer, setPointerImmutable } from './pointer';
import { A2uiContext, RenderComponent } from './render';
import { buildSurface } from './surface';
import type { SurfacePayload } from './types';

interface A2uiSurfaceProps {
  /** chat_messages(content_type='a2ui') 的 content（SurfacePayload JSON） */
  payloadJson: string;
  /** action 回传：组装好的用户操作文本，走正常发送链路 */
  onAction: (text: string) => void;
}

export function A2uiSurface({ payloadJson, onAction }: A2uiSurfaceProps) {
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
      const lines = [`用户操作：点击了「${label ?? name}」(action: ${name})`];
      if (Object.keys(resolved).length > 0) {
        lines.push(`上下文：${JSON.stringify(resolved, null, 2)}`);
      }
      if (surface.sendDataModel) {
        lines.push(`界面当前数据：${JSON.stringify(data, null, 2)}`);
      }
      onAction(lines.join('\n'));
    },
  };

  return (
    <A2uiContext.Provider value={ctxValue}>
      <div className="text-sm" data-surface-id={surface.surfaceId}>
        <RenderComponent id="root" />
      </div>
    </A2uiContext.Provider>
  );
}
