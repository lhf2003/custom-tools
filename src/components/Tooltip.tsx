import { useState, useRef, useEffect, useCallback } from 'react';
import { Portal } from './Portal';

interface TooltipProps {
  children: React.ReactNode;
  /** 提示内容；空字符串 / undefined / null 时不触发也不渲染（对齐原生 title 的条件用法） */
  content?: string | null;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  /** 包裹层布局类透传。默认 inline-flex 适合行内场景；块级/flex 上下文调用方需自行传入（如 w-full / flex-1 min-w-0 / shrink-0） */
  wrapperClassName?: string;
}

export function Tooltip({
  children,
  content,
  placement = 'bottom',
  delay = 200,
  wrapperClassName = 'inline-flex',
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    // 已挂载时用真实尺寸测量，未挂载时回退到预估尺寸
    const measured = tooltipRef.current?.getBoundingClientRect();
    const tooltipWidth = measured?.width ?? 100;
    const tooltipHeight = measured?.height ?? 32;
    const offset = 8;
    const padding = 8; // 视口边距
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = 0;
    let y = 0;

    switch (placement) {
      case 'top':
        x = rect.left + rect.width / 2;
        y = rect.top - offset;
        break;
      case 'bottom':
        x = rect.left + rect.width / 2;
        y = rect.bottom + offset;
        break;
      case 'left':
        x = rect.left - offset;
        y = rect.top + rect.height / 2;
        break;
      case 'right':
        x = rect.right + offset;
        y = rect.top + rect.height / 2;
        break;
    }

    // 垂直边界检测：空间不足时切换到对侧（锚点按对侧定位公式换算）
    if (placement === 'top' && y - tooltipHeight < 0) {
      y = rect.bottom + offset + tooltipHeight;
    } else if (placement === 'bottom' && y + tooltipHeight > viewportHeight - padding) {
      y = rect.top - offset - tooltipHeight;
    }

    // 水平边界检测：空间不足时切换到对侧（锚点按对侧定位公式换算）
    if (placement === 'left' && x - tooltipWidth < 0) {
      x = rect.right + offset + tooltipWidth;
    } else if (placement === 'right' && x + tooltipWidth > viewportWidth - padding) {
      x = rect.left - offset - tooltipWidth;
    }

    // 顶部/底部方向：水平居中并 clamp 在视口内
    const halfWidth = tooltipWidth / 2;
    if (placement === 'top' || placement === 'bottom') {
      if (x - halfWidth < padding) {
        x = padding + halfWidth; // 确保不超出左边界
      } else if (x + halfWidth > viewportWidth - padding) {
        x = viewportWidth - padding - halfWidth; // 确保不超出右边界
      }
    }

    // 左侧/右侧方向：垂直居中并 clamp 在视口内
    const halfHeight = tooltipHeight / 2;
    if (placement === 'left' || placement === 'right') {
      if (y - halfHeight < padding) {
        y = padding + halfHeight; // 确保不超出上边界
      } else if (y + halfHeight > viewportHeight - padding) {
        y = viewportHeight - padding - halfHeight; // 确保不超出下边界
      }
    }

    setPosition({ x, y });
  }, [placement]);

  const showTooltip = () => {
    if (!content) return;
    calculatePosition();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsMounted(true);
      requestAnimationFrame(() => setIsVisible(true));
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsVisible(false);
    setTimeout(() => setIsMounted(false), 150);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // content 动态变为空时，隐藏已显示的 tooltip
  useEffect(() => {
    if (!content) hideTooltip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // 滚动或窗口大小变化时重新计算位置；挂载后基于真实尺寸重算一次
  useEffect(() => {
    if (!isMounted) return;

    calculatePosition();

    const handleUpdate = () => calculatePosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);

    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isMounted, calculatePosition]);

  const placementClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const fixedPositionStyles = {
    top: {
      left: position.x,
      top: position.y,
      transform: 'translate(-50%, -100%)',
    },
    bottom: {
      left: position.x,
      top: position.y,
      transform: 'translate(-50%, 0)',
    },
    left: {
      left: position.x,
      top: position.y,
      transform: 'translate(-100%, -50%)',
    },
    right: {
      left: position.x,
      top: position.y,
      transform: 'translate(0, -50%)',
    },
  };

  return (
    <>
      <div
        ref={triggerRef}
        className={wrapperClassName}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </div>
      {isMounted && content && (
        <Portal>
          <div
            className={`fixed z-[9999] pointer-events-none ${placementClasses[placement]}`}
            style={fixedPositionStyles[placement]}
          >
            <div
              ref={tooltipRef}
              className={`
                tooltip-base
                max-w-[min(80vw,26rem)] whitespace-normal
                transition-all duration-150 ease-out
                ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}
              `}
            >
              {content}
              {/* Arrow */}
              <span
                className={`
                  tooltip-arrow
                  ${placement === 'top' && 'tooltip-arrow-top'}
                  ${placement === 'bottom' && 'tooltip-arrow-bottom'}
                  ${placement === 'left' && 'tooltip-arrow-left'}
                  ${placement === 'right' && 'tooltip-arrow-right'}
                `}
              />
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
