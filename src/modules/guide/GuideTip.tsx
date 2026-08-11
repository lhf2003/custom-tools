import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GuideTipDef } from './types';

const TIP_WIDTH = 264;
const GAP = 10;
const EDGE = 12;
/** 箭头不出现在气泡圆角覆盖区 */
const ARROW_INSET = 24;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

interface GuideTipProps {
  def: GuideTipDef;
  anchorRect: DOMRect;
  onDismiss: () => void;
}

interface TipPosition {
  top: number;
  left: number;
  /** 箭头中心相对气泡左缘的距离 */
  arrowLeft: number;
  placement: 'top' | 'bottom';
}

/**
 * 锚定引导气泡：panel 家族（Elevated 底 + 12px 圆角 + Elevated 阴影 + 白纱描边），
 * 非模态、无遮罩、不挡操作。先隐身测量再定位显示，避免首帧跳位。
 */
export function GuideTip({ def, anchorRect, onDismiss }: GuideTipProps) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<TipPosition | null>(null);
  const [shown, setShown] = useState(false);

  // 绘制前同步定位：空间不足时翻转方位，仍不足则钳在可视区内
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const preferred = def.placement ?? 'bottom';

    let placement = preferred;
    let top = preferred === 'bottom' ? anchorRect.bottom + GAP : anchorRect.top - h - GAP;
    if (preferred === 'bottom' && top + h > window.innerHeight - EDGE && anchorRect.top - h - GAP >= EDGE) {
      placement = 'top';
      top = anchorRect.top - h - GAP;
    } else if (preferred === 'top' && top < EDGE && anchorRect.bottom + GAP + h <= window.innerHeight - EDGE) {
      placement = 'bottom';
      top = anchorRect.bottom + GAP;
    }
    top = clamp(top, EDGE, window.innerHeight - h - EDGE);

    const centerX = anchorRect.left + anchorRect.width / 2;
    const left = clamp(centerX - TIP_WIDTH / 2, EDGE, window.innerWidth - TIP_WIDTH - EDGE);
    const arrowLeft = clamp(centerX - left, ARROW_INSET, TIP_WIDTH - ARROW_INSET);

    setPos({ top, left, arrowLeft, placement });
  }, [def, anchorRect]);

  // 定位完成后下一帧取消隐藏，transition 播放入场（不依赖 tailwindcss-animate，项目未装）
  useEffect(() => {
    if (!pos) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [pos]);

  // Esc 关闭（capture 拦截，避免 App 级 Esc 切视图/隐藏窗口）；点气泡外任意处关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (tipRef.current && !tipRef.current.contains(e.target as Node)) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onDismiss]);

  const placement = pos?.placement ?? def.placement ?? 'bottom';
  // 气泡从锚点一侧「长出来」：bottom 放置自上方 4px 浮入，top 放置反之
  const hiddenOffset = placement === 'bottom' ? '-translate-y-1' : 'translate-y-1';

  return (
    <div
      ref={tipRef}
      role="status"
      aria-live="polite"
      className={`fixed z-[80] w-[264px] rounded-xl border border-app-border-subtle bg-app-bg-elevated shadow-lg transition-all duration-200 ease-out motion-reduce:transition-none ${
        pos && shown ? 'opacity-100 translate-y-0' : `opacity-0 ${pos ? hiddenOffset : ''}`
      }`}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
    >
      {/* 锚点箭头：同底色旋转方块，只露指向侧两条边 */}
      {pos && (
        <span
          aria-hidden
          className={`absolute w-3 h-3 rotate-45 bg-app-bg-elevated border-app-border-subtle ${
            pos.placement === 'bottom' ? '-top-[6px] border-l border-t' : '-bottom-[6px] border-b border-r'
          }`}
          style={{ left: pos.arrowLeft - 6 }}
        />
      )}

      <div className="px-3.5 pt-3 pb-2.5">
        <h3 className="text-sm font-medium text-app-text-primary">{def.title}</h3>
        <p className="mt-1 text-xs text-app-text-secondary leading-relaxed">{def.body}</p>

        {def.keyHints && def.keyHints.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {def.keyHints.map((hint) => (
              <div key={hint.combo} className="flex items-center gap-2">
                <kbd className="px-1.5 py-0.5 rounded border border-app-border-subtle bg-app-bg-primary/60 text-[10px] font-mono font-semibold text-app-text-secondary leading-tight flex-shrink-0 whitespace-nowrap">
                  {hint.combo}
                </kbd>
                <span className="text-xs text-app-text-tertiary">{hint.label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="px-2.5 py-1 rounded-md text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-app-brand-primary/60"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
