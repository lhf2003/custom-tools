import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';

/**
 * 插件载荷消费 hook：订阅本插件的待消费载荷，到达即「读后清除」并回调。
 * 覆盖两种时序：插件未挂载（挂载时 effect 消费）与已挂载（订阅触发）。
 * 载荷为 unknown，插件在回调里自己 narrow。
 */
export function usePluginPayload(id: string, onPayload: (payload: unknown) => void): void {
  const payload = useAppStore((s) => s.payloads[id]);

  useEffect(() => {
    if (payload === undefined) return;
    useAppStore.getState().consumePayload(id);
    onPayload(payload);
  }, [payload, id, onPayload]);
}
