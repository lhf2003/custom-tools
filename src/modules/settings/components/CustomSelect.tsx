import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  /** 分组标题（如提供商名）；为空则选项直出不带分组头 */
  label?: string;
  options: SelectOption[];
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
  /** 平铺选项（与 groups 二选一；options 优先） */
  options?: SelectOption[];
  /** 分组选项（如模型按提供商分组） */
  groups?: SelectGroup[];
  /** 选项超过 8 个自动开启搜索（如百炼等模型大户），可显式覆盖 */
  searchable?: boolean;
  /** 下拉菜单附加类名，默认与触发按钮同宽（w-full） */
  menuClassName?: string;
}

/**
 * 设置页通用下拉框：键盘全可达（↑↓/Enter/Esc）、选项多时自动带搜索、
 * 空间不足自动上翻。菜单 portal 到 body + fixed 定位，祖先 overflow 不会裁剪。
 * 交互色用 Action Blue（DESIGN.md 操作色），选中态文字用 Indigo Light。
 */
export function CustomSelect({
  value,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  icon,
  options,
  groups,
  searchable,
  menuClassName = 'w-full',
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState<'top' | 'bottom'>('bottom');
  // 菜单 portal 到 body + fixed 定位（逃逸祖先 overflow 裁剪），几何全部用视口坐标
  const [menuBox, setMenuBox] = useState<{
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    width?: number;
    maxHeight: number;
  }>({ maxHeight: 192 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // 统一成分组结构，渲染与键盘导航共用一份扁平淡出索引
  const normalizedGroups: SelectGroup[] =
    options !== undefined ? [{ options }] : (groups ?? []);
  const allOptions = normalizedGroups.flatMap((g) => g.options);
  const totalCount = allOptions.length;
  const isSearchable = searchable ?? totalCount > 8;
  const query = searchQuery.trim().toLowerCase();

  const matches = (opt: SelectOption) =>
    !query ||
    opt.label.toLowerCase().includes(query) ||
    opt.value.toLowerCase().includes(query);
  const filteredGroups: SelectGroup[] = normalizedGroups
    .map((g) => ({ ...g, options: g.options.filter(matches) }))
    .filter((g) => g.options.length > 0);
  const filteredOptions = filteredGroups.flatMap((g) => g.options);

  const selectedOption = allOptions.find((opt) => opt.value === value);

  // 打开时初始化：清空搜索、高亮当前选中项。放在打开动作里而不是 effect 里——
  // options 每次渲染都是新数组引用，依赖它的 effect 会反复把高亮重置回选中项
  const openSelect = () => {
    setSearchQuery('');
    const selectedIndex = filteredOptions.findIndex((opt) => opt.value === value);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  // 打开后聚焦搜索框（键盘优先：展开即可输入）
  useEffect(() => {
    if (isOpen && isSearchable) searchInputRef.current?.focus();
  }, [isOpen, isSearchable]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      // 菜单 portal 在 body 下、不在 containerRef 内，需单独判定
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 输入搜索词后，高亮回到第一个匹配项
  useEffect(() => {
    if (query) setHighlightedIndex(0);
  }, [query]);

  // 键盘导航时保证高亮项滚入可视区
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-option-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, isOpen]);

  // fixed 定位的几何计算：上翻/下翻、水平对齐、可用高度收缩。
  // menuClassName 的两类宽度意图：默认 w-full = 与触发器同宽（fixed 下换算成内联像素）；
  // right-0 = 菜单右缘对齐触发器右缘（fixed 下换算成视口 right 偏移）
  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const itemHeight = 36; // Estimated height per option
    const padding = 8; // py-1 = 4px * 2
    const estimatedHeight = Math.min(totalCount * itemHeight + padding, 192);
    const gap = 4; // 原 mt-1 / mb-1

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const horizontal = menuClassName.includes('right-0')
      ? { right: window.innerWidth - rect.right }
      : { left: rect.left };
    const width = menuClassName === 'w-full' ? rect.width : undefined;

    // If space below is insufficient and space above is sufficient, expand upward
    if (spaceBelow < estimatedHeight && spaceAbove > estimatedHeight) {
      setDropdownPosition('top');
      setMenuBox({
        ...horizontal,
        width,
        bottom: window.innerHeight - rect.top + gap,
        maxHeight: Math.min(spaceAbove - 16, 192),
      });
    } else {
      setDropdownPosition('bottom');
      setMenuBox({
        ...horizontal,
        width,
        top: rect.bottom + gap,
        maxHeight: Math.min(spaceBelow - 16, 192),
      });
    }
  }, [totalCount, menuClassName]);

  // Calculate dropdown position based on available space
  useEffect(() => {
    if (isOpen) updateMenuPosition();
  }, [isOpen, updateMenuPosition]);

  // 滚动/缩放时跟随触发器重新定位（设置页在内部容器滚动，需 capture 阶段才能捕获）
  useEffect(() => {
    if (!isOpen) return;
    let raf = 0;
    const handler = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateMenuPosition);
    };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [isOpen, updateMenuPosition]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    // 焦点在搜索框时：字母/空格留给输入框，这里只处理导航与确认键
    const typingInSearch = e.target instanceof HTMLInputElement;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          triggerRef.current?.focus();
        } else if (!typingInSearch) {
          if (isOpen) setIsOpen(false);
          else openSelect();
        }
        break;
      case ' ':
        if (typingInSearch) break;
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          onChange(filteredOptions[highlightedIndex].value);
          setIsOpen(false);
          triggerRef.current?.focus();
        } else {
          if (isOpen) setIsOpen(false);
          else openSelect();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        if (typingInSearch) triggerRef.current?.focus();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          openSelect();
        } else {
          setHighlightedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev
          );
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          openSelect();
        } else {
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        }
        break;
    }
  };

  // 渲染分组：分组头 + 选项，选项索引沿用全局扁平淡出序号
  let optionIndex = -1;
  const renderOption = (option: SelectOption) => {
    optionIndex += 1;
    const index = optionIndex;
    const isSelected = value === option.value;
    const isHighlighted = highlightedIndex === index && !option.disabled;
    return (
      <button
        key={option.value}
        type="button"
        id={`${listboxId}-opt-${index}`}
        role="option"
        aria-selected={isSelected}
        data-option-index={index}
        onClick={() => {
          onChange(option.value);
          setIsOpen(false);
        }}
        disabled={option.disabled}
        onMouseEnter={() => setHighlightedIndex(index)}
        // 入场 stagger：前 7 项依次延迟 18ms，总时长控制在设计词表 300ms 内；
        // 仅打开时挂载动画类——关闭走菜单整体的淡出，选项不各自重播
        style={{ animationDelay: `${Math.min(index, 6) * 18}ms` }}
        className={`
          w-full px-3 py-2 text-left text-sm rounded-lg transition-colors duration-150 ease-out
          ${isOpen ? 'animate-option-in motion-reduce:animate-none' : ''}
          ${option.disabled
            ? 'text-app-text-disabled cursor-not-allowed'
            : isSelected
              ? 'text-app-brand-primary-light hover:bg-app-bg-hover cursor-pointer'
              : 'text-app-text-secondary hover:text-app-text-primary hover:bg-app-bg-hover cursor-pointer'
          }
          ${isSelected ? 'bg-white/5' : ''}
          ${isHighlighted ? 'bg-app-bg-hover' : ''}
        `}
      >
        <span className="flex items-center gap-2">
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            {isSelected && <Check size={14} className="text-app-brand-primary-light" />}
          </span>
          <span className="truncate">{option.label}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      aria-activedescendant={
        isOpen && highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined
      }
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onClick={() => {
          if (disabled) return;
          if (isOpen) setIsOpen(false);
          else openSelect();
        }}
        disabled={disabled}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm
          border transition-all duration-200 ease-out
          ${disabled
            ? 'bg-app-bg-tertiary/50 border-app-border-subtle text-app-text-disabled cursor-not-allowed'
            : 'bg-app-bg-tertiary border-app-border text-app-text-primary hover:border-app-border-emphasis hover:bg-white/5 cursor-pointer active:scale-[0.98]'
          }
          ${isOpen ? 'border-app-border-emphasis' : ''}
        `}
      >
        {icon && <span className="text-app-text-tertiary">{icon}</span>}
        <span className={`flex-1 text-left truncate ${!selectedOption ? 'text-app-text-placeholder' : ''}`}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`text-app-text-tertiary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown Menu：portal 到 body，逃逸祖先 overflow 裁剪（如统计页卡片 overflow-hidden） */}
      {createPortal(
        <div
          ref={menuRef}
          // --option-enter-offset 传给选项入场动画：菜单向上翻时选项从下方浮入，保持物理方向感
          style={{
            ...menuBox,
            '--option-enter-offset': dropdownPosition === 'top' ? '-4px' : '4px',
            WebkitBackdropFilter: 'blur(20px)',
            backdropFilter: 'blur(20px)',
          } as React.CSSProperties}
          className={`
            fixed z-50 py-1 rounded-xl overflow-hidden
            bg-app-bg-primary/80
            border border-app-border shadow-2xl
            transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none
            ${menuClassName}
            ${dropdownPosition === 'top' ? 'origin-bottom' : 'origin-top'}
            ${isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 pointer-events-none invisible'}
            ${dropdownPosition === 'top' && !isOpen ? 'translate-y-2' : ''}
            ${dropdownPosition === 'bottom' && !isOpen ? '-translate-y-2' : ''}
          `}
        >
          {isOpen && isSearchable && (
            <div className="px-2 pb-1.5 mb-1 border-b border-white/10 animate-option-in motion-reduce:animate-none">
              <div className="flex items-center gap-1.5 px-1 py-0.5">
                <Search size={14} className="text-app-text-tertiary flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="输入以筛选…"
                  className="flex-1 min-w-0 bg-transparent text-app-text-primary text-sm px-1 py-0.5 outline-none placeholder:text-app-text-placeholder"
                />
                {query && (
                  <button
                    onClick={() => setSearchQuery('')}
                    tabIndex={-1}
                    className="text-app-text-tertiary hover:text-app-text-primary transition-colors flex-shrink-0 cursor-pointer"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          )}
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            style={{ maxHeight: menuBox.maxHeight }}
            className="overflow-y-auto overscroll-contain px-1.5 scrollbar-thin scrollbar-thumb-zinc-600 scrollbar-track-transparent"
          >
            {filteredOptions.length === 0 ? (
              <div className={`px-3 py-2 text-app-text-placeholder text-sm text-center ${isOpen ? 'animate-option-in motion-reduce:animate-none' : ''}`}>
                {query ? '无匹配结果' : '暂无选项'}
              </div>
            ) : (
              filteredGroups.map((group, gi) => {
                // 分组头与其后第一个选项同一拍入场（此处 optionIndex 还是上一组最后一项）
                const headerDelay = Math.min(optionIndex + 1, 6) * 18;
                return (
                  <div key={group.label ?? gi} role={group.label ? 'group' : undefined} aria-label={group.label}>
                    {group.label && (
                      <div
                        className={`px-3 pt-1.5 pb-0.5 text-xs text-app-text-tertiary ${isOpen ? 'animate-option-in motion-reduce:animate-none' : ''}`}
                        style={{ animationDelay: `${headerDelay}ms` }}
                      >
                        {group.label}
                      </div>
                    )}
                    {group.options.map(renderOption)}
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
