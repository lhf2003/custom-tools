import { useState, useRef, useEffect, useCallback } from 'react';
import { Portal } from './Portal';

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({
  children,
  content,
  placement = 'bottom',
  delay = 200,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipWidth = 100; // 预估宽度
    const tooltipHeight = 32; // 预估高度
    const offset = 8;
    const padding = 8; // 视口边距

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

    // 边界检测：顶部空间不足时自动切换到底部
    if (placement === 'top' && y - tooltipHeight < 0) {
      y = rect.bottom + offset;
    }

    // 边界检测：左侧空间不足时，调整 x 坐标
    const halfWidth = tooltipWidth / 2;
    if (placement === 'top' || placement === 'bottom') {
      if (x - halfWidth < padding) {
        x = padding + halfWidth; // 确保不超出左边界
      }
    }

    setPosition({ x, y });
  }, [placement]);

  const showTooltip = () => {
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

  // 滚动或窗口大小变化时重新计算位置
  useEffect(() => {
    if (!isMounted) return;

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
        className="inline-flex"
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </div>
      {isMounted && (
        <Portal>
          <div
            className={`fixed z-[9999] pointer-events-none ${placementClasses[placement]}`}
            style={fixedPositionStyles[placement]}
          >
            <div
              className={`
                tooltip-base
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
