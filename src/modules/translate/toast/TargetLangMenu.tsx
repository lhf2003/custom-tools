import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import { TARGET_LANG_OPTIONS } from '../constants';

interface TargetLangMenuProps {
  value: string;
  onChange: (lang: string) => void;
}

/**
 * 浮窗标题栏的目标语言切换：触发器沿用原「译成XX」标签尺寸（浮窗 10px 字号体系），
 * 菜单 portal 到 body + fixed 定位——浮窗根容器 overflow-hidden，absolute 菜单会被裁剪。
 */
export function TargetLangMenu({ value, onChange }: TargetLangMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ right: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // 右缘对齐触发器（触发器贴近窗口右缘，菜单向左展开）
      setMenuPos({ right: window.innerWidth - rect.right, top: rect.bottom + 4 });
    }
    setIsOpen(true);
  };

  // 点击触发器/菜单之外关闭（菜单 portal 在 body 下，需单独判定）
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen]);

  // 菜单打开时 Esc 只关菜单：capture 阶段拦截 + stopPropagation，
  // 避免浮窗 window 上冒泡阶段的 Esc→隐藏窗口监听同时触发
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  return (
    <>
      <Tooltip content="切换目标语言" wrapperClassName="shrink-0">
        <button
          ref={triggerRef}
          onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-app-text-tertiary bg-app-bg-elevated hover:text-app-text-primary transition-colors cursor-pointer"
        >
          译成{value}
          <ChevronDown
            size={9}
            className={`transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </Tooltip>
      {isOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              right: menuPos.right,
              top: menuPos.top,
              WebkitBackdropFilter: 'blur(20px)',
              backdropFilter: 'blur(20px)',
            }}
            className="fixed z-50 w-24 p-1 rounded-xl bg-app-bg-primary/80 border border-app-border shadow-lg animate-in fade-in slide-in-from-top-1 duration-150"
          >
            {TARGET_LANG_OPTIONS.map((lang) => {
              const selected = lang === value;
              return (
                <button
                  key={lang}
                  onClick={() => {
                    onChange(lang);
                    setIsOpen(false);
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs rounded-lg transition-colors duration-150 cursor-pointer ${
                    selected
                      ? 'text-app-brand-primary-light bg-white/5'
                      : 'text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-hover'
                  }`}
                >
                  {lang}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
