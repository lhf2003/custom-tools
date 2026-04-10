import { useState, useRef, useEffect } from 'react';

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
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsMounted(true);
      // Small delay to allow mount before transition
      requestAnimationFrame(() => setIsVisible(true));
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsVisible(false);
    // Wait for transition to finish before unmounting
    setTimeout(() => setIsMounted(false), 150);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const placementClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {isMounted && (
        <div
          className={`absolute z-50 pointer-events-none ${placementClasses[placement]}`}
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
      )}
    </div>
  );
}
