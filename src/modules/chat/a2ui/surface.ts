// Surface 状态构建：把 A2UI 消息数组应用成组件表 + 数据模型（纯函数，不可变更新）。

import { setPointerImmutable } from './pointer';
import type { A2uiMessage, SurfacePayload, SurfaceState } from './types';

export function emptySurface(surfaceId: string): SurfaceState {
  return {
    surfaceId,
    created: false,
    deleted: false,
    sendDataModel: false,
    components: {},
    dataModel: undefined,
  };
}

/** 应用一批消息到 surface（返回新状态）。消息结构后端已校验，这里宽容应用 */
export function applyMessages(state: SurfaceState, messages: A2uiMessage[]): SurfaceState {
  let next = state;
  for (const msg of messages) {
    if (msg.createSurface) {
      next = {
        ...next,
        created: true,
        deleted: false,
        theme: msg.createSurface.theme,
        sendDataModel: msg.createSurface.sendDataModel ?? false,
      };
    } else if (msg.updateComponents) {
      const components = { ...next.components };
      for (const c of msg.updateComponents.components) {
        components[c.id] = c;
      }
      next = { ...next, components };
    } else if (msg.updateDataModel) {
      const { path, value } = msg.updateDataModel;
      next = {
        ...next,
        dataModel:
          path === undefined || path === '' || path === '/'
            ? value
            : setPointerImmutable(next.dataModel, path, value),
      };
    } else if (msg.deleteSurface) {
      next = { ...next, deleted: true };
    }
  }
  return next;
}

/** 从持久化负载（可能含多次 render_ui 的合并消息）重建 surface */
export function buildSurface(payload: SurfacePayload): SurfaceState {
  return applyMessages(emptySurface(payload.surfaceId), payload.messages);
}
