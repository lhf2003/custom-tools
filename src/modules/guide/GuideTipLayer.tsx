import { useCallback, useEffect, useState } from 'react';
import { useGuideStore } from './store';
import { GuideTip } from './GuideTip';

/** 进入视图后等视图稳定再展示气泡 */
const SHOW_DELAY_MS = 400;

/**
 * 气泡调度层：订阅 store 的 activeTip，延迟定位锚点后渲染 GuideTip。
 * 锚点缺失（视图改版失配）时静默写已读，避免每次进入视图都白找一次。
 */
export function GuideTipLayer() {
  const activeTip = useGuideStore((s) => s.activeTip);
  const dismissActiveTip = useGuideStore((s) => s.dismissActiveTip);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!activeTip) {
      setAnchorRect(null);
      return;
    }
    const timer = setTimeout(() => {
      const el = document.querySelector(activeTip.anchor);
      if (!el) {
        console.warn(`[guide] 锚点「${activeTip.anchor}」不存在，提示 ${activeTip.id} 静默已读`);
        void dismissActiveTip(true);
        return;
      }
      setAnchorRect(el.getBoundingClientRect());
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [activeTip, dismissActiveTip]);

  // 窗口尺寸变化（部分视图会 resize 窗口）时重算锚点位置
  useEffect(() => {
    if (!activeTip) return;
    const remeasure = () => {
      const el = document.querySelector(activeTip.anchor);
      if (el) setAnchorRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [activeTip]);

  const handleDismiss = useCallback(() => {
    void dismissActiveTip(true);
  }, [dismissActiveTip]);

  if (!activeTip || !anchorRect) return null;
  return <GuideTip def={activeTip} anchorRect={anchorRect} onDismiss={handleDismiss} />;
}
